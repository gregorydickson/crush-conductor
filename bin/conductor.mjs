#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "../lib/args.mjs";
import { getAdapter, listAdapters } from "../lib/adapters/registry.mjs";
import { superviseJob } from "../lib/supervise.mjs";
import {
  createJob, envelope, dataRoot, getLastSession,
  listJobs, newJobId, readJob, recoverIfStale, requestCancel, resolveJobId, updateJob,
} from "../lib/jobs.mjs";
import { pidAlive, processIdentity, terminateProcessTree } from "../lib/proc.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const HARNESS_FLAGS = {
  "task": {
    spec: {
      "--background": { key: "background", type: "bool", aliases: ["-b"] },
      "--wait": { key: "wait", type: "bool" },
      "--write": { key: "write", type: "bool" },
      "--full-auto": { key: "fullAuto", type: "bool" },
      "--resume": { key: "resume", type: "bool" },
      "--resume-job": { key: "resumeJobId", type: "string" },
      "--fresh": { key: "fresh", type: "bool" },
      "--model": { key: "model", type: "string" },
      "--effort": { key: "effort", type: "string" },
      "--cwd": { key: "cwd", type: "string" },
      "--timeout": { key: "timeoutSec", type: "string" },
      "--brief": { key: "briefFile", type: "string" },
      "--instructions": { key: "instructionsFile", type: "string" },
      "--output-schema": { key: "outputSchemaFile", type: "string" },
      "--budget": { key: "budgetUsd", type: "string" },
      "--json": { key: "json", type: "bool" },
    },
  },
  "common": {
    spec: {
      "--json": { key: "json", type: "bool" },
      "--wait": { key: "wait", type: "bool" },
      "--timeout": { key: "waitTimeoutSec", type: "string" },
      "--all": { key: "all", type: "bool" },
      "--harness": { key: "harness", type: "string" },
    },
  },
};

function usage() {
  const harnesses = listAdapters().map(adapter => adapter.id).join("|");
  return `Usage:
  conductor <${harnesses}> task [--background|--wait] [--write|--full-auto] [--resume|--resume-job <id>|--fresh]
                                [--model <m>] [--effort <e>] [--cwd <dir>] [--timeout <secs>]
                                [--brief <file>] [--instructions <file>] [--output-schema <file>]
                                [--budget <usd>] [--json] [prompt]
  conductor <${harnesses}> status [job-id] [--wait] [--timeout <secs>] [--json]
  conductor <${harnesses}> result [job-id] [--json]
  conductor <${harnesses}> cancel [job-id] [--json]
  conductor <${harnesses}> doctor [--json]
  conductor <${harnesses}> resume-candidate [--json]
  conductor list [--harness <id>] [--json]
  conductor __supervise <job-id>   (internal; detached job supervisor)`;
}

