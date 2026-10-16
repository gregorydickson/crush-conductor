import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { probeProcess, runCommand } from "./proc.mjs";

const MAX_JOBS = 100;
const QUEUED_ZOMBIE_MS = 120000;

export function dataRoot() {
  return process.env.CONDUCTOR_DATA_DIR || path.join(os.homedir(), ".local", "share", "crush-conductor");
}

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
export function isTerminal(job) { return TERMINAL_STATES.has(job?.status); }

// Job records hold prompts, results and session ids: operator-private.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE }); }

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function assertJobId(id, what = "job id") {
  if (typeof id !== "string" || !JOB_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(String(id).slice(0, 80))}`);
  }
}

export function jobDir(id) { assertJobId(id); return path.join(dataRoot(), "jobs", id); }
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
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

/**
 * Tiny mkdir lock. A live owner is never stolen from: past the deadline the
 * owner pid is probed and only a dead owner's lock is taken. Callers stay
 * short-lived (single small read-modify-write).
 */
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
      if (Date.now() > deadline) {
        const owner = readLockOwner(lockDir);
        if (owner != null && probeProcess(owner).alive) {
          throw new Error(`Lock ${key} is busy (live owner pid ${owner}).`);
        }
        fs.rmSync(lockDir, { recursive: true, force: true });
      } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function readLockOwner(lockDir) {
  try {
    const pid = Number(fs.readFileSync(path.join(lockDir, "owner"), "utf8").split(" ")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
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

/**
 * Patch a job under its lock. By default a terminal job is immutable: the
 * patch is refused and the current record returned, so no late writer can
 * clobber a settled state. `ignoreTerminal` is reserved for the cancel
 * fallback, which may only run after the supervisor is verified dead.
 */
export function updateJob(id, patch, { ignoreTerminal = false } = {}) {
  return withLock(`job-${id}`, () => {
    const job = { ...readJob(id), ...patch };
    if (!ignoreTerminal && patch.status !== undefined) {
      const fresh = readJob(id);
      if (isTerminal(fresh)) return fresh;
    }
    atomicWriteJson(jobPath(id), job);
    return job;
  });
}

export function appendStream(id, event) {
  try {
    fs.appendFileSync(streamPath(id), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { encoding: "utf8", mode: FILE_MODE });
  } catch { /* best-effort trail */ }
}

export function listJobs({ harness } = {}) {
  const root = path.join(dataRoot(), "jobs");
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return []; }
  const jobs = [];
  for (const id of entries) {
    if (!JOB_ID_PATTERN.test(id) || id.includes("..")) continue;
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
  if (id) {
    assertJobId(id, "job id or name");
    if (fs.existsSync(jobPath(id))) return id;
    const byName = listJobs({ harness }).find(job => job.name === id);
    if (byName) return byName.jobId;
    return id; // let the caller's readJob produce the not-found error
  }
  const latest = latestJobId(harness);
  if (!latest) throw new Error(`No ${harness ?? ""} jobs recorded yet.`.trim());
  return latest;
}

export function requestCancel(id) {
  ensureDir(jobDir(id));
  fs.writeFileSync(cancelMarkerPath(id), `${new Date().toISOString()}\n`, { encoding: "utf8", mode: FILE_MODE });
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

/** Best-effort release of a job's worktree lock when a non-supervisor path fails the job. */
function releaseStaleLock(job) {
  if (!job.unlockCmd) return [];
  const result = runCommand("/bin/sh", ["-c", job.unlockCmd], { cwd: job.cwd });
  if (result.status !== 0) return [{ message: `Stale-job unlock command failed (${result.status}): ${(result.stderr || result.stdout).slice(0, 300)}` }];
  return [];
}

/**
 * A job left running whose supervisor died — or queued past any sane start
 * window — is failed, not stuck forever. An unresolvable probe never fails a
 * live job, and a terminal record is never clobbered.
 */
export function recoverIfStale(job) {
  if (!job || isTerminal(job)) return job;
  if (!job.pid) {
    const age = Date.now() - Date.parse(job.createdAt ?? 0);
    if (!(age > QUEUED_ZOMBIE_MS)) return job;
    return withLock(`job-${job.jobId}`, () => {
      const fresh = readJob(job.jobId);
      if (isTerminal(fresh) || fresh.pid) return fresh;
      const failed = { ...fresh, status: "failed", endedAt: new Date().toISOString(), error: { message: "Supervisor never started (job stayed queued past the start window)." } };
      atomicWriteJson(jobPath(job.jobId), failed);
      return failed;
    });
  }
  const probe = probeProcess(job.pid);
  if (!probe.known) return job;
  const dead = !probe.alive || (job.pidIdentity != null && probe.identity != null && job.pidIdentity !== probe.identity);
  if (!dead) return job;
  // The probe can straddle the supervisor's terminal write: re-check under
  // the same lock updateJob uses so a completed job is never clobbered.
  return withLock(`job-${job.jobId}`, () => {
    const fresh = readJob(job.jobId);
    if (isTerminal(fresh)) return fresh;
    const unlockWarnings = releaseStaleLock(fresh);
    const failed = { ...fresh, status: "failed", endedAt: new Date().toISOString(), error: { message: `Supervisor process ${job.pid} exited without reporting a terminal state.` }, warnings: [...(fresh.warnings ?? []), ...unlockWarnings] };
    atomicWriteJson(jobPath(job.jobId), failed);
    return failed;
  });
}

export function envelope(job) {
  const { prompt, resumeOf, ...rest } = job;
  return {
    ...rest,
    resumedFrom: resumeOf ?? null,
    promptPreview: typeof prompt === "string" ? prompt.slice(0, 200) : null,
  };
}
