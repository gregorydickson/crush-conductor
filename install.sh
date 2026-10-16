#!/usr/bin/env bash
# Install crush-conductor: skill symlink for Crush (+ Claude Code via .agents)
# and a PATH symlink for the CLI. Re-running is safe and idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="conductor"

link() {
  local target="$1" link_path="$2"
  if [[ -L "$link_path" || -e "$link_path" ]]; then
    if [[ "$(readlink "$link_path" 2>/dev/null || true)" == "$target" ]]; then
      echo "ok (existing): $link_path"
      return
    fi
    echo "SKIP (exists, not ours): $link_path" >&2
    return
  fi
  ln -s "$target" "$link_path"
  echo "linked: $link_path -> $target"
}

# 1. Skill: ~/.agents/skills is a default skill path for Crush (and the
#    cross-harness agents convention), so one install serves every harness.
AGENTS_SKILLS="$HOME/.agents/skills"
mkdir -p "$AGENTS_SKILLS"
link "$REPO_ROOT/skills/$SKILL_NAME" "$AGENTS_SKILLS/$SKILL_NAME"

# 2. CLI on PATH when ~/.local/bin exists and is on PATH.
if [[ -d "$HOME/.local/bin" ]] && [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  link "$REPO_ROOT/bin/conductor.mjs" "$HOME/.local/bin/conductor"
  chmod +x "$REPO_ROOT/bin/conductor.mjs"
else
  echo "note: ~/.local/bin missing or off PATH; invoke via: node $REPO_ROOT/bin/conductor.mjs"
fi

# 3. Health check.
node "$REPO_ROOT/bin/conductor.mjs" claude doctor || true
node "$REPO_ROOT/bin/conductor.mjs" droid doctor || true
echo "done."
