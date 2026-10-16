import { spawn, spawnSync } from "node:child_process";

export function runCommand(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15000 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error?.message ?? null };
}

export function binaryVersion(command, args = ["--version"]) {
  let result = runCommand(command, args);
  if (result.error) result = runCommand(command, args); // one retry: transient spawn failures under load
  return { available: result.status === 0 && !!result.stdout, version: result.stdout.split("\n")[0] ?? null, detail: result.error ?? (result.stderr || null) };
}

/** Resolve a harness binary: an env override may name a .cjs/.mjs shim run under node. */
export function binaryInvocation(envVar, fallback, env = process.env) {
  const file = env[envVar] || fallback;
  return /\.[cm]js$/.test(file) ? { command: process.execPath, prefix: [file] } : { command: file, prefix: [] };
}

/**
 * Probe a pid without trusting transient failures: `ps` erroring under load
 * means UNKNOWN (never "dead"), while ps running and finding no row means
 * the process is gone for sure. Identity (birth time + group) lets callers
 * detect recycled pids.
 */
export function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { known: false, alive: false, identity: null };
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], { encoding: "utf8", timeout: 5000 });
  if (result.error) return { known: false, alive: false, identity: null };
  const identity = (result.stdout ?? "").trim();
  if (result.status !== 0 || !identity) return { known: true, alive: false, identity: null };
  return { known: true, alive: true, identity: Buffer.from(identity).toString("base64url") };
}

/** Stored pids include the process birth time and group so a recycled PID is never trusted. */
export function processIdentity(pid) {
  const probe = probeProcess(pid);
  return probe.alive ? probe.identity : null;
}

/**
 * Kill a detached child's whole process group. When an identity is supplied
 * (the recorded birth-time identity of the pid), a pid that now belongs to a
 * different process is never signalled.
 */
export function terminateProcessTree(pid, { signal = "SIGKILL", identity = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false, delivered: false, detail: "No pid." };
  if (identity != null) {
    const probe = probeProcess(pid);
    if (!probe.known) return { attempted: false, delivered: false, detail: "Process state unknown; not signalled." };
    if (probe.identity !== identity) return { attempted: false, delivered: false, detail: `Pid ${pid} was recycled; not signalled.` };
  }
  try {
    process.kill(-pid, signal);
    return { attempted: true, delivered: true, method: `pgroup ${signal}` };
  } catch (error) {
    if (error.code === "ESRCH") return { attempted: true, delivered: false, detail: "Process group already gone." };
    try {
      process.kill(pid, signal);
      return { attempted: true, delivered: true, method: `pid ${signal}` };
    } catch (err) {
      return { attempted: true, delivered: false, detail: err.message };
    }
  }
}
