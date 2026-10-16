import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { binaryInvocation, binaryVersion } from "../proc.mjs";
import { makeValidator } from "../schema.mjs";

function invocation(env = process.env) {
  return binaryInvocation("CODEX_BINARY", "codex", env);
}

export const codexAdapter = {
  id: "codex",
  label: "Codex (OpenAI)",
  availability() {
    const { command, prefix } = invocation();
    return binaryVersion(command, [...prefix, "--version"]);
  },

  /**
   * One headless `codex exec` child per turn. The prompt travels on stdin
   * (`-`), the final message is collected via --output-last-message, and
   * stdout is JSONL events. Tiers map to codex sandbox modes.
   */
  buildExecArgs(options = {}) {
    const resume = Boolean(options.resumeSessionId);
    const base = resume ? ["exec", "resume", options.resumeSessionId] : ["exec"];
    const args = [...base, "--json"];
    if (!resume) args.push("-C", options.cwd ?? process.cwd());
    // `exec resume` has no -C/-s flags; cwd comes from the child spawn and the
    // sandbox tier is expressed as config overrides instead.
    if (options.fullAuto) args.push("--dangerously-bypass-approvals-and-sandbox");
    else if (options.write) {
      if (resume) args.push("-c", 'sandbox_mode="workspace-write"');
      else args.push("-s", "workspace-write");
      args.push("-c", 'approval_policy="never"');
    } else if (resume) args.push("-c", 'sandbox_mode="read-only"');
    else args.push("-s", "read-only");
    if (options.model) args.push("-m", options.model);
    if (options.effort) args.push("-c", `model_reasoning_effort="${options.effort}"`);
    if (options.profile) args.push("-p", options.profile);
    if (options.noUserConfig) args.push("--ignore-user-config");
    if (options.outputSchemaFile) args.push("--output-schema", options.outputSchemaFile);
    if (options.lastMessageFile) args.push("-o", options.lastMessageFile);
    args.push("-");
    return args;
  },

  async runTurn(options = {}) {
    let prompt = options.prompt?.trim();
    if (!prompt) throw new Error("A prompt is required for this Codex run.");
    if (options.instructionsFile) {
      const instructions = fs.readFileSync(options.instructionsFile, "utf8").trim();
      if (instructions) prompt = `${instructions}\n\n${prompt}`;
    }
    const cwd = options.cwd ?? process.cwd();
    // Build the validator before any child exists: a malformed schema fails
    // the job cleanly instead of throwing inside a close handler.
    if (options.schema) {
      try { makeValidator(options.schema); }
      catch (error) { throw new Error(`Invalid --output-schema: ${error.message}`); }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-codex-"));
    const lastMessageFile = path.join(dir, "last-message.txt");
    const outputSchemaFile = options.schema ? path.join(dir, "schema.json") : null;
    if (outputSchemaFile) fs.writeFileSync(outputSchemaFile, JSON.stringify(hardenStrictSchema(options.schema)), "utf8");
    const args = this.buildExecArgs({ ...options, cwd, lastMessageFile, outputSchemaFile });
    const { command, prefix } = invocation(options.env);

    try {
      return await new Promise(resolve => {
        const child = spawn(command, [...prefix, ...args], {
          cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        options.onChild?.({ pid: child.pid });
        let sessionId = null, error = null, usage = null, completed = false, stderr = "";
        let lastAssistantMessage = "";
        const warnings = [];
        const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
        const onSignal = () => stop();
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);
        const timeout = options.timeoutMs == null ? null : setTimeout(() => { error = { message: "Codex run timed out." }; stop(); }, options.timeoutMs);
        child.stderr.on("data", data => { stderr = (stderr + data).slice(-65536); });
        child.on("error", err => { error = { message: err.message }; });

        const lines = createInterface({ input: child.stdout });
        lines.on("line", line => {
          if (!line.trim()) return;
          let event;
          try { event = JSON.parse(line); } catch { warnings.push({ message: `Unparseable stream line: ${line.slice(0, 200)}` }); return; }
          if (options.cancelled?.()) { stop(); return; }
          if (event.type === "thread.started" && event.thread_id) {
            sessionId = event.thread_id;
            options.onProgress?.(`Thread ready (${sessionId}).`);
          }
          if (event.type === "error") warnings.push({ message: event.message ?? JSON.stringify(event) });
          if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
            lastAssistantMessage = event.item.text;
            if (event.item.text.trim()) options.onProgress?.(event.item.text);
          }
          if (event.type === "turn.completed") {
            completed = true;
            usage = mapUsage(event.usage);
          }
          if (event.type === "turn.failed") error ??= { message: event.error?.message ?? "Codex turn failed." };
        });

        child.on("close", code => {
          clearTimeout(timeout);
          process.off("SIGTERM", onSignal);
          process.off("SIGINT", onSignal);
          let finalMessage = "";
          try { finalMessage = fs.readFileSync(lastMessageFile, "utf8"); } catch { /* no file */ }
          if (!finalMessage.trim()) finalMessage = lastAssistantMessage;
          if (!completed) error ??= { message: stderr.trim() || "Codex exited without a turn.completed event." };
          if (!finalMessage.trim()) error ??= { message: stderr.trim() || "Codex returned no final message." };
          if (!sessionId) error ??= { message: "Codex returned no thread id." };
          let parsed = null;
          let schemaValid = null;
          if (options.schema) {
            // Native enforcement plus our own check: never claim validity without validating.
            const validator = makeValidator(options.schema);
            try { parsed = JSON.parse(finalMessage); } catch { parsed = null; }
            schemaValid = parsed != null && validator.validate(parsed);
            if (!schemaValid && code === 0 && completed && !error) {
              error = { message: `Codex output failed schema validation: ${JSON.stringify(validator.errors ?? ["output was not valid JSON"])}` };
            }
          }
          resolve({
            exitCode: code === 0 && completed && !error && schemaValid !== false ? 0 : 1,
            sessionId,
            finalMessage,
            parsed,
            schemaValid,
            usage,
            error,
            warnings,
          });
        });

        child.stdin.write(prompt + "\n");
        child.stdin.end();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

/**
 * Codex strict output schemas reject objects unless every level sets
 * additionalProperties: false. Inject it wherever the caller omitted it so
 * plain worker schemas pass without ceremony.
 */
export function hardenStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(hardenStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const copy = { ...schema };
  if (copy.properties && copy.additionalProperties === undefined) copy.additionalProperties = false;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([name, child]) => [name, hardenStrictSchema(child)]));
  for (const key of ["items", "anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (copy[key] !== undefined) copy[key] = hardenStrictSchema(copy[key]);
  }
  return copy;
}

function mapUsage(usage) {
  if (!usage) return null;
  const mapped = {};
  if (usage.input_tokens != null) mapped.inputTokens = usage.input_tokens;
  if (usage.cached_input_tokens != null) mapped.cachedInputTokens = usage.cached_input_tokens;
  if (usage.output_tokens != null) mapped.outputTokens = usage.output_tokens;
  if (usage.reasoning_output_tokens != null) mapped.reasoningOutputTokens = usage.reasoning_output_tokens;
  return Object.keys(mapped).length ? mapped : null;
}
