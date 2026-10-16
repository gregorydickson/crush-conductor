#!/usr/bin/env node
// Fake codex CLI: reads the prompt on stdin, emits JSONL events, honors -o.
import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("fake-codex 0.0.0"); process.exit(0); }

const outputIndex = argv.indexOf("-o");
const lastMessageFile = outputIndex !== -1 ? argv[outputIndex + 1] : null;
const isResume = argv[argv.indexOf("exec") + 1] === "resume";
// Echo the sid the adapter passed so tests can prove id identity end-to-end;
// FAKE_CODEX_FORK_ON_UNKNOWN models real codex's silent-fresh on unknown ids.
const requestedSid = isResume ? argv[argv.indexOf("exec") + 2] : null;
const known = requestedSid != null && (requestedSid.startsWith("fake-") || requestedSid.startsWith("external-"));
const threadId = isResume && process.env.FAKE_CODEX_FORK_ON_UNKNOWN === "1" && !known ? `forked-${requestedSid}` : requestedSid ?? "fake-codex-thread";

let prompt = "";
process.stdin.on("data", data => { prompt += data; });
process.stdin.on("end", () => {
  const fail = process.env.FAKE_CODEX_ERROR === "1";
  const hang = process.env.FAKE_HANG === "1";
  const run = () => {
    const schemaRequested = argv.includes("--output-schema");
    const finalText = schemaRequested ? JSON.stringify({ answer: "ok" }) : isResume && process.env.FAKE_CODEX_RESUME_SECRET === "1" ? "MANGO" : "CONDUCTOR_OK";
    const lines = [
      { type: "thread.started", thread_id: threadId },
      { type: "item.completed", item: { type: "agent_message", text: finalText } },
    ];
    if (fail) lines.push({ type: "turn.failed", error: { message: "FAKE_CODEX_ERROR" } });
    else lines.push({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 } });
    for (const line of lines) console.log(JSON.stringify(line));
    if (lastMessageFile) fs.writeFileSync(lastMessageFile, finalText, "utf8");
    process.exit(fail ? 1 : 0);
  };
  if (hang) setTimeout(run, 30000);
  else run();
});
