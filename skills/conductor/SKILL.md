---
name: conductor
description: Delegate work from Crush to external agent harnesses (Droid, Claude Code, Codex) as managed background jobs — task fan-out, status polling, result collection, cancellation, and session resume. Use whenever the plan calls for sending implementation, review, or investigation work to another agent CLI while Crush stays the master coordinator.
user-invocable: true
---

# Conductor — Crush delegates to other agent harnesses

Crush is the master coordinator. Droid, Claude Code, and Codex (and later
harnesses) are worker backends driven through one uniform job CLI. Never
babysit a worker interactively; every delegation is a job with a durable
on-disk envelope.

## The CLI

Binary: `node ~/loanlight/crush-conductor/bin/conductor.mjs` (or `conductor` if
install.sh linked it onto PATH). All read commands accept `--json`; always pass
it and parse the envelope — never scrape human output.

```
conductor <droid|claude|codex> task [--background] [--write|--full-auto] [--resume | --resume-job <id|name> | --resume-session <sid> | --fresh]
                              [--model <m>] [--effort <e>] [--cwd <dir>]
                              [--timeout <secs>] [--brief <file>]
                              [--instructions <file>] [--output-schema <file>]
                              [--budget <usd>] [--name <name>] [--lock-cmd <cmd>] [--unlock-cmd <cmd>]
                              [--profile <p>] [--no-user-config] [--json] [prompt]
conductor <droid|claude|codex> status [job-id-or-name] [--wait] [--timeout <secs>] [--json]
conductor <droid|claude|codex> result [job-id-or-name] [--json]
conductor <droid|claude|codex> cancel [job-id-or-name] [--json]
conductor <droid|claude|codex> doctor [--json]
conductor <droid|claude|codex> resume-candidate [--json]
conductor list [--harness <id>] [--json]
```

Job state lives under `~/.local/share/crush-conductor/jobs/<job-id>/`
(`CONDUCTOR_DATA_DIR` overrides). Envelope fields that matter:
`jobId, harness, status (queued|running|completed|failed|cancelled), result,
error, sessionId, usage, schemaValid, parsed, resumedFrom, durationMs`.

## Delegation protocol

1. **Preflight**: `conductor <harness> doctor --json` once per session. If
   `available` is false, do not delegate — report it.
2. **Brief, don't chat**: write the full task brief to a temp file and use
   `--brief`. For structured results add `--output-schema` (JSON Schema subset:
   type/properties/required/items/enum). A valid completion requires
   `status == "completed"` and, when a schema was supplied, `schemaValid == true`.
3. **Launch**: `task --background --json` returns at once with `jobId` and the
   job flips to `running`. Use background for anything beyond a trivial lookup;
   the bash tool's auto-backgrounding otherwise holds the turn hostage.
4. **Poll**: `status <jobId> --wait --timeout 600 --json`; if it returns while
   still `running`, poll again. Long jobs are normal — keep planning other work
   between polls.
5. **Collect**: `result <jobId> --json`. The worker's summary is a claim, not a
   result: verify against the tree (diff, tests, file contents) before
   relaying anything upward. An unverified worker claim is a rumour.
6. **Abort**: `cancel <jobId> --json` when a worker went sideways.
7. **Follow-ups**: `--resume` continues the harness's last good session (thread
   memory retained); `--fresh` starts clean; `--resume-session <sid>` takes
   over a thread launched by any other tool mid-flight (confirm the source
   job is stopped first — two writers on one thread corrupt it). Check
   `resume-candidate --json` before choosing.

## Access and safety rules

- Default runs are **read-only**. `--write` grants edit + git commands
  (droid: `--auto medium`; claude: acceptEdits + git tool allows;
  codex: `-s workspace-write`). `--full-auto` lifts fences entirely —
  reserve for sandboxes/worktrees.
- Write jobs get their own **git worktree** (`--cwd`) and the worktree lock
  (`~/.claude/bin/agent-lock.sh <worktree>`) is held by Crush for the duration;
  release after the job settles. One repo per worker, one worker per worktree.
- Workers never push. Crush reviews, commits, and pushes.
- Cross-harness resumes are rejected; `--resume-job <id|name>` must match the
  harness. Claude budgets can be capped with `--budget <usd>`.
- PM lanes: `--name <card>-<slice>` names a job so status/result/cancel/
  fix-round resumes can address it; `--lock-cmd`/`--unlock-cmd` bracket a
  write job's worktree lock (acquired before the turn, released before the
  terminal state is visible). Codex lanes add `--profile` and
  `--no-user-config` for worktree profiles and MCP fencing.

## Adding a harness

Adapters live in `~/loanlight/crush-conductor/lib/adapters/`. Implement
`{ id, label, availability(), runTurn(options) }` returning the uniform turn
envelope and register it in `registry.mjs`. See docs in the repo README.
