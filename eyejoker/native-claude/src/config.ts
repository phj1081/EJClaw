import { existsSync, readFileSync, statSync } from "node:fs";
import type { PermissionMode, RouteConfig, RuntimeConfig } from "./types";

interface RawRoute {
  id?: unknown;
  discord_channel_id?: unknown;
  cwd?: unknown;
  lock_key?: unknown;
  model?: unknown;
  fallback_model?: unknown;
  effort?: unknown;
  permission_mode?: unknown;
  require_mention?: unknown;
  instructions?: unknown;
  mixed_agents?: unknown;
}

interface RawConfig {
  owner_id?: unknown;
  allowed_user_ids?: unknown;
  max_concurrent?: unknown;
  max_attempts?: unknown;
  job_timeout_seconds?: unknown;
  routes?: unknown;
}

const permissionModes = new Set<PermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);
const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInt(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function parseRoute(raw: RawRoute): RouteConfig {
  const id = requiredString(raw.id, "route.id");
  const cwd = requiredString(raw.cwd, `route ${id} cwd`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`route ${id} cwd does not exist: ${cwd}`);
  const permissionMode = String(raw.permission_mode ?? "bypassPermissions") as PermissionMode;
  if (!permissionModes.has(permissionMode)) throw new Error(`route ${id} invalid permission_mode`);
  const effort = String(raw.effort ?? "high");
  if (!efforts.has(effort)) throw new Error(`route ${id} invalid effort`);

  const route: RouteConfig = {
    id,
    discordChannelId: requiredString(raw.discord_channel_id, `route ${id} discord_channel_id`),
    cwd,
    model: requiredString(raw.model ?? "claude-fable-5", `route ${id} model`),
    effort: effort as RouteConfig["effort"],
    permissionMode,
    requireMention: raw.require_mention === true,
  };
  if (typeof raw.lock_key === "string" && raw.lock_key.trim()) route.lockKey = raw.lock_key.trim();
  if (typeof raw.fallback_model === "string" && raw.fallback_model.trim()) {
    route.fallbackModel = raw.fallback_model.trim();
  }
  if (typeof raw.instructions === "string" && raw.instructions.trim()) route.instructions = raw.instructions.trim();
  if (typeof raw.mixed_agents === "boolean") route.mixedAgents = raw.mixed_agents;
  return route;
}

export function loadConfig(path: string): RuntimeConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  if (!Array.isArray(raw.routes) || raw.routes.length === 0) throw new Error("routes must be a non-empty array");
  const routes = raw.routes.map((entry) => parseRoute(entry as RawRoute));
  const ids = new Set<string>();
  const channels = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) throw new Error(`duplicate route id: ${route.id}`);
    if (channels.has(route.discordChannelId)) throw new Error(`duplicate Discord channel mapping: ${route.discordChannelId}`);
    ids.add(route.id);
    channels.add(route.discordChannelId);
  }
  const ownerId = requiredString(raw.owner_id, "owner_id");
  const allowed = Array.isArray(raw.allowed_user_ids)
    ? raw.allowed_user_ids.map((value) => requiredString(value, "allowed_user_ids[]"))
    : [];
  if (!allowed.includes(ownerId)) allowed.unshift(ownerId);
  return {
    ownerId,
    allowedUserIds: [...new Set(allowed)],
    maxConcurrent: positiveInt(raw.max_concurrent, 2, "max_concurrent"),
    maxAttempts: positiveInt(raw.max_attempts, 2, "max_attempts"),
    jobTimeoutSeconds: positiveInt(raw.job_timeout_seconds, 21600, "job_timeout_seconds"),
    routes,
  };
}

export function resolveRoute(
  config: Pick<RuntimeConfig, "routes">,
  channelId: string,
  parentChannelId: string | null,
): RouteConfig | null {
  const routedChannel = parentChannelId ?? channelId;
  return config.routes.find((route) => route.discordChannelId === routedChannel) ?? null;
}
