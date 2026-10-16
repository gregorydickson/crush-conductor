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

    const availability = adapter.availability();
    if (!availability.available) {
      return failJob(jobId, `${adapter.label} binary is not available: ${availability.detail ?? "not on PATH"}`);
    }

    const prompt = job.prompt ?? (job.briefFile ? fs.readFileSync(job.briefFile, "utf8") : null);
    if (!prompt?.trim()) return failJob(jobId, "No prompt supplied to the job.");

    let resumeSessionId = null;
    if (job.resumeOf) {
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
      onChild: ({ pid }) => updateJob(jobId, { childPid: pid }),
      cancelled: () => cancelledFlag || cancelRequested(jobId),
    });

    const exitCode = turn.exitCode ?? turn.status ?? 1;
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

function releaseLock(job) {
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
