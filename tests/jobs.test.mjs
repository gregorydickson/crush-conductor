import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONDUCTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-jobs-"));

const jobs = await import("../lib/jobs.mjs");

test("create/read/update roundtrip", () => {
  const job = jobs.createJob({ jobId: jobs.newJobId("droid"), harness: "droid", prompt: "hi" });
  assert.equal(job.status, "queued");
  const updated = jobs.updateJob(job.jobId, { status: "running", pid: process.pid });
  assert.equal(updated.status, "running");
  assert.equal(jobs.readJob(job.jobId).prompt, "hi");
});

test("list filters by harness and resolves latest", () => {
  jobs.createJob({ jobId: "droid-latest-pin", harness: "droid", prompt: "p", createdAt: "2026-01-05T00:00:01Z" });
  jobs.createJob({ jobId: "claude-z1", harness: "claude", prompt: "a", createdAt: "2026-01-01T00:00:01Z" });
  jobs.createJob({ jobId: "claude-z2", harness: "claude", prompt: "b", createdAt: "2026-01-02T00:00:01Z" });
  assert.equal(jobs.resolveJobId(null, "claude"), "claude-z2");
  const droidIds = jobs.listJobs({ harness: "droid" }).map(job => job.jobId);
  assert.ok(droidIds.length >= 1);
  assert.ok(droidIds.every(id => id.startsWith("droid-")), "harness filter returns only droid jobs");
  assert.ok(jobs.latestJobId("droid").startsWith("droid-"));
});

test("cancel marker", () => {
  const job = jobs.createJob({ jobId: "droid-c1", harness: "droid", prompt: "x" });
  assert.equal(jobs.cancelRequested(job.jobId), false);
  jobs.requestCancel(job.jobId);
  assert.equal(jobs.cancelRequested(job.jobId), true);
});

test("last session index per harness", () => {
  jobs.setLastSession("droid", { jobId: "droid-s1", sessionId: "sess-1" });
  assert.deepEqual(jobs.getLastSession("droid"), { jobId: "droid-s1", sessionId: "sess-1", at: jobs.getLastSession("droid").at });
  assert.equal(jobs.getLastSession("claude"), null);
});

test("a running job whose supervisor died is lazily failed", () => {
  const job = jobs.createJob({ jobId: "droid-dead", harness: "droid", prompt: "x" });
  const deadPid = 4000000; // beyond pid_max; identity lookup fails
  jobs.updateJob(job.jobId, { status: "running", pid: deadPid });
  const recovered = jobs.recoverIfStale(jobs.readJob(job.jobId));
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error.message, /Supervisor process/);
});

test("a running job with a live supervisor is left alone", () => {
  const job = jobs.createJob({ jobId: "droid-alive", harness: "droid", prompt: "x" });
  jobs.updateJob(job.jobId, { status: "running", pid: process.pid });
  assert.equal(jobs.recoverIfStale(jobs.readJob(job.jobId)).status, "running");
});

test("jobs resolve by name when no id matches", () => {
  jobs.createJob({ jobId: "claude-n1", harness: "claude", prompt: "a", createdAt: "2026-01-03T00:00:01Z", name: "edu-12-s2" });
  jobs.createJob({ jobId: "claude-n2", harness: "claude", prompt: "b", createdAt: "2026-01-04T00:00:01Z", name: "edu-12-s2" });
  assert.equal(jobs.resolveJobId("edu-12-s2", "claude"), "claude-n2", "latest job with that name wins");
  assert.equal(jobs.resolveJobId("claude-n1", "claude"), "claude-n1", "exact id still wins");
});

test("job ids and names with path characters are rejected", () => {
  assert.throws(() => jobs.jobDir("../../tmp/evil"), /Invalid job id/);
  assert.throws(() => jobs.resolveJobId("../evil", "claude"), /Invalid job id/);
  assert.throws(() => jobs.readJob("a/b"), /Invalid job id/);
});

