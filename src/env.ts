import fs from 'fs';
import path from 'path';

// ── Internal cache ──────────────────────────────────────────────

let _cache: Record<string, string> | null = null;

/** Parse the entire .env file into a Record (no key filtering). */
function parseEnvFile(): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────

/** Load (or reload) the .env file into the in-memory cache. */
export function loadEnvFile(): void {
  _cache = parseEnvFile();
}

/**
 * Look up a single env value.
 * Priority: process.env > .env cache > undefined
 */
export function getEnv(key: string): string | undefined {
  if (!_cache) loadEnvFile();
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key];
  }
  if (Object.prototype.hasOwnProperty.call(_cache!, key)) {
    return _cache![key];
  }
  return undefined;
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Now backed by the in-memory cache (disk read happens at most once).
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  if (!_cache) loadEnvFile();

  const result: Record<string, string> = {};
  const wanted = new Set(keys);
  for (const [key, value] of Object.entries(_cache!)) {
    if (wanted.has(key)) result[key] = value;
  }
  return result;
}

export function listConfiguredEnvKeys(): string[] {
  if (!_cache) loadEnvFile();

  return Array.from(
    new Set([...Object.keys(_cache!), ...Object.keys(process.env)]),
  ).sort();
}
