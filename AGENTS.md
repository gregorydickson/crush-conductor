# Rules

`crush-conductor/` is its own git repo (parent `loanlight/` is not). Lock the
worktree with `~/.claude/bin/agent-lock.sh <worktree>` before editing; release
on completion.

Run `npm test` before committing. Live tests (`npm run test:live`) spend real
tokens — run them deliberately, not in every pass.

Never push; the operator owns remotes. Never run live delegation against a
repo that isn't locked to this session.

# Project

Crush is the master coordinator; Droid and Claude Code are worker harnesses
driven through one uniform job CLI. Durability rule: job state lives on disk
under `CONDUCTOR_DATA_DIR` (default `~/.local/share/crush-conductor`), never in
a session's memory — any process must be able to pick up a job by id and know
its terminal state.

# Adapter contract

`lib/adapters/<id>.mjs` exports `{ id, label, availability(), runTurn(options) }`.
`runTurn` owns exactly one harness child process, honours `cancelled()` and
`timeoutMs`, reports the child pid via `onChild`, streams progress via
`onProgress`, and resolves the uniform turn envelope
(`exitCode, sessionId, finalMessage, parsed, schemaValid, usage, error,
warnings`). Register new adapters in `lib/adapters/registry.mjs`. The job
layer, CLI, skill, and tests are harness-agnostic — do not add harness
branches outside adapters.

# Invariants

- PID identity: any kill or liveness check must go through `lib/proc.mjs`
  (`processIdentity`/`terminateProcessTree`); a recycled PID must never be
  trusted (store pid + birth-time identity, compare before acting).
- `stdout` purity: with `--json`, stdout carries the envelope only. Progress
  belongs in the job's `stream.jsonl`.
- Access tiers stay conservative: default read-only; `--write` grants edit +
  git; `--full-auto` is explicit opt-in. Never widen a tier silently.
- Unit tests must not hit the network or spend tokens; fake binaries only.
