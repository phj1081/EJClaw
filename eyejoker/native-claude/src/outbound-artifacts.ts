import { basename, isAbsolute, resolve } from "node:path";
import { lstatSync } from "node:fs";
import type { OutboundFile } from "./types";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function isSensitiveArtifactName(name: string): boolean {
  const lower = basename(name).toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(lower) ||
    /(^|[._-])(secret|token|credentials?|password|passwd|private[-_]?key|api[-_]?key)([._-]|$)/.test(lower)
  );
}

export interface OutboundArtifactResult {
  body: string;
  files: OutboundFile[];
  errors: string[];
}

export function extractOutboundArtifacts(body: string): OutboundArtifactResult {
  const kept: string[] = [];
  const files: OutboundFile[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const line of body.split("\n")) {
    const match = /^MEDIA:(.+)$/.exec(line.trim());
    if (!match) {
      kept.push(line);
      continue;
    }

    const rawPath = match[1]!.trim();
    if (!isAbsolute(rawPath)) {
      errors.push(`${rawPath}: 절대 경로 아님`);
      continue;
    }
    const path = resolve(rawPath);
    if (seen.has(path)) continue;
    seen.add(path);
    if (files.length >= MAX_FILES) {
      errors.push(`${path}: 최대 ${MAX_FILES}개 초과`);
      continue;
    }
    if (isSensitiveArtifactName(path)) {
      errors.push(`${path}: credential성 파일명 거부`);
      continue;
    }

    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        errors.push(`${path}: 심볼릭 링크 거부`);
      } else if (!stat.isFile()) {
        errors.push(`${path}: 일반 파일 아님`);
      } else if (stat.size > MAX_FILE_BYTES) {
        errors.push(`${path}: 25MB 초과`);
      } else {
        files.push({ path, name: basename(path) });
      }
    } catch {
      errors.push(`${path}: 파일 없음`);
    }
  }

  while (kept.at(-1)?.trim() === "") kept.pop();
  if (errors.length > 0) {
    kept.push("", `첨부 실패:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return { body: kept.join("\n"), files, errors };
}
