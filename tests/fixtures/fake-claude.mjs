#!/usr/bin/env node
// Fake claude CLI: reads the prompt on stdin, speaks stream-json.
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("fake-claude 1.0.0"); process.exit(0); }

let prompt = "";
process.stdin.on("data", data => { prompt += data; });
process.stdin.on("end", () => {
  const session = "fake-claude-session";
  const fail = process.env.FAKE_CLAUDE_ERROR === "1";
  const hang = process.env.FAKE_HANG === "1";
  const schemaJson = process.env.FAKE_CLAUDE_SCHEMA === "1";
  const schemaBad = process.env.FAKE_CLAUDE_SCHEMA_BAD === "1";
  const run = () => {
    const finalText = schemaJson ? JSON.stringify({ answer: "ok" }) : schemaBad ? "not json at all" : "CONDUCTOR_OK";
    const lines = [
      { type: "system", subtype: "init", session_id: session, model: "fake-model", cwd: process.cwd() },
      { type: "assistant", message: { content: [{ type: "text", text: fail ? "boom" : finalText }] }, session_id: session },
    ];
    if (fail) {
      lines.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "FAKE_CLAUDE_ERROR", session_id: session, usage: { input_tokens: 10, output_tokens: 5 } });
    } else {
      lines.push({ type: "result", subtype: "success", is_error: false, result: finalText, session_id: session, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 12 });
    }
    for (const line of lines) console.log(JSON.stringify(line));
    process.exit(0);
  };
  if (hang) setTimeout(run, 30000);
  else run();
});
