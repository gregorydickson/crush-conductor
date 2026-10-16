import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { binaryVersion } from "../proc.mjs";

export const CLAUDE_WRITE_TOOLS = [
  "Edit", "Write", "MultiEdit", "NotebookEdit",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git checkout:*)", "Bash(git branch:*)",
  "Bash(git switch:*)", "Bash(git restore:*)", "Bash(git stash:*)", "Bash(git worktree:*)",
  "Bash(git config --get:*)",
];

function invocation(env = process.env) {
  const file = env.CLAUDE_BINARY || "claude";
  return /\.[cm]js$/.test(file) ? { command: process.execPath, prefix: [file] } : { command: file, prefix: [] };
}

export const claudeAdapter = {
  id: "claude",
  label: "Claude Code",
  availability() {
    const { command, prefix } = invocation();
    return binaryVersion(command, [...prefix, "--version"]);
  },

  buildArgs(options = {}) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
    if (options.fullAuto) args.push("--permission-mode", "bypassPermissions");
    else if (options.write) args.push("--permission-mode", "acceptEdits", "--allowedTools", CLAUDE_WRITE_TOOLS.join(","), "--permission-prompts", "none");
    else args.push("--permission-mode", "dontAsk", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash");
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.instructionsFile) args.push("--append-system-prompt-file", options.instructionsFile);
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    if (options.budgetUsd != null) args.push("--max-budget-usd", String(options.budgetUsd));
    return args;
  },

  /**
   * One headless `claude -p` child per turn. The prompt travels on stdin so
   * brief length never hits argv limits. stdout is Anthropic stream-json.
   */
  async runTurn(options = {}) {
    const prompt = options.prompt?.trim();
    if (!prompt) throw new Error("A prompt is required for this Claude run.");
    const { command, prefix } = invocation(options.env);
    const args = this.buildArgs(options);
    const cwd = options.cwd ?? process.cwd();

    return await new Promise(resolve => {
      const child = spawnClaude(command, [...prefix, ...args], cwd, options);
      let sessionId = null, model = null, error = null, stderr = "";
      let resultEvent = null;
      const assistantText = [];
      const warnings = [];
      const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
      const onSignal = () => stop();
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      const timeout = options.timeoutMs == null ? null : setTimeout(() => { error = { message: "Claude run timed out." }; stop(); }, options.timeoutMs);
      child.stderr.on("data", data => { stderr = (stderr + data).slice(-65536); });
      child.on("error", err => { error = { message: err.message }; });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { warnings.push({ message: `Unparseable stream line: ${line.slice(0, 200)}` }); return; }
        if (event.type === "system" && event.subtype === "init") {
          sessionId = event.session_id ?? sessionId;
          model = event.model ?? model;
          options.onProgress?.(`Session ready (${sessionId}).`);
        }
        if (event.type === "assistant" && event.message?.content) {
          const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
          if (text.trim()) options.onProgress?.(text);
        }
        if (event.type === "result") resultEvent = event;
      });

      child.on("close", code => {
        clearTimeout(timeout);
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        if (options.cancelled?.()) { resolve(turnFailure("cancelled", "Job cancelled.", warnings)); return; }
        if (!resultEvent) {
          resolve(turnFailure("failed", error?.message ?? (stderr.trim() || "Claude exited without a result event."), warnings));
          return;
        }
        sessionId = resultEvent.session_id ?? sessionId;
        const finalMessage = typeof resultEvent.result === "string" ? resultEvent.result : "";
        const failed = resultEvent.is_error || (resultEvent.subtype && resultEvent.subtype !== "success");
        if (failed) warnings.push({ message: `Result subtype: ${resultEvent.subtype}` });
        const usage = mapUsage(resultEvent);
        resolve({
          exitCode: failed ? 1 : (code === 0 ? 0 : 1),
          sessionId,
          model,
          finalMessage,
          parsed: null,
          schemaValid: options.schema ? !failed : null,
          usage,
          error: failed ? { message: finalMessage || stderr.trim() || `Claude result subtype: ${resultEvent.subtype}` } : error,
          warnings,
        });
      });

      child.stdin.write(prompt + "\n");
      child.stdin.end();
    });
  },
};

function spawnClaude(command, args, cwd, options) {
  const child = spawn(command, args, {
    cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  options.onChild?.({ pid: child.pid });
  return child;
}

function mapUsage(resultEvent) {
  const usage = resultEvent?.usage;
  if (!usage && resultEvent?.total_cost_usd == null) return null;
  const mapped = {};
  if (usage?.input_tokens != null) mapped.inputTokens = usage.input_tokens;
  if (usage?.output_tokens != null) mapped.outputTokens = usage.output_tokens;
  if (usage?.cache_read_input_tokens != null) mapped.cacheReadTokens = usage.cache_read_input_tokens;
  if (usage?.cache_creation_input_tokens != null) mapped.cacheCreationTokens = usage.cache_creation_input_tokens;
  if (resultEvent?.total_cost_usd != null) mapped.costUsd = resultEvent.total_cost_usd;
  return Object.keys(mapped).length ? mapped : null;
}

function turnFailure(kind, message, warnings) {
  return { exitCode: 1, sessionId: null, model: null, finalMessage: "", parsed: null, schemaValid: null, usage: null, error: { kind, message }, warnings };
}
