#!/usr/bin/env bun
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

const readyFile = process.argv[2];
if (!readyFile) throw new Error("usage: cohort-registry-proxy.ts <ready-file>");
const unixSocket = process.env.COHORT_REGISTRY_UNIX_SOCKET;
const clientOrigin = process.env.COHORT_REGISTRY_CLIENT_ORIGIN;
const upstreamValue = process.env.COHORT_REGISTRY_UPSTREAM ?? "https://registry.npmjs.org/";
if (!clientOrigin) throw new Error("COHORT_REGISTRY_CLIENT_ORIGIN is required");
const upstream = new URL(upstreamValue);
if (
  upstream.protocol !== "https:" &&
  !(upstream.protocol === "http:" && upstream.hostname === "127.0.0.1")
) {
  throw new Error("cohort registry upstream must use HTTPS");
}
const parsedClientOrigin = new URL(clientOrigin);
if (parsedClientOrigin.protocol !== "http:" || parsedClientOrigin.hostname !== "127.0.0.1") {
  throw new Error("cohort registry client origin must be isolated loopback HTTP");
}
const configuredMaxRequests = Number(process.env.COHORT_REGISTRY_MAX_REQUESTS ?? "2048");
const maxRequests = Number.isSafeInteger(configuredMaxRequests) && configuredMaxRequests > 0
  ? configuredMaxRequests
  : 2048;
let requests = 0;

function rewriteTarballUrls(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) rewriteTarballUrls(child);
    return;
  }
  const record = value as Record<string, unknown>;
  const dist = record.dist;
  if (dist && typeof dist === "object") {
    const distRecord = dist as Record<string, unknown>;
    if (typeof distRecord.tarball === "string") {
      const tarball = new URL(distRecord.tarball);
      if (tarball.origin !== upstream.origin) throw new Error("registry metadata referenced a foreign tarball origin");
      distRecord.tarball = new URL(`${tarball.pathname}${tarball.search}`, `${clientOrigin}/`).toString();
    }
  }
  for (const child of Object.values(record)) rewriteTarballUrls(child);
}

if (unixSocket) rmSync(unixSocket, { force: true });
const serveOptions = {
  idleTimeout: 60,
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    requests += 1;
    if (requests > maxRequests) return new Response("registry proxy request limit exceeded", { status: 429 });
    const incoming = new URL(request.url);
    const relative = `${incoming.pathname.replace(/^\/+/, "")}${incoming.search}`;
    const target = new URL(relative, upstream);
    if (target.origin !== upstream.origin) return new Response("invalid registry target", { status: 400 });
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "cookie", "host", "content-length", "transfer-encoding"]) {
      headers.delete(name);
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      redirect: "manual",
    });
    const responseHeaders = new Headers(response.headers);
    for (const name of ["set-cookie", "content-length", "content-encoding", "transfer-encoding"] ) {
      responseHeaders.delete(name);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (request.method !== "HEAD" && contentType.includes("json")) {
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > 64 * 1024 * 1024) return new Response("registry metadata too large", { status: 502 });
      const metadata = await response.json();
      rewriteTarballUrls(metadata);
      const body = JSON.stringify(metadata);
      responseHeaders.set("content-type", "application/json");
      responseHeaders.set("content-length", String(Buffer.byteLength(body)));
      return new Response(body, { status: response.status, headers: responseHeaders });
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  },
};
const server = unixSocket
  ? Bun.serve({ ...serveOptions, unix: unixSocket })
  : Bun.serve({ ...serveOptions, hostname: "127.0.0.1", port: 0 });
if (unixSocket) chmodSync(unixSocket, 0o600);
const temporary = `${readyFile}.${process.pid}.tmp`;
const endpoint = unixSocket ? { socket: unixSocket } : { port: server.port };
writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
renameSync(temporary, readyFile);
chmodSync(readyFile, 0o600);

const stop = () => {
  server.stop(true);
  if (unixSocket) rmSync(unixSocket, { force: true });
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise<never>(() => undefined);
