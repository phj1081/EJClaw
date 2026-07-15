#!/usr/bin/env bun
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

const portFile = process.argv[2];
if (!portFile) throw new Error("usage: cohort-proxy.ts <port-file>");
const upstreamBase = process.env.ANTHROPIC_BASE_URL;
const upstreamKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
const clientToken = process.env.COHORT_PROXY_CLIENT_TOKEN;
const unixSocket = process.env.COHORT_PROXY_UNIX_SOCKET;
if (!upstreamBase || !upstreamKey || !clientToken) throw new Error("cohort proxy upstream credentials and client token are required");
const configuredMaxRequests = Number(process.env.COHORT_PROXY_MAX_REQUESTS ?? "32");
const maxRequests = Number.isSafeInteger(configuredMaxRequests) && configuredMaxRequests > 0 ? configuredMaxRequests : 32;
const allowedPaths = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const maxRequestBytes = 10 * 1024 * 1024;
let requests = 0;

if (unixSocket) rmSync(unixSocket, { force: true });
const serveOptions = {
  idleTimeout: 60,
  async fetch(request: Request) {
    const apiKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");
    if (apiKey !== clientToken && authorization !== `Bearer ${clientToken}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const incoming = new URL(request.url);
    if (!allowedPaths.has(incoming.pathname)) return new Response("not found", { status: 404 });
    requests += 1;
    if (requests > maxRequests) return new Response("cohort proxy request limit exceeded", { status: 429 });
    const rawContentLength = request.headers.get("content-length");
    if (rawContentLength !== null && !/^\d+$/.test(rawContentLength)) {
      return new Response("invalid content length", { status: 400 });
    }
    if (rawContentLength !== null && Number(rawContentLength) > maxRequestBytes) {
      return new Response("request too large", { status: 413 });
    }

    let boundedBody: Uint8Array | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxRequestBytes) {
          await reader.cancel("request too large");
          return new Response("request too large", { status: 413 });
        }
        chunks.push(value);
      }
      boundedBody = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        boundedBody.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    const base = upstreamBase.endsWith("/") ? upstreamBase : `${upstreamBase}/`;
    const target = new URL(`${incoming.pathname.replace(/^\//, "")}${incoming.search}`, base);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("cookie");
    headers.set("x-api-key", upstreamKey);
    headers.set("authorization", `Bearer ${upstreamKey}`);
    if (boundedBody) headers.set("content-length", String(boundedBody.byteLength));

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (boundedBody) init.body = new Blob([boundedBody.buffer as ArrayBuffer]);
    return fetch(target, init);
  },
};
const server = unixSocket
  ? Bun.serve({ ...serveOptions, unix: unixSocket })
  : Bun.serve({ ...serveOptions, hostname: "127.0.0.1", port: 0 });
if (unixSocket) chmodSync(unixSocket, 0o600);

const temporary = `${portFile}.${process.pid}.tmp`;
const endpoint = unixSocket ? { socket: unixSocket } : { port: server.port };
writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
renameSync(temporary, portFile);
chmodSync(portFile, 0o600);
console.log(unixSocket ? `cohort proxy listening on ${unixSocket}` : `cohort proxy listening on 127.0.0.1:${server.port}`);

const stop = () => {
  server.stop(true);
  if (unixSocket) rmSync(unixSocket, { force: true });
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise<never>(() => undefined);
