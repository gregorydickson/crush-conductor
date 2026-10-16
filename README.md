# crush-conductor

Charm **Crush** as the master coordinator of a project's worth of work: a
single job CLI that delegates work to external agent harnesses and manages
those jobs durably on disk. Initial interfaces: **Droid** (Factory),
**Claude Code**, and **Codex** (OpenAI); further harnesses slot in as adapters.

Crush (or any caller) never babysits a worker interactively. Every delegation
is a job: launch, poll, collect a verifiable envelope, cancel or resume. Job
state survives Crush restarts because it lives on disk, not in the session.

## Quick start

```bash
bash install.sh                 # links skill to ~/.agents/skills + CLI to PATH
conductor claude doctor --json  # binary present?
conductor droid task --background --json --brief brief.md --output-schema schema.json
conductor droid status --wait --timeout 600 --json   # repeat while running
conductor droid result --json
```

## CLI

```
conductor <droid|claude|codex> task [--background] [--write|--full-auto]
                              [--resume | --resume-job <id|name> | --fresh]
                              [--model <m>] [--effort <e>] [--cwd <dir>]
                              [--timeout <secs>] [--brief <file>]
                              [--instructions <file>] [--output-schema <file>]
                              [--budget <usd>] [--name <name>]
                              [--lock-cmd <cmd>] [--unlock-cmd <cmd>]
                              [--profile <p>] [--no-user-config] [--json] [prompt]
conductor <droid|claude|codex> status [job-id-or-name] [--wait] [--timeout <secs>] [--json]
conductor <droid|claude|codex> result [job-id-or-name] [--json]
conductor <droid|claude|codex> cancel [job-id-or-name] [--json]
conductor <droid|claude|codex> doctor [--json]
conductor <droid|claude|codex> resume-candidate [--json]
conductor list [--harness <id>] [--json]
conductor __supervise <job-id>   (internal; detached job supervisor)
```

Exit codes: a foreground `task` and `result` exit 0 only when the job
reached `status == "completed"` (and `schemaValid != false`); a
`task --background` launch exits 0 on a successful handoff (the job left
`queued`) and 1 if the job already failed or was cancelled at handoff.
`status`/`result` with no job id resolve the latest job for that harness.

## Envelope

Every command prints a job envelope (with `--json`, machine-parseable on
stdout; progress goes to the job's stream file, never stdout):

```json
{
  "jobId": "claude-m3xyz_ab12",
  "harness": "claude",
  "status": "completed",
  "result": "final assistant message",
  "sessionId": "…",
  "resumedFrom": null,
  "parsed": null,
  "schemaValid": null,
  "usage": { "inputTokens": 123, "outputTokens": 45, "costUsd": 0.02 },
  "error": null,
  "durationMs": 45210,
  "write": false,
  "cwd": "/path/to/worktree"
}
```

With `--output-schema`, `parsed` holds the worker's locally validated JSON
and `schemaValid` states whether it matched — every harness adapter parses
and validates the final message itself, so the claim is checked, never
assumed. Droid additionally repairs one bad response; Claude Code and Codex
lean on their native enforcement plus the same local check.

State: `~/.local/share/crush-conductor/jobs/<job-id>/` (`job.json`,
`stream.jsonl` progress trail, `cancel` marker), written mode `0600`
(operator-private: it holds prompts, results, session ids). Override with
`CONDUCTOR_DATA_DIR`. The last successful session per harness is remembered
for `--resume`.

## Access tiers

| Mode | droid | claude | codex |
| --- | --- | --- | --- |
| default (read-only) | `--only-tools Read,LS,Grep,Glob,Execute` | `dontAsk` + write tools disallowed | `-s read-only` |
| `--write` | `--auto medium` | `acceptEdits` + edit/git tool allows | `-s workspace-write` + `approval_policy=never` |
| `--full-auto` | `--skip-permissions-unsafe` | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

## Architecture

```
bin/conductor.mjs        CLI entry; also __supervise (detached job runner)
lib/jobs.mjs             job registry: state on disk, locks, cancel markers, resume index
lib/supervise.mjs        one job to terminal state; writes the envelope
lib/adapters/registry.mjs  harness registry
lib/adapters/droid.mjs   droid exec transport (stream-jsonrpc fresh, stream-json resume)
lib/adapters/claude.mjs  claude -p transport (stream-json, prompt via stdin)
lib/adapters/codex.mjs   codex exec transport (JSONL events, prompt via stdin, resume subcommand)
lib/schema.mjs           JSON Schema subset validator (type/required/properties/items/enum)
lib/proc.mjs             process identity (PID-reuse safe), process-tree kill
skills/conductor/        the Crush skill (installed to ~/.agents/skills)
```

Foreground `task` runs supervision inline. `task --background` writes the job,
spawns a detached `__supervise` process that owns the harness child, and
returns the `jobId` immediately — the job finishes even if the launching
session dies. `cancel` writes a marker and signals the supervisor; a supervisor
that died without reporting is lazily failed on next read (PID identity
checked, so recycled PIDs are never trusted).

### Adding a harness

Implement `lib/adapters/<id>.mjs` exporting:

```js
export const myAdapter = {
  id, label,
  availability() { return { available, version, detail }; },
  async runTurn(options) {
    /* options: cwd, prompt, instructionsFile, schema, model, effort,
       write, fullAuto, budgetUsd, resumeSessionId, timeoutMs, env,
       onProgress(message), onChild({pid}), cancelled() */
    return { exitCode, sessionId, finalMessage, parsed, schemaValid, usage, error, warnings };
  },
};
```

Register it in `lib/adapters/registry.mjs`. Nothing else changes — jobs,
cancellation, resume, envelopes, and the Crush skill are harness-agnostic.

## Tests

```bash
npm test              # unit tests (fake harness binaries; no network, no tokens)
npm run test:live     # real claude, droid, and codex smoke tasks; CONDUCTOR_LIVE=1 gates
```
