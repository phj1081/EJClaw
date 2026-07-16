#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { buildScheduledJobPrompt, readSecurePromptFile, scheduleIdentity } from "./admin-utils";
import { loadConfig } from "./config";
import { conversationLockKey } from "./conversation-workspace";
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

function enqueue(
  routeId: string,
  prompt: string,
  identity: { messageId: string; conversationKey: string },
  attachmentPaths: string[] = [],
): void {
  const route = config.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`unknown route: ${routeId}`);
  const job = store.enqueue({
    routeId: route.id,
    lockKey: conversationLockKey(route, identity.conversationKey),
    conversationKey: identity.conversationKey,
    channelId: route.discordChannelId,
    threadId: null,
    messageId: identity.messageId,
    authorId: config.ownerId,
    prompt,
    attachmentPaths,
  });
  console.log(JSON.stringify({ id: job.id, route: job.routeId, status: job.status, session_id: job.sessionId }));
}

try {
  if (command === "status") {
    console.log(JSON.stringify(renderStatusSnapshot(store.listActive()), null, 2));
  } else if (command === "enqueue") {
    const routeId = args.shift();
    let conversationId = "admin";
    if (args[0] === "--conversation") {
      args.shift();
      conversationId = args.shift()?.trim() ?? "";
    }
    const prompt = args.join(" ").trim();
    if (!routeId || !conversationId || !prompt) {
      throw new Error("usage: admin.ts enqueue <route> [--conversation <id>] <prompt>");
    }
    const id = crypto.randomUUID();
    enqueue(routeId, prompt, {
      conversationKey: `${routeId}:synthetic:${conversationId}`,
      messageId: `synthetic:${id}`,
    });
  } else if (command === "enqueue-file") {
    const [routeId, promptPath] = args;
    if (!routeId || !promptPath || args.length !== 2) {
      throw new Error("usage: admin.ts enqueue-file <route> <mode-600-prompt-file>");
    }
    const scheduleKey = process.env.CLAUDE_NATIVE_SCHEDULE_KEY;
    if (!scheduleKey) throw new Error("CLAUDE_NATIVE_SCHEDULE_KEY is required");
    const identity = scheduleIdentity(
      routeId,
      scheduleKey,
      new Date(),
      process.env.CLAUDE_NATIVE_SCHEDULE_TZ ?? "Asia/Seoul",
    );
    const absolute = resolve(promptPath);
    const built = buildScheduledJobPrompt(absolute, readSecurePromptFile(absolute));
    enqueue(routeId, built.prompt, identity, built.attachmentPaths);
  } else if (command === "cancel") {
    const key = args[0];
    if (!key) throw new Error("usage: admin.ts cancel <conversation-key>");
    const cancelled = store.cancelByConversation(key);
    console.log(JSON.stringify({ cancelled: cancelled.map((job) => job.id) }));
  } else {
    throw new Error("usage: admin.ts <status|enqueue|enqueue-file|cancel> ...");
  }
} finally {
  store.close();
}
