import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real-harness smoke tests. Gated: they spend tokens.
if (process.env.CONDUCTOR_LIVE !== "1") {
  test("live tests skipped (set CONDUCTOR_LIVE=1)", { skip: true }, () => {});
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const CLI = path.join(ROOT, "bin", "conductor.mjs");

  function conductor(args, extraEnv = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 300000,
      env: { ...process.env, ...extraEnv },
    });
  }

  for (const harness of ["claude", "droid", "codex"]) {
    test(`${harness} live roundtrip`, async () => {
      const doctor = conductor([harness, "doctor", "--json"]);
      assert.equal(doctor.status, 0, `${harness} unavailable: ${doctor.stdout}${doctor.stderr}`);
      const task = conductor([harness, "task", "--json", `Reply with exactly the token CONDUCTOR_OK and nothing else. Working directory files must not be modified.`]);
      assert.equal(task.status, 0, task.stderr);
      const envelope = JSON.parse(task.stdout);
      assert.equal(envelope.status, "completed", JSON.stringify(envelope.error ?? envelope));
      assert.match(envelope.result, /CONDUCTOR_OK/);
      assert.ok(envelope.sessionId, "live session id recorded for resume");
    });
  }

  test("claude live resume remembers the thread", () => {
    const first = JSON.parse(conductor(["claude", "task", "--json", "Remember the secret word: MANGO. Reply with just OK."]).stdout);
    assert.equal(first.status, "completed");
    const second = JSON.parse(conductor(["claude", "task", "--json", "--resume", "What was the secret word? Reply with just the word."]).stdout);
    assert.equal(second.status, "completed");
    assert.match(second.result, /MANGO/i);
    assert.equal(second.resumedFrom, first.jobId);
  });

  test("codex live resume remembers the thread", () => {
    const first = JSON.parse(conductor(["codex", "task", "--json", "Remember the secret word: PAPAYA. Reply with just OK."]).stdout);
    assert.equal(first.status, "completed");
    const second = JSON.parse(conductor(["codex", "task", "--json", "--resume", "What was the secret word? Reply with just the word."]).stdout);
    assert.equal(second.status, "completed");
    assert.match(second.result, /PAPAYA/i);
    assert.equal(second.resumedFrom, first.jobId);
  });
}
