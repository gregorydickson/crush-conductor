#!/usr/bin/env node
// Fake droid CLI: speaks the two wire formats the adapter expects.
import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("fake-droid 1.0.0"); process.exit(0); }

const outputFormat = argv[argv.indexOf("--output-format") + 1];
const promptFile = argv[argv.indexOf("-f") + 1];
const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : "";
const hang = process.env.FAKE_HANG === "1";
const invalidFirst = process.env.FAKE_DROID_INVALID_FIRST === "1";
const zero = process.env.FAKE_DROID_ZERO === "1";
const session = "fake-droid-session";

function emit(lines) { for (const line of lines) console.log(JSON.stringify(line)); }

function freshMessage() {
  if (invalidFirst) return "not json at all";
  return "CONDUCTOR_OK";
}
function resumeMessage() {
  if (invalidFirst) return JSON.stringify({ answer: "ok" });
  return "CONDUCTOR_OK";
}

function run() {
  if (zero) {
    emit([
      { jsonrpc: "2.0", result: { sessionId: session } },
      { jsonrpc: "2.0", method: "droid.session_notification", params: { sessionId: session, notification: { type: "assistant_text_delta", messageId: "m0", blockIndex: 0, textDelta: "0" } } },
      { jsonrpc: "2.0", method: "droid.session_notification", params: { sessionId: session, notification: { type: "assistant_text_complete", messageId: "m0" } } },
      { jsonrpc: "2.0", method: "droid.session_notification", params: { sessionId: session, notification: { type: "agent_turn_completed", reason: "completed", tokenUsage: { input_tokens: 1, output_tokens: 1 } } } },
    ]);
    process.exit(0);
  }
  if (outputFormat === "stream-jsonrpc") {
    emit([
      { jsonrpc: "2.0", result: { sessionId: session } },
      { jsonrpc: "2.0", method: "droid.session_notification", params: { sessionId: session, notification: { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, textDelta: freshMessage() } } },
      { jsonrpc: "2.0", method: "droid.session_notification", params: { sessionId: session, notification: { type: "assistant_text_complete", messageId: "m1" } } },
      { jsonrpc: "2.0", method: "droid.session_notification", params: { sessionId: session, notification: { type: "agent_turn_completed", reason: "completed", tokenUsage: { input_tokens: 10, output_tokens: 5, factory_credits: 1 } } } },
    ]);
    process.exit(0);
  }
  emit([
    { type: "system", subtype: "init", session_id: session },
    { type: "message", role: "assistant", id: "m2", text: resumeMessage() },
    { type: "completion", finalText: resumeMessage(), usage: { input_tokens: 20, output_tokens: 6, factory_credits: 2 } },
  ]);
  process.exit(0);
}

if (hang) setTimeout(run, 30000);
else run();
