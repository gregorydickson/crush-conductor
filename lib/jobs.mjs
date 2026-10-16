import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { processIdentity } from "./proc.mjs";

const MAX_JOBS = 100;

export function dataRoot() {
  return process.env.CONDUCTOR_DATA_DIR || path.join(os.homedir(), ".local", "share", "crush-conductor");
}

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
export function isTerminal(job) { return TERMINAL_STATES.has(job?.status); }

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

export function jobDir(id) { return path.join(dataRoot(), "jobs", id); }
export function jobPath(id) { return path.join(jobDir(id), "job.json"); }
export function streamPath(id) { return path.join(jobDir(id), "stream.jsonl"); }
export function cancelMarkerPath(id) { return path.join(jobDir(id), "cancel"); }

export function newJobId(harness) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${harness}-${Date.now().toString(36)}-${rand}`;
}

function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** Tiny mkdir lock with deadline steal; keyed per file, callers stay short-lived. */
export function withLock(key, fn) {
  const lockDir = path.join(dataRoot(), "locks", `${key}.lock`);
  ensureDir(path.dirname(lockDir));
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid} ${Date.now()}`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) fs.rmSync(lockDir, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export function createJob(record) {
  const job = { warnings: [], usage: null, ...record, status: "queued", createdAt: record.createdAt ?? new Date().toISOString() };
  ensureDir(jobDir(job.jobId));
  atomicWriteJson(jobPath(job.jobId), job);
  return job;
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), "utf8"));
  } catch (error) {
    throw new Error(`Job ${id} not found (${error.message}).`);
  }
}

export function updateJob(id, patch) {
  return withLock(`job-${id}`, () => {
    const job = { ...readJob(id), ...patch };
    atomicWriteJson(jobPath(id), job);
    return job;
  });
}

export function appendStream(id, event) {
  try {
    fs.appendFileSync(streamPath(id), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch { /* best-effort trail */ }
}

export function listJobs({ harness } = {}) {
  const root = path.join(dataRoot(), "jobs");
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return []; }
  const jobs = [];
  for (const id of entries) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(root, id, "job.json"), "utf8"));
      if (!harness || job.harness === harness) jobs.push(job);
    } catch { /* partial dir */ }
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function latestJobId(harness) {
  return listJobs({ harness })[0]?.jobId ?? null;
}

export function resolveJobId(id, harness) {
  if (id) return id;
  const latest = latestJobId(harness);
  if (!latest) throw new Error(`No ${harness ?? ""} jobs recorded yet.`.trim());
  return latest;
}

export function requestCancel(id) {
  ensureDir(jobDir(id));
  fs.writeFileSync(cancelMarkerPath(id), `${new Date().toISOString()}\n`, "utf8");
}

export function cancelRequested(id) {
  return fs.existsSync(cancelMarkerPath(id));
}

function statePath() { return path.join(dataRoot(), "state.json"); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch { return {}; }
}

export function setLastSession(harness, { jobId, sessionId }) {
  return withLock("state", () => {
    const state = readState();
    state.lastSession = state.lastSession ?? {};
    state.lastSession[harness] = { jobId, sessionId, at: new Date().toISOString() };
    atomicWriteJson(statePath(), state);
    return state.lastSession[harness];
  });
}

export function getLastSession(harness) {
  return readState().lastSession?.[harness] ?? null;
}

export function pruneJobs(keep = MAX_JOBS) {
  const jobs = listJobs();
  const removable = jobs.filter(isTerminal).slice(keep);
  for (const job of removable) fs.rmSync(jobDir(job.jobId), { recursive: true, force: true });
  return removable.length;
}

/** A job left running whose supervisor died is failed, not stuck forever. */
export function recoverIfStale(job) {
  if (!job || isTerminal(job) || !job.pid) return job;
  const identity = processIdentity(job.pid);
  if (identity) return job;
  return updateJob(job.jobId, {
    status: "failed",
    endedAt: new Date().toISOString(),
    error: { message: `Supervisor process ${job.pid} exited without reporting a terminal state.` },
  });
}

export function envelope(job) {
  const { prompt, ...rest } = job;
  return {
    ...rest,
    promptPreview: typeof prompt === "string" ? prompt.slice(0, 200) : null,
  };
}
