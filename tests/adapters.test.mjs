import test from "node:test";
import assert from "node:assert/strict";
import { droidAdapter, READ_ONLY_TOOLS } from "../lib/adapters/droid.mjs";
import { claudeAdapter, CLAUDE_WRITE_TOOLS } from "../lib/adapters/claude.mjs";
import { codexAdapter } from "../lib/adapters/codex.mjs";

test("droid fresh read-only turn is fenced and jsonrpc", () => {
  const args = droidAdapter.buildExecArgs({ cwd: "/w", promptFile: "/p.txt" });
  assert.deepEqual(args, ["exec", "--output-format", "stream-jsonrpc", "--cwd", "/w", "-f", "/p.txt", "--only-tools", READ_ONLY_TOOLS]);
});

test("droid write mode uses --auto medium", () => {
  const args = droidAdapter.buildExecArgs({ cwd: "/w", promptFile: "/p", write: true, model: "gpt-6-sol", effort: "high" });
  assert.ok(args.includes("--auto"));
  assert.equal(args[args.indexOf("--auto") + 1], "medium");
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-6-sol"]);
  assert.equal(args[args.indexOf("-r") + 1], "high");
});

test("droid full-auto is explicit", () => {
  const args = droidAdapter.buildExecArgs({ cwd: "/w", promptFile: "/p", fullAuto: true });
  assert.ok(args.includes("--skip-permissions-unsafe"));
  assert.ok(!args.includes("--only-tools"));
});

test("droid resume flips to stream-json with session id", () => {
  const args = droidAdapter.buildExecArgs({ cwd: "/w", promptFile: "/p", resumeSessionId: "sess-9", write: true });
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--session-id") + 1], "sess-9");
  assert.ok(args.includes("--auto"));
});

test("claude read-only denies writes and prompts", () => {
  const args = claudeAdapter.buildArgs({});
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  const denied = args[args.indexOf("--disallowedTools") + 1];
  for (const tool of ["Edit", "Write", "MultiEdit", "Bash"]) assert.ok(denied.includes(tool), `denies ${tool}`);
});

test("claude write mode allows edit and git", () => {
  const args = claudeAdapter.buildArgs({ write: true });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  const allowed = args[args.indexOf("--allowedTools") + 1];
  for (const tool of ["Edit", "Write", "Bash(git commit:*)"]) assert.ok(allowed.includes(tool), `allows ${tool}`);
  assert.ok(!allowed.includes("Bash(") || !allowed.split(",").some(t => t === "Bash"));
});

test("claude full-auto, model, effort, schema, budget, resume", () => {
  const args = claudeAdapter.buildArgs({ fullAuto: true, model: "opus", effort: "high", schema: { type: "object" }, budgetUsd: 2, resumeSessionId: "s1" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]), { type: "object" });
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2");
  assert.equal(args[args.indexOf("--resume") + 1], "s1");
});

test("codex read-only maps to sandbox read-only", () => {
  const args = codexAdapter.buildExecArgs({ cwd: "/w", lastMessageFile: "/o" });
  assert.deepEqual(args, ["exec", "--json", "-C", "/w", "--skip-git-repo-check", "-s", "read-only", "-o", "/o", "-"]);
});

test("codex write maps to workspace-write with deterministic approvals", () => {
  const args = codexAdapter.buildExecArgs({ cwd: "/w", write: true, model: "gpt-5.2-codex", effort: "high", lastMessageFile: "/o", outputSchemaFile: "/s" });
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", 'approval_policy="never"']);
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.2-codex");
  assert.equal(args[args.indexOf("-c", args.indexOf("-m")) + 1], 'model_reasoning_effort="high"');
  assert.equal(args[args.indexOf("--output-schema") + 1], "/s");
});

test("codex full-auto bypasses sandbox and never fences tools", () => {
  const args = codexAdapter.buildExecArgs({ cwd: "/w", fullAuto: true, lastMessageFile: "/o" });
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("-s"));
});

test("codex resume routes through exec resume with the thread id", () => {
  const args = codexAdapter.buildExecArgs({ cwd: "/w", resumeSessionId: "thread-9", lastMessageFile: "/o" });
  assert.deepEqual(args.slice(0, 4), ["exec", "resume", "thread-9", "--json"]);
  assert.ok(args.includes("--skip-git-repo-check"), "ad-hoc non-repo cwds are allowed; the sandbox is the boundary");
  assert.ok(!args.includes("-C"), "resume has no -C flag");
  assert.ok(!args.includes("-s"), "resume has no -s flag");
  assert.equal(args[args.indexOf("-c") + 1], 'sandbox_mode="read-only"');
});

test("codex write resume expresses the sandbox as a config override", () => {
  const args = codexAdapter.buildExecArgs({ cwd: "/w", resumeSessionId: "thread-9", write: true, lastMessageFile: "/o" });
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes('approval_policy="never"'));
});

test("codex profile and no-user-config fence pass through", () => {
  const args = codexAdapter.buildExecArgs({ cwd: "/w", profile: "edu-worktree", noUserConfig: true, lastMessageFile: "/o" });
  assert.equal(args[args.indexOf("-p") + 1], "edu-worktree");
  assert.ok(args.includes("--ignore-user-config"));
});
