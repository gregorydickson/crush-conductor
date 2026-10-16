import { droidAdapter } from "./droid.mjs";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";

const ADAPTERS = new Map([droidAdapter, claudeAdapter, codexAdapter].map(adapter => [adapter.id, adapter]));

export function getAdapter(id) {
  const adapter = ADAPTERS.get(id);
  if (!adapter) throw new Error(`Unknown harness "${id}". Available: ${[...ADAPTERS.keys()].join(", ")}.`);
  return adapter;
}

export function listAdapters() {
  return [...ADAPTERS.values()];
}
