import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "conductor.mjs");

function dataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `conductor-cli-${name}-`));
}

function conductor(dataRoot, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      CONDUCTOR_DATA_DIR: dataRoot,
      DROID_BINARY: path.join(ROOT, "tests", "fixtures", "fake-droid.mjs"),
      CLAUDE_BINARY: path.join(ROOT, "tests", "fixtures", "fake-claude.mjs"),
      ...extraEnv,
    },
  });
}

function jsonOut(result) {
  return JSON.parse(result.stdout);
}

async function waitForStatus(dataRoot, harness, jobId, statuses, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = conductor(dataRoot, [harness, "status", jobId, "--json"]);
    const job = jsonOut(result);
    if (statuses.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} stuck at ${job.status}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

test("background task lifecycle through the CLI", async () => {
  const dataRoot = dataDir("lifecycle");
  const launch = conductor(dataRoot, ["droid", "task", "--background", "--json", "quick check"]);
  assert.equal(launch.status, 0, launch.stderr);
  const launched = jsonOut(launch);
  assert.equal(launched.harness, "droid");
  // Fast fakes can finish before the launch envelope is printed; any
  // supervisor-owned state is a successful handoff.
  assert.ok(["queued", "running", "completed"].includes(launched.status), `unexpected launch status ${launched.status}`);

  const done = await waitForStatus(dataRoot, "droid", launched.jobId, ["completed", "failed"]);
  assert.equal(done.status, "completed");
  assert.equal(done.result, "CONDUCTOR_OK");
  assert.equal(done.sessionId, "fake-droid-session");

  const result = conductor(dataRoot, ["droid", "result", launched.jobId, "--json"]);
  assert.equal(result.status, 0);
  assert.equal(jsonOut(result).status, "completed");

  const candidate = jsonOut(conductor(dataRoot, ["droid", "resume-candidate", "--json"]));
  assert.equal(candidate.available, true);
  assert.equal(candidate.sessionId, "fake-droid-session");

  const followUp = conductor(dataRoot, ["droid", "task", "--background", "--json", "--resume", "follow up"]);
  assert.equal(followUp.status, 0, followUp.stderr);
  const resumed = await waitForStatus(dataRoot, "droid", jsonOut(followUp).jobId, ["completed", "failed"]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.resumedFrom, launched.jobId);

  const list = jsonOut(conductor(dataRoot, ["list", "--json"]));
  assert.ok(list.count >= 2);
});

test("cancel settles a hanging background job", async () => {
  const dataRoot = dataDir("cancel");
  const launch = conductor(dataRoot, ["claude", "task", "--background", "--json", "slow thing"], { FAKE_HANG: "1" });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = jsonOut(launch).jobId;

  const running = await waitForStatus(dataRoot, "claude", jobId, ["running"], 10000);
  void running;
  const cancelled = conductor(dataRoot, ["claude", "cancel", jobId, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(jsonOut(cancelled).status, "cancelled");

  const after = jsonOut(conductor(dataRoot, ["claude", "result", jobId, "--json"]));
  assert.equal(after.status, "cancelled");
  assert.equal(after.error.kind, "cancelled");
});

test("doctor reports both harnesses against fakes", () => {
  const dataRoot = dataDir("doctor");
  const droid = conductor(dataRoot, ["droid", "doctor", "--json"]);
  assert.equal(droid.status, 0);
  assert.equal(jsonOut(droid).available, true);
  const claude = conductor(dataRoot, ["claude", "doctor", "--json"]);
  assert.equal(jsonOut(claude).version, "fake-claude 1.0.0");
});

test("unknown harness and missing prompt are errors", () => {
  const dataRoot = dataDir("errors");
  assert.match(conductor(dataRoot, ["grok", "task", "--json", "x"]).stderr, /Unknown harness/);
  assert.match(conductor(dataRoot, ["droid", "task", "--json"]).stderr, /prompt or --brief/);
});
