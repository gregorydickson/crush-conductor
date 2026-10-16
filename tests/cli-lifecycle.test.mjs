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
    cwd: dataRoot,
    env: {
      ...process.env,
      CONDUCTOR_DATA_DIR: dataRoot,
      DROID_BINARY: path.join(ROOT, "tests", "fixtures", "fake-droid.mjs"),
      CLAUDE_BINARY: path.join(ROOT, "tests", "fixtures", "fake-claude.mjs"),
      CODEX_BINARY: path.join(ROOT, "tests", "fixtures", "fake-codex.mjs"),
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
  const streamPathLaunched = path.join(dataRoot, "jobs", launched.jobId, "stream.jsonl");
  const stream = fs.readFileSync(streamPathLaunched, "utf8");
  assert.match(stream, /"type":"terminal","status":"completed"/, "progress trail ends with a terminal event");
});

test("codex runs the same background lifecycle", async () => {
  const dataRoot = dataDir("codex");
  const launch = conductor(dataRoot, ["codex", "task", "--background", "--json", "--name", "loa-2-s1", "quick check"]);
  assert.equal(launch.status, 0, launch.stderr);
  const launched = jsonOut(launch);
  const waited = conductor(dataRoot, ["codex", "status", "loa-2-s1", "--wait", "--timeout", "30", "--json"]);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(jsonOut(waited).status, "completed");
  assert.equal(jsonOut(waited).result, "CONDUCTOR_OK");
});

test("numeric flags reject garbage instead of silently going NaN", () => {
  const dataRoot = dataDir("nan");
  assert.match(conductor(dataRoot, ["droid", "task", "--timeout", "90m", "--json", "x"]).stderr, /--timeout requires a number/);
  assert.match(conductor(dataRoot, ["droid", "task", "--budget", "5usd", "--json", "x"]).stderr, /--budget requires a number/);
  assert.match(conductor(dataRoot, ["droid", "status", "--wait", "--timeout", "600s", "--json"]).stderr, /--timeout requires a number/);
});

test("--cwd must exist and --fresh conflicts with --resume", () => {
  const dataRoot = dataDir("cwd");
  assert.match(conductor(dataRoot, ["droid", "task", "--cwd", "/nonexistent/nowhere", "--json", "x"]).stderr, /--cwd is not an existing directory/);
  assert.match(conductor(dataRoot, ["droid", "task", "--fresh", "--resume", "--json", "x"]).stderr, /--fresh conflicts/);
});

test("relative --brief paths resolve at the CLI cwd, not --cwd", async () => {
  const dataRoot = dataDir("brief");
  fs.writeFileSync(path.join(dataRoot, "brief.md"), "the actual brief");
  const launch = conductor(dataRoot, ["droid", "task", "--background", "--json", "--brief", "brief.md"]);
  assert.equal(launch.status, 0, launch.stderr);
  const launched = jsonOut(launch);
  assert.ok(path.isAbsolute(launched.briefFile), "brief path stored absolute");
  assert.equal(fs.readFileSync(launched.briefFile, "utf8"), "the actual brief");
  await waitForStatus(dataRoot, "droid", launched.jobId, ["completed", "failed"]);
  assert.match(conductor(dataRoot, ["droid", "task", "--brief", "missing.md", "--json"]).stderr, /--brief file not found/);
});

test("cross-harness resume is rejected with the harness named", () => {
  const dataRoot = dataDir("xresume");
  const launch = conductor(dataRoot, ["droid", "task", "--background", "--json", "x"]);
  const droidId = jsonOut(launch).jobId;
  const refused = conductor(dataRoot, ["claude", "task", "--json", "--resume-job", droidId, "y"]);
  assert.match(refused.stderr, /it is a droid job, not claude/);
});

test("--resume-session takes over a thread launched by any tool", async () => {
  const dataRoot = dataDir("takeover");
  const launch = conductor(dataRoot, ["codex", "task", "--background", "--json", "--name", "loa-3-s1", "first turn"]);
  const first = await waitForStatus(dataRoot, "codex", jsonOut(launch).jobId, ["completed", "failed"]);
  assert.equal(first.status, "completed");
  assert.equal(first.sessionId, "fake-codex-thread");

  // Simulate a session recorded by ANOTHER tool (companion CLI, claude --bg):
  // only the thread id is known to conductor, no job record exists.
  const takeover = conductor(dataRoot, ["codex", "task", "--background", "--json", "--name", "loa-3-s1",
    "--resume-session", "fake-codex-thread", "follow up"], { FAKE_CODEX_RESUME_SECRET: "1" });
  assert.equal(takeover.status, 0, takeover.stderr);
  const second = await waitForStatus(dataRoot, "codex", jsonOut(takeover).jobId, ["completed", "failed"], 20000);
  assert.equal(second.status, "completed");
  assert.equal(second.sessionId, "fake-codex-thread", "thread continuity preserved");
  assert.equal(second.result, "MANGO", "the child really ran in resume mode");
  assert.equal(second.resumedFrom, null, "no conductor job was resumed — this was an external thread");
  const byName = jsonOut(conductor(dataRoot, ["codex", "result", "loa-3-s1", "--json"]));
  assert.equal(byName.jobId, second.jobId, "the takeover now owns the card-slice name");

  const candidate = jsonOut(conductor(dataRoot, ["codex", "resume-candidate", "--json"]));
  assert.equal(candidate.sessionId, "fake-codex-thread", "takeover updated the session index for later --resume");
});

