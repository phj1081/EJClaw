#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { StateStore } from "./store";
import { renderStatusSnapshot } from "./status-format";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const configPath = resolve(process.env.CLAUDE_NATIVE_CONFIG ?? join(home, ".config/claude-native/routes.json"));
const statePath = resolve(
  process.env.CLAUDE_NATIVE_STATE_DB ?? join(home, ".local/state/claude-native/state.sqlite"),
);
const config = loadConfig(configPath);
const store = new StateStore(statePath);
const [command, ...args] = process.argv.slice(2);

try {
  if (command === "status") {
    console.log(JSON.stringify(renderStatusSnapshot(store.listActive()), null, 2));
  } else if (command === "enqueue") {
    const routeId = args.shift();
    const prompt = args.join(" ").trim();
    if (!routeId || !prompt) throw new Error("usage: admin.ts enqueue <route> <prompt>");
    const route = config.routes.find((candidate) => candidate.id === routeId);
    if (!route) throw new Error(`unknown route: ${routeId}`);
    const id = crypto.randomUUID();
    const job = store.enqueue({
      routeId: route.id,
      lockKey: route.lockKey ?? route.cwd,
      conversationKey: `${route.id}:synthetic:${id}`,
      channelId: route.discordChannelId,
      threadId: null,
      messageId: `synthetic:${id}`,
      authorId: config.ownerId,
      prompt,
      attachmentPaths: [],
    });
    console.log(JSON.stringify({ id: job.id, route: job.routeId, status: job.status, session_id: job.sessionId }));
  } else if (command === "cancel") {
    const key = args[0];
    if (!key) throw new Error("usage: admin.ts cancel <conversation-key>");
    const cancelled = store.cancelByConversation(key);
    console.log(JSON.stringify({ cancelled: cancelled.map((job) => job.id) }));
  } else {
    throw new Error("usage: admin.ts <status|enqueue|cancel> ...");
  }
} finally {
  store.close();
}