function emit(value, json) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  const job = value;
  if (job?.jobId) {
    const head = `${job.jobId}  ${job.harness ?? ""}  ${job.status ?? ""}`;
    const bits = [
      job.result != null && job.result !== "" ? `\n${String(job.result).slice(0, 4000)}` : "",
      job.error?.message ? `\nerror: ${job.error.message}` : "",
      job.sessionId ? `\nsession: ${job.sessionId}` : "",
    ].filter(Boolean).join("");
    console.log(head + bits);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function readJsonFile(file, what) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Cannot read ${what} file ${file}: ${error.message}`); }
}

async function cmdTask(harness, flags, positional) {
  const adapter = getAdapter(harness);
  const promptText = flags.briefFile ? null : positional.join(" ").trim() || null;
  if (!promptText && !flags.briefFile) throw new Error("Provide a prompt or --brief <file>.");
  if (flags.briefFile && !fs.existsSync(flags.briefFile)) throw new Error(`--brief file not found: ${flags.briefFile}`);
  if (flags.instructionsFile && !fs.existsSync(flags.instructionsFile)) throw new Error(`--instructions file not found: ${flags.instructionsFile}`);
  const outputSchema = flags.outputSchemaFile ? readJsonFile(flags.outputSchemaFile, "output schema") : null;

  let resumeOf = null;
  if (flags.resumeJobId) {
    const prior = readJob(flags.resumeJobId);
    if (prior.harness !== harness) throw new Error(`Cannot resume ${flags.resumeJobId}: it is a ${prior.harness} job, not ${harness}.`);
    if (!prior.sessionId) throw new Error(`Cannot resume ${flags.resumeJobId}: it recorded no session ID.`);
    resumeOf = flags.resumeJobId;
  } else if (flags.resume) {
    const last = getLastSession(harness);
    if (!last) throw new Error(`No resumable ${harness} session on record. Start fresh (omit --resume).`);
    resumeOf = last.jobId;
  }

  const availability = adapter.availability();
  if (!availability.available) {
    throw new Error(`${adapter.label} binary is not available (${availability.detail ?? "not on PATH"}). Run: conductor ${harness} doctor`);
  }

  const job = createJob({
    jobId: newJobId(harness),
    harness,
    prompt: promptText,
    briefFile: flags.briefFile ?? null,
    instructionsFile: flags.instructionsFile ?? null,
    outputSchema,
    model: flags.model ?? null,
    effort: flags.effort ?? null,
    write: Boolean(flags.write),
    fullAuto: Boolean(flags.fullAuto),
    budgetUsd: flags.budgetUsd ? Number(flags.budgetUsd) : null,
    cwd: flags.cwd ? path.resolve(flags.cwd) : process.cwd(),
    timeoutSec: flags.timeoutSec ? Number(flags.timeoutSec) : 3600,
    resumeOf,
    resumedFrom: resumeOf,
  });

  if (flags.background) {
    const child = spawn(process.execPath, [SCRIPT, "__supervise", job.jobId], {
      detached: true, stdio: "ignore", cwd: job.cwd,
    });
    child.unref();
    await waitFor(() => readJob(job.jobId).status === "running", 5000);
    emit(envelope(readJob(job.jobId)), flags.json);
    return { job: readJob(job.jobId), launched: true };
  }

  const finalJob = await superviseJob(job.jobId);
  emit(envelope(finalJob), flags.json);
  return { job: finalJob, launched: false };
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function currentJob(idOrMissing, harness) {
  return recoverIfStale(readJob(resolveJobId(idOrMissing, harness)));
}

async function cmdStatus(harness, id, flags) {
  const deadline = Date.now() + (flags.waitTimeoutSec ? Number(flags.waitTimeoutSec) : 600) * 1000;
  for (;;) {
    const job = currentJob(id, harness);
    const terminal = ["completed", "failed", "cancelled"].includes(job.status);
    if (terminal || !flags.wait || Date.now() >= deadline) {
      emit(envelope(job), flags.json);
      return job;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function cmdResult(harness, id, flags) {
  const job = currentJob(id, harness);
  emit(envelope(job), flags.json);
  return job;
}

async function cmdCancel(harness, id, flags) {
  const jobId = resolveJobId(id, harness);
  let job = readJob(jobId);
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    emit(envelope(job), flags.json);
    return job;
  }
  requestCancel(jobId);
  const alive = job.pid && processIdentity(job.pid);
  if (alive) { try { process.kill(job.pid, "SIGTERM"); } catch { /* supervisor gone */ } }
  const settled = await waitFor(() => ["completed", "failed", "cancelled"].includes(readJob(jobId).status), 15000, 250);
  if (!settled) {
    if (job.childPid && pidAlive(job.childPid)) terminateProcessTree(job.childPid);
    if (job.pid && pidAlive(job.pid)) terminateProcessTree(job.pid);
    job = updateJob(jobId, { status: "cancelled", endedAt: new Date().toISOString(), error: { kind: "cancelled", message: "Cancelled; supervisor did not settle in time." } });
  } else {
    job = readJob(jobId);
  }
  emit(envelope(job), flags.json);
  return job;
}

async function cmdDoctor(harness, flags) {
  const adapter = getAdapter(harness);
  const availability = adapter.availability();
  const active = listJobs({ harness }).filter(job => job.status === "running" || job.status === "queued");
  const report = {
    harness,
    label: adapter.label,
    available: availability.available,
    version: availability.version,
    detail: availability.detail,
    dataRoot: dataRoot(),
    activeJobs: active.map(job => ({ jobId: job.jobId, status: job.status })),
  };
  emit(report, flags.json);
  process.exitCode = availability.available ? 0 : 1;
  return report;
}

function cmdResumeCandidate(harness, flags) {
  const last = getLastSession(harness);
  emit({ harness, available: Boolean(last?.sessionId), ...last }, flags.json);
}

function cmdList(flags) {
  const jobs = listJobs({ harness: flags.harness }).map(envelope);
  emit({ count: jobs.length, jobs }, flags.json ?? true);
}

async function main() {
  const [rawArgv] = [process.argv.slice(2)];
  if (rawArgv.length === 0) { console.error(usage()); process.exitCode = 1; return; }

  if (rawArgv[0] === "__supervise") {
    if (rawArgv.length !== 2) { console.error("__supervise requires exactly one job id"); process.exitCode = 2; return; }
    await superviseJob(rawArgv[1]);
    return;
  }
  if (rawArgv[0] === "list") {
    const { flags } = parseArgs(rawArgv.slice(1), HARNESS_FLAGS.common.spec);
    cmdList(flags);
    return;
  }

  const harnessId = rawArgv[0];
  const command = rawArgv[1];
  getAdapter(harnessId);
  const mergedSpec = command === "task"
    ? { ...HARNESS_FLAGS.common.spec, ...HARNESS_FLAGS.task.spec }
    : HARNESS_FLAGS.common.spec;

  try {
    if (command === "task") {
      const { flags, rest } = parseArgs(rawArgv.slice(2), mergedSpec);
      const { job, launched } = await cmdTask(harnessId, flags, rest);
      process.exitCode = launched
        ? (job.status === "running" || job.status === "queued" ? 0 : 1)
        : (job.status === "completed" && job.schemaValid !== false ? 0 : 1);
      return;
    }
    const { flags, rest } = parseArgs(rawArgv.slice(2), mergedSpec);
    const id = rest[0] ?? null;
    if (command === "status") {
      const job = await cmdStatus(harnessId, id, flags);
      process.exitCode = job.status === "completed" ? 0 : 1;
      return;
    }
    if (command === "result") {
      const job = await cmdResult(harnessId, id, flags);
      process.exitCode = job.status === "completed" ? 0 : 1;
      return;
    }
    if (command === "cancel") return void await cmdCancel(harnessId, id, flags);
    if (command === "doctor") return void await cmdDoctor(harnessId, flags);
    if (command === "resume-candidate") return void cmdResumeCandidate(harnessId, flags);
    console.error(`Unknown command "${command}".\n${usage()}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(`conductor: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