test("--resume-session conflicts and shape errors", () => {
  const dataRoot = dataDir("takeover-err");
  assert.match(conductor(dataRoot, ["droid", "task", "--json", "--resume-session", "s1", "--resume", "x"]).stderr, /mutually exclusive/);
  assert.match(conductor(dataRoot, ["droid", "task", "--json", "--resume-session", "s1", "--fresh", "x"]).stderr, /--fresh conflicts/);
  assert.match(conductor(dataRoot, ["droid", "task", "--json", "--resume-session", "has space", "x"]).stderr, /no whitespace/);
});

test("cancel force-settles a SIGKILLed supervisor and releases the lock", async () => {
  const dataRoot = dataDir("force");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-force-"));
  const unlockLog = path.join(scratch, "unlock.log");
  const unlock = path.join(scratch, "unlock.sh");
  fs.writeFileSync(unlock, `#!/bin/sh\necho unlocked >> ${unlockLog}\n`, { mode: 0o755 });
  const launch = conductor(dataRoot, ["droid", "task", "--background", "--json", "--unlock-cmd", unlock, "hang"], { FAKE_HANG: "1" });
  const jobId = jsonOut(launch).jobId;
  const running = await waitForStatus(dataRoot, "droid", jobId, ["running"], 10000);
  process.kill(running.pid, "SIGKILL"); // supervisor dies hard mid-turn, lock held
  const cancelled = conductor(dataRoot, ["droid", "cancel", jobId, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const settledState = jsonOut(cancelled).status;
  assert.ok(["cancelled", "failed"].includes(settledState), `expected a settled state, got ${settledState}`);
  assert.equal(fs.readFileSync(unlockLog, "utf8"), "unlocked\n", "the dead supervisor's lock was released");
  const after = jsonOut(conductor(dataRoot, ["droid", "result", jobId, "--json"]));
  assert.equal(after.status, settledState, "state is stable after settle");
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
  assert.match(conductor(dataRoot, ["droid", "task", "--json", "--profile", "p", "x"]).stderr, /codex-only/);
});

test("lock and unlock commands bracket a named job", async () => {
  const dataRoot = dataDir("locks");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-locks-"));
  const lockLog = path.join(scratch, "lock.log");
  const lock = path.join(scratch, "lock.sh");
  const unlock = path.join(scratch, "unlock.sh");
  fs.writeFileSync(lock, `#!/bin/sh\necho locked >> ${lockLog}\n`, { mode: 0o755 });
  fs.writeFileSync(unlock, `#!/bin/sh\necho unlocked >> ${lockLog}\n`, { mode: 0o755 });

  const launch = conductor(dataRoot, ["droid", "task", "--background", "--json", "--name", "loa-1-s1",
    "--lock-cmd", lock, "--unlock-cmd", unlock, "quick check"]);
  assert.equal(launch.status, 0, launch.stderr);
  const done = await waitForStatus(dataRoot, "droid", jsonOut(launch).jobId, ["completed", "failed"], 20000);
  assert.equal(done.status, "completed");
  assert.equal(done.name, "loa-1-s1");
  assert.equal(fs.readFileSync(lockLog, "utf8"), "locked\nunlocked\n", "lock before, unlock after, exactly once");

  const byName = jsonOut(conductor(dataRoot, ["droid", "result", "loa-1-s1", "--json"]));
  assert.equal(byName.jobId, done.jobId, "result resolves by name");
});

test("a failing lock command fails the job without unlocking", async () => {
  const dataRoot = dataDir("badlock");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-badlock-"));
  const lockLog = path.join(scratch, "lock.log");
  const badLock = path.join(scratch, "bad-lock.sh");
  const unlock = path.join(scratch, "unlock.sh");
  fs.writeFileSync(badLock, `#!/bin/sh\necho lock-attempt >> ${lockLog}\nexit 3\n`, { mode: 0o755 });
  fs.writeFileSync(unlock, `#!/bin/sh\necho unlocked >> ${lockLog}\n`, { mode: 0o755 });

  const launch = conductor(dataRoot, ["droid", "task", "--background", "--json", "--lock-cmd", badLock, "--unlock-cmd", unlock, "quick check"]);
  const done = await waitForStatus(dataRoot, "droid", jsonOut(launch).jobId, ["completed", "failed"], 20000);
  assert.equal(done.status, "failed");
  assert.match(done.error.message, /Lock command failed/);
  assert.equal(fs.readFileSync(lockLog, "utf8"), "lock-attempt\n", "unlock never ran");
});
