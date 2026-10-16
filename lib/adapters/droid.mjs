import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { binaryVersion } from "../proc.mjs";
import { makeValidator } from "../schema.mjs";

function invocation(env = process.env) {
  const file = env.DROID_BINARY || "droid";
  return /\.[cm]js$/.test(file) ? { command: process.execPath, prefix: [file] } : { command: file, prefix: [] };
}

export const READ_ONLY_TOOLS = "Read,LS,Grep,Glob,Execute";

export const droidAdapter = {
  id: "droid",
  label: "Droid (Factory)",
  availability() {
    const { command, prefix } = invocation();
    return binaryVersion(command, [...prefix, "--version"]);
  },

  /**
   * droid refuses --session-id on a one-shot stream-jsonrpc exec, and a JSON-RPC
   * input session ignores the CLI's --auto/-m/-r, which would drop the tool
   * fence. So a fresh turn streams JSON-RPC and a continued turn (resume or
   * schema repair) streams stream-json, where the flags still apply.
   */
  buildExecArgs({ cwd, promptFile, resumeSessionId, write, fullAuto, model, effort }) {
    const resume = Boolean(resumeSessionId);
    const args = ["exec", "--output-format", resume ? "stream-json" : "stream-jsonrpc", "--cwd", cwd, "-f", promptFile];
    if (fullAuto) args.push("--skip-permissions-unsafe");
    else if (write) args.push("--auto", "medium");
    else args.push("--only-tools", READ_ONLY_TOOLS);
    if (model) args.push("-m", model);
    if (effort) args.push("-r", effort);
    if (resume) args.push("--session-id", resumeSessionId);
    return args;
  },

  async runTurn(options = {}) {
    let prompt = options.prompt?.trim();
    if (!prompt) throw new Error("A prompt is required for this Droid run.");
    if (options.instructionsFile) {
      const instructions = fs.readFileSync(options.instructionsFile, "utf8").trim();
      if (instructions) prompt = `${instructions}\n\n${prompt}`;
    }
    const validator = options.schema ? makeValidator(options.schema) : null;
    if (options.schema) prompt += `\n\nReturn only JSON matching this JSON schema (no Markdown fences):\n${JSON.stringify(options.schema)}`;

    let result = await this.executeTurn(options, prompt);
    if (validator && result.status === 0) {
      let parsed = parseJsonOrNull(result.finalMessage);
      if (!parsed || !validator.validate(parsed)) {
        result = await this.executeTurn({ ...options, resumeSessionId: result.sessionId }, [
          "Your previous answer did not match the required JSON schema. Return corrected JSON only, without tools or further task work.",
          `Schema: ${JSON.stringify(options.schema)}`,
          `Validation errors: ${JSON.stringify(validator.errors)}`,
          `Previous answer: ${result.finalMessage}`,
        ].join("\n"));
        parsed = parseJsonOrNull(result.finalMessage);
        if (!parsed || !validator.validate(parsed)) {
          result.status = 1;
          result.error ??= { message: `Droid output failed schema validation after one repair: ${JSON.stringify(validator.errors)}` };
        }
      }
      if (result.status === 0) {
        result.parsed = parseJsonOrNull(result.finalMessage);
        result.schemaValid = result.parsed != null;
      }
    }
    return result;
  },

  async executeTurn(options, prompt) {
    const cwd = options.cwd ?? process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-droid-"));
    const promptFile = path.join(dir, "prompt.txt");
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const args = this.buildExecArgs({ cwd, promptFile, resumeSessionId: options.resumeSessionId, write: options.write, fullAuto: options.fullAuto, model: options.model, effort: options.effort });
    const streamJson = args[args.indexOf("--output-format") + 1] === "stream-json";
    const { command, prefix } = invocation(options.env);

    try {
      return await new Promise(resolve => {
        const child = spawn(command, [...prefix, ...args], {
          cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        options.onChild?.({ pid: child.pid });
        const messages = new Map();
        const emitted = new Set();
        let sessionId = null, completed = false, terminalReason = null, error = null, usage = null, stderr = "";
        const warnings = [];
        const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
        const onSignal = () => stop();
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);
        const timeout = options.timeoutMs == null ? null : setTimeout(() => { error = { message: "Droid run timed out." }; stop(); }, options.timeoutMs);
        child.stderr.on("data", data => { stderr = (stderr + data).slice(-65536); });
        child.on("error", err => { error = { message: err.message }; });

        const emitMessage = id => {
          if (emitted.has(id) || !messages.has(id)) return;
          const text = [...messages.get(id).entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("");
          emitted.add(id);
          if (text.trim()) options.onProgress?.(text);
        };

        const lines = createInterface({ input: child.stdout });
        lines.on("line", line => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line);
            if (options.cancelled?.()) { stop(); return; }
            if (streamJson) {
              if (typeof event?.type !== "string") throw new Error("Expected Droid stream-json output.");
              if (event.session_id && sessionId && event.session_id !== sessionId) return;
              if (event.type === "system" && event.subtype === "init" && event.session_id) {
                sessionId = event.session_id;
                options.onProgress?.(`Session ready (${sessionId}).`);
              }
              if (event.type === "error") warnings.push({ message: event.message ?? event.error ?? JSON.stringify(event) });
              if (event.type === "message" && event.role === "assistant" && typeof event.text === "string") {
                messages.set(event.id, new Map([[0, event.text]]));
                emitMessage(event.id);
              }
              if (event.type === "tool_call") options.onProgress?.(`Running tool: ${event.toolName ?? event.toolId ?? "tool"}`);
              if (event.type === "completion") {
                completed = true; terminalReason = "completed";
                usage = mapStreamJsonUsage(event.usage);
                if (typeof event.finalText === "string" && event.finalText.trim()) messages.set("completion", new Map([[0, event.finalText]]));
              }
              return;
            }
            if (event.jsonrpc !== "2.0") throw new Error("Expected Factory JSON-RPC output.");
            if (event.error) warnings.push(event.error);
            if (event.result?.sessionId) {
              sessionId = event.result.sessionId;
              options.onProgress?.(`Session ready (${sessionId}).`);
            }
            if (event.method !== "droid.session_notification") return;
            if (event.params?.sessionId && sessionId && event.params.sessionId !== sessionId) return;
            const notification = event.params?.notification;
            if (!notification) return;
            if (notification.type === "error") warnings.push(notification);
            if (notification.type === "assistant_text_delta") {
              const blocks = messages.get(notification.messageId) ?? new Map();
              blocks.set(notification.blockIndex, (blocks.get(notification.blockIndex) ?? "") + notification.textDelta);
              messages.set(notification.messageId, blocks);
            }
            if (notification.type === "create_message" && notification.message?.role === "assistant") {
              const blocks = new Map((notification.message.content ?? []).flatMap((block, index) => block.type === "text" ? [[index, block.text]] : []));
              if (blocks.size) messages.set(notification.message.id, blocks);
            }
            if (notification.type === "assistant_text_complete") emitMessage(notification.messageId);
            if (notification.type === "assistant_message_retracted") messages.delete(notification.messageId);
            if (notification.type === "tool_call") {
              for (const id of messages.keys()) emitMessage(id);
              options.onProgress?.(`Running tool: ${notification.toolUse?.name ?? "tool"}`);
            }
            if (notification.type === "agent_turn_completed") {
              completed = true; terminalReason = notification.reason;
              usage = mapStreamJsonUsage(notification.tokenUsage);
              for (const id of messages.keys()) emitMessage(id);
              if (notification.reason !== "completed") error ??= warnings.at(-1) ?? { message: `Droid turn ended: ${notification.reason}` };
            }
          } catch (err) {
            if (!completed) { error = { message: `Invalid Droid protocol: ${err.message}` }; stop(); }
          }
        });

        child.on("close", code => {
          clearTimeout(timeout);
          process.off("SIGTERM", onSignal);
          process.off("SIGINT", onSignal);
          const last = [...messages.values()].at(-1);
          const finalMessage = last ? [...last.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("") : "";
          if (!completed || code !== 0) error ??= warnings.at(-1);
          if (!finalMessage.trim()) error ??= { message: stderr.trim() || "Droid returned no final assistant message." };
          if (!completed) error ??= { message: stderr.trim() || "Droid exited without a turn completion event." };
          if (!sessionId) error ??= { message: "Droid returned no session ID." };
          resolve({
            status: code === 0 && terminalReason === "completed" && !error ? 0 : 1,
            sessionId, finalMessage, parsed: null, schemaValid: null,
            usage, error, warnings,
          });
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

function parseJsonOrNull(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function mapStreamJsonUsage(usage) {
  if (!usage) return null;
  const keys = {
    input_tokens: "inputTokens", output_tokens: "outputTokens",
    cache_read_input_tokens: "cacheReadTokens", cache_creation_input_tokens: "cacheCreationTokens",
    thinking_tokens: "thinkingTokens", factory_credits: "factoryCredits", factoryCredits: "factoryCredits",
  };
  const mapped = Object.fromEntries(Object.entries(keys).filter(([key]) => typeof usage[key] === "number").map(([key, name]) => [name, usage[key]]));
  return Object.keys(mapped).length ? mapped : null;
}
