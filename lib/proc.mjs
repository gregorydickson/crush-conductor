import { spawn, spawnSync } from "node:child_process";

export function runCommand(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15000 });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error?.message ?? null };
}

export function binaryVersion(command, args = ["--version"]) {
  const result = runCommand(command, args);
  return { available: result.status === 0 && !!result.stdout, version: result.stdout.split("\n")[0] ?? null, detail: result.error ?? (result.stderr || null) };
}

/** Stored pids include the process birth time and group so a recycled PID is never trusted. */
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], { encoding: "utf8", timeout: 5000 });
  const identity = (result.stdout ?? "").trim();
  return result.status === 0 && identity ? Buffer.from(identity).toString("base64url") : null;
}

export function pidAlive(pid) {
  return processIdentity(pid) !== null;
}

/** Kill a detached child's whole process group. */
export function terminateProcessTree(pid, { signal = "SIGKILL" } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false, delivered: false, detail: "No pid." };
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
