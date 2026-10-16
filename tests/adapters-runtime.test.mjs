import test from "node:test";
import assert from "node:assert/strict";

// Fake binaries answer --version for doctor and the adapter availability probe.
process.env.DROID_BINARY = new URL("./fixtures/fake-droid.mjs", import.meta.url).pathname;
process.env.CLAUDE_BINARY = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
process.env.CODEX_BINARY = new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname;

const { droidAdapter } = await import("../lib/adapters/droid.mjs");
const { claudeAdapter } = await import("../lib/adapters/claude.mjs");
const { codexAdapter } = await import("../lib/adapters/codex.mjs");

test("droid availability works against the fake binary", () => {
  const availability = droidAdapter.availability();
  assert.equal(availability.available, true);
  assert.match(availability.version, /fake/);
});

test("droid fresh turn parses jsonrpc notifications into an envelope", async () => {
  const events = [];
  const turn = await droidAdapter.runTurn({
    cwd: process.cwd(),
    prompt: "do the thing",
    onProgress: message => events.push(message),
  });
  assert.equal(turn.status, 0);
  assert.equal(turn.sessionId, "fake-droid-session");
  assert.equal(turn.finalMessage, "CONDUCTOR_OK");
  assert.deepEqual(turn.usage, { inputTokens: 10, outputTokens: 5, factoryCredits: 1 });
  assert.ok(events.some(message => message.includes("Session ready")));
});

test("droid schema jobs validate and repair once", async () => {
  process.env.FAKE_DROID_INVALID_FIRST = "1";
  try {
    const turn = await droidAdapter.runTurn({
      cwd: process.cwd(),
      prompt: "structured thing",
      schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
    });
    assert.equal(turn.status, 0);
    assert.equal(turn.schemaValid, true);
    assert.deepEqual(turn.parsed, { answer: "ok" });
  } finally {
    delete process.env.FAKE_DROID_INVALID_FIRST;
  }
});

test("claude turn parses stream-json into an envelope", async () => {
  const turn = await claudeAdapter.runTurn({ cwd: process.cwd(), prompt: "hello" });
  assert.equal(turn.exitCode, 0);
  assert.equal(turn.sessionId, "fake-claude-session");
  assert.equal(turn.finalMessage, "CONDUCTOR_OK");
  assert.deepEqual(turn.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
});

test("claude error results fail the turn", async () => {
  process.env.FAKE_CLAUDE_ERROR = "1";
  try {
    const turn = await claudeAdapter.runTurn({ cwd: process.cwd(), prompt: "hello" });
    assert.equal(turn.exitCode, 1);
    assert.equal(turn.error.message, "FAKE_CLAUDE_ERROR");
  } finally {
    delete process.env.FAKE_CLAUDE_ERROR;
  }
});

test("codex fresh turn parses jsonl events into an envelope", async () => {
  const events = [];
  const turn = await codexAdapter.runTurn({
    cwd: process.cwd(),
    prompt: "do the thing",
    onProgress: message => events.push(message),
  });
  assert.equal(turn.exitCode, 0);
  assert.equal(turn.sessionId, "fake-codex-thread");
  assert.equal(turn.finalMessage, "CONDUCTOR_OK");
  assert.deepEqual(turn.usage, { inputTokens: 12, cachedInputTokens: 3, outputTokens: 7 });
  assert.ok(events.some(message => message.includes("Thread ready")));
});

test("codex schema jobs validate the returned JSON", async () => {
  const turn = await codexAdapter.runTurn({
    cwd: process.cwd(),
    prompt: "structured thing",
    schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  });
  assert.equal(turn.exitCode, 0);
  assert.equal(turn.schemaValid, true);
  assert.deepEqual(turn.parsed, { answer: "ok" });
});

test("codex strict schemas are hardened at every object level", async () => {
  const { hardenStrictSchema } = await import("../lib/adapters/codex.mjs");
  const hardened = hardenStrictSchema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } }, c: { type: "array", items: { type: "object", properties: { d: { type: "number" } } } } } });
  assert.equal(hardened.additionalProperties, false);
  assert.equal(hardened.properties.a.additionalProperties, false);
  assert.equal(hardened.properties.c.items.additionalProperties, false);
  assert.equal(hardened.properties.c.items.properties.d.type, "number");
});

test("codex schema violations fail honestly", async () => {
  const turn = await codexAdapter.runTurn({
    cwd: process.cwd(),
    prompt: "structured thing",
    schema: { type: "object", required: ["missing_field"], properties: { missing_field: { type: "string" } } },
  });
  assert.equal(turn.exitCode, 1);
  assert.equal(turn.schemaValid, false);
  assert.match(turn.error.message, /schema validation/);
});

test("codex turn failures fail the envelope", async () => {
  process.env.FAKE_CODEX_ERROR = "1";
  try {
    const turn = await codexAdapter.runTurn({ cwd: process.cwd(), prompt: "hello" });
    assert.equal(turn.exitCode, 1);
    assert.equal(turn.error.message, "FAKE_CODEX_ERROR");
  } finally {
    delete process.env.FAKE_CODEX_ERROR;
  }
});
