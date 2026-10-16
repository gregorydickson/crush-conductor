#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "../lib/args.mjs";
import { getAdapter, listAdapters } from "../lib/adapters/registry.mjs";
import { superviseJob } from "../lib/supervise.mjs";
import {
  assertJobId, createJob, envelope, dataRoot, getLastSession, isTerminal,
  listJobs, newJobId, readJob, recoverIfStale, requestCancel, resolveJobId, updateJob,
} from "../lib/jobs.mjs";
import { probeProcess, runCommand, terminateProcessTree } from "../lib/proc.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const HARNESS_FLAGS = {
  "task": {
    spec: {
      "--background": { key: "background", type: "bool", aliases: ["-b"] },
      "--write": { key: "write", type: "bool" },
      "--full-auto": { key: "fullAuto", type: "bool" },
      "--resume": { key: "resume", type: "bool" },
      "--resume-job": { key: "resumeJobId", type: "string" },
      "--resume-session": { key: "resumeSession", type: "string" },
      "--fresh": { key: "fresh", type: "bool" },
      "--model": { key: "model", type: "string" },
      "--effort": { key: "effort", type: "string" },
      "--cwd": { key: "cwd", type: "string" },
      "--timeout": { key: "timeoutSec", type: "string" },
      "--brief": { key: "briefFile", type: "string" },
      "--instructions": { key: "instructionsFile", type: "string" },
      "--output-schema": { key: "outputSchemaFile", type: "string" },
      "--budget": { key: "budgetUsd", type: "string" },
      "--name": { key: "name", type: "string" },
      "--lock-cmd": { key: "lockCmd", type: "string" },
      "--unlock-cmd": { key: "unlockCmd", type: "string" },
      "--profile": { key: "profile", type: "string" },
      "--no-user-config": { key: "noUserConfig", type: "bool" },
    },
  },
  "common": {
    spec: {
      "--json": { key: "json", type: "bool" },
      "--wait": { key: "wait", type: "bool" },
      "--timeout": { key: "waitTimeoutSec", type: "string" },
      "--harness": { key: "harness", type: "string" },
    },
  },
};

