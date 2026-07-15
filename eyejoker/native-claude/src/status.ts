#!/usr/bin/env bun
import { resolve } from "node:path";
import { StateStore } from "./store";
import { formatDiscordStatus, renderStatusSnapshot } from "./status-format";

const statePath = resolve(
  process.env.CLAUDE_NATIVE_STATE_DB ?? `${process.env.HOME}/.local/state/claude-native/state.sqlite`,
);
const store = new StateStore(statePath);
try {
  const snapshot = renderStatusSnapshot(store.listActive());
  if (process.argv.includes("--json")) console.log(JSON.stringify(snapshot));
  else console.log(formatDiscordStatus(snapshot));
} finally {
  store.close();
}
