import fs from "node:fs";
import { getAdapter } from "./adapters/registry.mjs";
import { processIdentity, runCommand } from "./proc.mjs";
import { appendStream, cancelRequested, pruneJobs, readJob, setLastSession, updateJob } from "./jobs.mjs";

function nowIso() { return new Date().toISOString(); }

/**
 * Runs one job to a terminal state and records the envelope. Used both
 * inline (foreground `task`) and from the detached `__supervise` process,
 * so job state always survives on disk even if Crush restarts.
 */
export async function superviseJob(jobId) {
  let job = readJob(jobId);
  if (job.status !== "queued") {
    // A terminal or already-running job is never re-supervised: re-running
    // would double-spend tokens, re-lock the worktree and rewrite history.
    process.stderr.write(`Refusing to supervise ${jobId}: status is ${job.status}, not queued.\n`);
    return job;
  }
  const adapter = getAdapter(job.harness);
  let cancelledFlag = false;
  const onSignal = () => { cancelledFlag = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    job = updateJob(jobId, {
      status: "running",
      pid: process.pid,
      pidIdentity: processIdentity(process.pid),
      startedAt: nowIso(),
    });
    if (job.status !== "running") {
      // The start patch was refused (job settled while this supervisor was
      // booting): never spend a turn on a job that is no longer ours.
      process.stderr.write(`Refusing to supervise ${jobId}: state moved to ${job.status} before start.\n`);
      return job;
    }

    const availability = adapter.availability();
    if (!availability.available) {
      return failJob(jobId, `${adapter.label} binary is not available: ${availability.detail ?? "not on PATH"}`);
    }

    const prompt = job.prompt ?? (job.briefFile ? fs.readFileSync(job.briefFile, "utf8") : null);
    if (!prompt?.trim()) return failJob(jobId, "No prompt supplied to the job.");

    let resumeSessionId = job.resumeSessionId ?? null;
    if (!resumeSessionId && job.resumeOf) {
      const prior = readJob(job.resumeOf);
      resumeSessionId = prior.sessionId;
      if (!resumeSessionId) return failJob(jobId, `Cannot resume ${job.resumeOf}: it recorded no session ID.`);
    }

    if (job.lockCmd) {
      const locked = runCommand("/bin/sh", ["-c", job.lockCmd], { cwd: job.cwd });
      if (locked.status !== 0) {
        return failJob(jobId, `Lock command failed (${locked.status}): ${(locked.stderr || locked.stdout).slice(0, 300)}`);
      }
      appendStream(jobId, { type: "locked", command: job.lockCmd });
    }

    appendStream(jobId, { type: "started", harness: job.harness, cwd: job.cwd });

    const turn = await adapter.runTurn({
      cwd: job.cwd,
      prompt,
      instructionsFile: job.instructionsFile,
      schema: job.outputSchema,
      model: job.model,
      effort: job.effort,
      write: job.write,
      fullAuto: job.fullAuto,
      budgetUsd: job.budgetUsd,
      profile: job.profile,
      noUserConfig: job.noUserConfig,
      resumeSessionId,
      timeoutMs: (job.timeoutSec ?? 3600) * 1000,
      env: process.env,
      onProgress: message => appendStream(jobId, { type: "progress", message: String(message).slice(0, 8000) }),
      onChild: ({ pid }) => updateJob(jobId, { childPid: pid, childPidIdentity: processIdentity(pid) }),
      cancelled: () => cancelledFlag || cancelRequested(jobId),
    });

    // Thread-continuity guard: a resume that mints a NEW session id did not
    // continue the requested thread — the harness silently started fresh
    // (verified live: codex exec resume with an unknown id). That must fail
    // honestly through the normal terminal path: no impostor thread in the
    // record, no session-index write, lock released.
    if (resumeSessionId && turn.sessionId && turn.sessionId !== resumeSessionId && !turn.error && (turn.exitCode ?? 1) === 0) {
      turn.error = { message: `Harness started a fresh thread (${turn.sessionId}) instead of continuing ${resumeSessionId}; the requested thread was not resumed. Treat the takeover as failed and re-check the session id at its source.` };
      turn.exitCode = 1;
    }

    const exitCode = turn.exitCode ?? 1;
    const cancelled = cancelledFlag || cancelRequested(jobId);
    const failed = cancelled || exitCode !== 0 || turn.error != null;
    const endedAt = nowIso();

    // Release the lock BEFORE the terminal write: a terminal job must never be
    // visible while its worktree is still locked (same TOCTOU class as the
    // session index below).
    const unlockWarning = releaseLock(job);
    // Session index first: a terminal job.json must never be visible before
    // its session is resumable (an immediate `task --resume` would TOCTOU).
    if (turn.sessionId && !failed) setLastSession(job.harness, { jobId, sessionId: turn.sessionId });
    job = updateJob(jobId, {
      status: cancelled ? "cancelled" : failed ? "failed" : "completed",
      exitCode,
      endedAt,
      durationMs: Date.now() - Date.parse(job.startedAt ?? job.createdAt),
      result: turn.finalMessage ?? "",
      sessionId: turn.sessionId ?? job.sessionId ?? null,
      parsed: turn.parsed ?? null,
      schemaValid: turn.schemaValid ?? null,
      usage: turn.usage ?? null,
      error: cancelled ? { kind: "cancelled", message: "Job cancelled before completion." } : turn.error ?? null,
      warnings: [...(turn.warnings ?? []), ...unlockWarning],
    });

    appendStream(jobId, { type: "terminal", status: job.status });
  } catch (error) {
    const unlockWarning = job?.unlockCmd ? releaseLock(job) : [];
    job = failJob(jobId, [error.message, ...unlockWarning.map(w => w.message)].join(" "));
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  pruneJobs();
  return job;
}

export function releaseLock(job) {
  if (!job?.unlockCmd) return [];
  const unlocked = runCommand("/bin/sh", ["-c", job.unlockCmd], { cwd: job.cwd });
  if (unlocked.status !== 0) {
    return [{ message: `Unlock command failed (${unlocked.status}): ${(unlocked.stderr || unlocked.stdout).slice(0, 300)}` }];
  }
  appendStream(job.jobId, { type: "unlocked", command: job.unlockCmd });
  return [];
}

function failJob(jobId, message) {
  const job = updateJob(jobId, {
    status: "failed",
    endedAt: nowIso(),
    error: { message },
  });
  appendStream(jobId, { type: "terminal", status: "failed", message });
  return job;
}