function usage() {
  const harnesses = listAdapters().map(adapter => adapter.id).join("|");
  return `Usage:
  conductor <${harnesses}> task [--background] [--write|--full-auto] [--resume|--resume-job <id|name>|--resume-session <sid>|--fresh]
                                [--model <m>] [--effort <e>] [--cwd <dir>] [--timeout <secs>]
                                [--brief <file>] [--instructions <file>] [--output-schema <file>]
                                [--budget <usd>] [--name <name>] [--lock-cmd <cmd>] [--unlock-cmd <cmd>]
                                [--profile <p>] [--no-user-config] [--json] [prompt]
  conductor <${harnesses}> status [job-id-or-name] [--wait] [--timeout <secs>] [--json]
  conductor <${harnesses}> result [job-id-or-name] [--json]
  conductor <${harnesses}> cancel [job-id-or-name] [--json]
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

function numericFlag(value, option, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= min) {
    throw new Error(`Option ${option} requires a number greater than ${min} (got ${JSON.stringify(String(value))}).`);
  }
  return parsed;
}

function existingFile(flagValue, option) {
  const resolved = path.resolve(flagValue);
  if (!fs.existsSync(resolved)) throw new Error(`${option} file not found: ${flagValue}`);
  return resolved;
}

async function cmdTask(harness, flags, positional) {
  const adapter = getAdapter(harness);
  const promptText = flags.briefFile ? null : positional.join(" ").trim() || null;
  if (!promptText && !flags.briefFile) throw new Error("Provide a prompt or --brief <file>.");
  // Resolve every caller-supplied path against the CLI's cwd before it is
  // stored: the detached supervisor and the harness child run at --cwd.
  const briefFile = flags.briefFile ? existingFile(flags.briefFile, "--brief") : null;
  const instructionsFile = flags.instructionsFile ? existingFile(flags.instructionsFile, "--instructions") : null;
  const outputSchemaFile = flags.outputSchemaFile ? existingFile(flags.outputSchemaFile, "--output-schema") : null;
  const outputSchema = outputSchemaFile ? readJsonFile(outputSchemaFile, "output schema") : null;
  if (flags.name) assertJobId(flags.name, "--name value");
  if (flags.fresh && (flags.resume || flags.resumeJobId || flags.resumeSession)) {
    throw new Error("--fresh conflicts with --resume/--resume-job/--resume-session: pick one.");
  }
  const resumeFlags = [flags.resume, flags.resumeJobId, flags.resumeSession].filter(Boolean).length;
  if (resumeFlags > 1) {
    throw new Error("--resume, --resume-job and --resume-session are mutually exclusive.");
  }
  if (flags.resumeSession != null && !/^\S+$/.test(flags.resumeSession)) {
    throw new Error("--resume-session requires a session/thread id with no whitespace.");
  }
  const timeoutSec = flags.timeoutSec ? numericFlag(flags.timeoutSec, "--timeout") : 3600;
  const budgetUsd = flags.budgetUsd ? numericFlag(flags.budgetUsd, "--budget") : null;
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`--cwd is not an existing directory: ${flags.cwd}`);
  }

  let resumeOf = null;
  if (flags.resumeSession) {
    // Mid-flight takeover: continue a harness thread launched by any tool
    // (companion CLI, claude --bg, another operator session). The id is not
    // validated against a conductor record — the harness itself rejects an
    // unknown thread and the failure surfaces in the job envelope.
  } else if (flags.resumeJobId) {
    const prior = readJob(resolveJobId(flags.resumeJobId, harness));
    if (prior.harness !== harness) throw new Error(`Cannot resume ${flags.resumeJobId}: it is a ${prior.harness} job, not ${harness}.`);
    if (!prior.sessionId) throw new Error(`Cannot resume ${prior.jobId}: it recorded no session ID.`);
    resumeOf = prior.jobId;
  } else if (flags.resume) {
    const last = getLastSession(harness) ?? listJobs({ harness }).find(job => job.status === "completed" && job.sessionId);
    if (!last) throw new Error(`No resumable ${harness} session on record. Start fresh (omit --resume).`);
    resumeOf = last.jobId;
  }

  const availability = adapter.availability();
  if (!availability.available) {
    throw new Error(`${adapter.label} binary is not available (${availability.detail ?? "not on PATH"}). Run: conductor ${harness} doctor`);
  }
  if ((flags.profile || flags.noUserConfig) && harness !== "codex") {
    throw new Error(`--profile and --no-user-config are codex-only (got ${harness}).`);
  }

  const job = createJob({
    jobId: newJobId(harness),
    harness,
    prompt: promptText,
    briefFile,
    instructionsFile,
    outputSchema,
    model: flags.model ?? null,
    effort: flags.effort ?? null,
    write: Boolean(flags.write),
    fullAuto: Boolean(flags.fullAuto),
    budgetUsd,
    name: flags.name ?? null,
    lockCmd: flags.lockCmd ?? null,
    unlockCmd: flags.unlockCmd ?? null,
    profile: flags.profile ?? null,
    noUserConfig: Boolean(flags.noUserConfig),
    cwd,
    timeoutSec,
    resumeOf,
    resumeSession: flags.resumeSession ?? null,
  });

  if (flags.background) {
    const child = spawn(process.execPath, [SCRIPT, "__supervise", job.jobId], {
      detached: true, stdio: "ignore", cwd: job.cwd,
    });
    child.on("error", error => {
      updateJob(job.jobId, { status: "failed", endedAt: new Date().toISOString(), error: { message: `Supervisor failed to start: ${error.message}` } });
    });
    child.unref();
    await waitFor(() => readJob(job.jobId).status !== "queued", 5000);
    const current = readJob(job.jobId);
    emit(envelope(current), flags.json);
    return { job: current, launched: true };
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
  const waitSecs = flags.waitTimeoutSec ? numericFlag(flags.waitTimeoutSec, "--timeout") : 600;
  const deadline = Date.now() + waitSecs * 1000;
  for (;;) {
    const job = currentJob(id, harness);
    if (isTerminal(job) || !flags.wait || Date.now() >= deadline) {
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

/**
 * Cooperative first, forced only against a verified-dead supervisor. Every
 * signal and kill compares the recorded birth-time identity, so a recycled
 * pid is never signalled; the forced write releases the worktree lock and is
 * the one writer allowed to settle an already-terminal record.
 */
async function cmdCancel(harness, id, flags) {
  const jobId = resolveJobId(id, harness);
  let job = recoverIfStale(readJob(jobId));
  if (isTerminal(job)) {
    emit(envelope(job), flags.json);
    return job;
  }
  requestCancel(jobId);
  const probe = job.pid ? probeProcess(job.pid) : { known: false, alive: false };
  const supervisorLive = probe.alive && (job.pidIdentity == null || probe.identity === job.pidIdentity);
  const supervisorVerifiedDead = probe.known && (!probe.alive || (job.pidIdentity != null && probe.identity !== job.pidIdentity));
  if (supervisorLive) {
    try { process.kill(job.pid, "SIGTERM"); } catch { /* supervisor gone */ }
    const settled = await waitFor(() => isTerminal(readJob(jobId)), 15000, 250);
    if (settled) {
      job = readJob(jobId);
      emit(envelope(job), flags.json);
      return job;
    }
  } else if (!supervisorVerifiedDead) {
    // Probe unknown (transient ps failure): wait out the settle window rather
    // than acting on an unresolvable process state.
    const settled = await waitFor(() => isTerminal(readJob(jobId)), 15000, 250);
    if (settled) {
      job = readJob(jobId);
      emit(envelope(job), flags.json);
      return job;
    }
  }
  // Everything below may only run against a FRESH snapshot whose supervisor
  // is verified dead right now — never against pids read before the waits.
  job = recoverIfStale(readJob(jobId));
  if (isTerminal(job)) {
    emit(envelope(job), flags.json);
    return job;
  }
  const freshProbe = job.pid ? probeProcess(job.pid) : { known: false, alive: false };
  const stillLive = freshProbe.alive && (job.pidIdentity == null || freshProbe.identity === job.pidIdentity);
  if (stillLive || !freshProbe.known) {
    console.error(`conductor: supervisor of ${jobId} is not verifiably dead; cancel marker left in place, not forcing.`);
    process.exitCode = 1;
    emit(envelope(job), flags.json);
    return job;
  }
  terminateProcessTree(job.childPid, { identity: job.childPidIdentity ?? null });
  terminateProcessTree(job.pid, { identity: job.pidIdentity ?? null });
  let unlockWarnings = [];
  if (job.unlockCmd) {
    const unlocked = runCommand("/bin/sh", ["-c", job.unlockCmd], { cwd: job.cwd });
    if (unlocked.status !== 0) unlockWarnings = [{ message: `Unlock command failed (${unlocked.status}): ${(unlocked.stderr || unlocked.stdout).slice(0, 300)}` }];
  }
  job = updateJob(jobId, {
    status: "cancelled",
    endedAt: new Date().toISOString(),
    error: { kind: "cancelled", message: "Cancelled; supervisor did not settle in time." },
    warnings: [...(job.warnings ?? []), ...unlockWarnings],
  }, { ignoreTerminal: true });
  emit(envelope(job), flags.json);
  return job;
}

async function cmdDoctor(harness, flags) {
  const adapter = getAdapter(harness);
  const availability = adapter.availability();
  const active = listJobs({ harness })
    .map(job => recoverIfStale(job))
    .filter(job => job.status === "running" || job.status === "queued");
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
  const indexed = getLastSession(harness);
  const fallback = indexed ? null : listJobs({ harness }).find(job => job.status === "completed" && job.sessionId);
  const last = indexed
    ? { jobId: indexed.jobId, sessionId: indexed.sessionId }
    : fallback ? { jobId: fallback.jobId, sessionId: fallback.sessionId } : null;
  emit({ harness, available: Boolean(last), jobId: last?.jobId ?? null, sessionId: last?.sessionId ?? null }, flags.json);
}

function cmdList(flags) {
  const jobs = listJobs({ harness: flags.harness }).map(recoverIfStale).map(envelope);
  emit({ count: jobs.length, jobs }, flags.json ?? true);
}

async function main() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.length === 0) { console.error(usage()); process.exitCode = 1; return; }

  if (rawArgv[0] === "__supervise") {
    if (rawArgv.length !== 2) { console.error("__supervise requires exactly one job id"); process.exitCode = 2; return; }
    try {
      await superviseJob(rawArgv[1]);
    } catch (error) {
      console.error(`__supervise: ${error.message}`);
      process.exitCode = 2;
    }
    return;
  }
  if (rawArgv[0] === "list") {
    try {
      const { flags } = parseArgs(rawArgv.slice(1), HARNESS_FLAGS.common.spec);
      cmdList(flags);
    } catch (error) {
      console.error(`conductor: ${error.message}`);
      process.exitCode = 1;
    }
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
      // Launch exit reflects handoff, not outcome — except a job that already
      // failed at handoff (bad spawn, bad cwd) or was cancelled, which is a
      // failed launch. The caller checks outcome separately via status/result.
      process.exitCode = launched
        ? (job.status === "failed" || job.status === "cancelled" ? 1 : (job.status !== "queued" ? 0 : 1))
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
