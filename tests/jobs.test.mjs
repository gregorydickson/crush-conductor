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
  jobs.createJob({ jobId: "claude-z1", harness: "claude", prompt: "a", createdAt: "2026-01-01T00:00:01Z" });
  jobs.createJob({ jobId: "claude-z2", harness: "claude", prompt: "b", createdAt: "2026-01-02T00:00:01Z" });
  assert.equal(jobs.latestJobId("claude"), "claude-z2");
  assert.equal(jobs.latestJobId("droid") != null, true);
  assert.equal(jobs.resolveJobId(null, "claude"), "claude-z2");
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

test("prune keeps a bounded number of terminal jobs", () => {
  for (let i = 0; i < 8; i++) {
    const job = jobs.createJob({ jobId: `claude-p${i}`, harness: "claude", prompt: "x", createdAt: new Date(2026, 0, 1, 0, 0, i + 10).toISOString() });
    jobs.updateJob(job.jobId, { status: "completed" });
  }
  const removed = jobs.pruneJobs(4);
  assert.ok(removed >= 4);
  assert.ok(jobs.listJobs({ harness: "claude" }).length <= 4 + 2); // + non-terminal leftovers
});
