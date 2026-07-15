#!/usr/bin/env bun
import { chmodSync, renameSync, writeFileSync } from "node:fs";

const portFile = process.argv[2];
if (!portFile) throw new Error("usage: cohort-proxy.ts <port-file>");
const upstreamBase = process.env.ANTHROPIC_BASE_URL;
const upstreamKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
const clientToken = process.env.COHORT_PROXY_CLIENT_TOKEN;
if (!upstreamBase || !upstreamKey || !clientToken) throw new Error("cohort proxy upstream credentials and client token are required");
const configuredMaxRequests = Number(process.env.COHORT_PROXY_MAX_REQUESTS ?? "32");
const maxRequests = Number.isSafeInteger(configuredMaxRequests) && configuredMaxRequests > 0 ? configuredMaxRequests : 32;
const allowedPaths = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
let requests = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const apiKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");
    if (apiKey !== clientToken && authorization !== `Bearer ${clientToken}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const incoming = new URL(request.url);
    if (!allowedPaths.has(incoming.pathname)) return new Response("not found", { status: 404 });
    requests += 1;
    if (requests > maxRequests) return new Response("cohort proxy request limit exceeded", { status: 429 });
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > 10 * 1024 * 1024) return new Response("request too large", { status: 413 });

    const base = upstreamBase.endsWith("/") ? upstreamBase : `${upstreamBase}/`;
    const target = new URL(`${incoming.pathname.replace(/^\//, "")}${incoming.search}`, base);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cookie");
    headers.set("x-api-key", upstreamKey);
    headers.set("authorization", `Bearer ${upstreamKey}`);

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    return fetch(target, init);
  },
});

const temporary = `${portFile}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify({ port: server.port })}\n`, { mode: 0o600 });
renameSync(temporary, portFile);
chmodSync(portFile, 0o600);
console.log(`cohort proxy listening on 127.0.0.1:${server.port}`);

const stop = () => {
  server.stop(true);
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise<never>(() => undefined);