test("updateJob refuses to clobber a terminal state", () => {
  const job = jobs.createJob({ jobId: "droid-term1", harness: "droid", prompt: "x" });
  const settled = jobs.updateJob(job.jobId, { status: "completed", result: "done" });
  assert.equal(settled.status, "completed");
  const after = jobs.updateJob(job.jobId, { status: "cancelled", error: { message: "late writer" } });
  assert.equal(after.status, "completed", "terminal state is immutable by default");
  assert.equal(after.error, undefined);
  const forced = jobs.updateJob(job.jobId, { status: "cancelled" }, { ignoreTerminal: true });
  assert.equal(forced.status, "cancelled", "ignoreTerminal is the one sanctioned override");
});

test("withLock never steals a live owner's lock", () => {
  const lockDir = `${jobs.dataRoot()}/locks/live-owner-test.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(`${lockDir}/owner`, `${process.pid} ${Date.now()}`);
  try {
    assert.throws(() => jobs.withLock("live-owner-test", () => {}), /busy/);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("a queued job with no pid is reaped only past the start window", () => {
  const fresh = jobs.createJob({ jobId: "droid-qfresh", harness: "droid", prompt: "x" });
  assert.equal(jobs.recoverIfStale(jobs.readJob(fresh.jobId)).status, "queued", "young queued job is left alone");
  const stale = jobs.createJob({ jobId: "droid-qstale", harness: "droid", prompt: "x", createdAt: new Date(Date.now() - 10 * 60000).toISOString() });
  const recovered = jobs.recoverIfStale(jobs.readJob(stale.jobId));
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error.message, /never started/);
});

test("reaping a stale running job releases its worktree lock", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-reaplock-"));
  const unlockLog = path.join(scratch, "unlock.log");
  const unlock = path.join(scratch, "unlock.sh");
  fs.writeFileSync(unlock, `#!/bin/sh\necho unlocked >> ${unlockLog}\n`, { mode: 0o755 });
  const job = jobs.createJob({
    jobId: "droid-reaplock", harness: "droid", prompt: "x",
    cwd: scratch, unlockCmd: unlock,
  });
  jobs.updateJob(job.jobId, { status: "running", pid: 4000000 }); // dead pid: identity lookup fails cleanly
  const recovered = jobs.recoverIfStale(jobs.readJob(job.jobId));
  assert.equal(recovered.status, "failed");
  assert.equal(fs.readFileSync(unlockLog, "utf8"), "unlocked\n", "stale job's lock command ran");
});

test("job state files are written operator-private (0600)", () => {
  const job = jobs.createJob({ jobId: "droid-perm1", harness: "droid", prompt: "secret brief" });
  const mode = fs.statSync(`${jobs.dataRoot()}/jobs/droid-perm1/job.json`).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("prune keeps exactly the N newest terminal jobs across harnesses", () => {
  const nonTerminal = jobs.createJob({ jobId: "droid-live-pin", harness: "droid", prompt: "x" });
  jobs.updateJob(nonTerminal.jobId, { status: "running", pid: process.pid });
  for (let i = 0; i < 8; i++) {
    const job = jobs.createJob({ jobId: `claude-p${i}`, harness: "claude", prompt: "x", createdAt: new Date(2026, 0, 2, 0, 0, i + 10).toISOString() });
    jobs.updateJob(job.jobId, { status: "completed" });
  }
  const terminalBefore = jobs.listJobs().filter(j => ["completed", "failed", "cancelled"].includes(j.status));
  const keep = 4;
  const expectedKept = new Set(terminalBefore.slice(0, keep).map(j => j.jobId));
  const expectedGone = new Set(terminalBefore.slice(keep).map(j => j.jobId));
  jobs.pruneJobs(keep);
  const idsAfter = new Set(jobs.listJobs().map(j => j.jobId));
  for (const id of expectedKept) assert.ok(idsAfter.has(id), `newest terminal job ${id} survives`);
  for (const id of expectedGone) assert.ok(!idsAfter.has(id), `older terminal job ${id} is pruned`);
  assert.ok(idsAfter.has("droid-live-pin"), "a running job is never pruned");
});
