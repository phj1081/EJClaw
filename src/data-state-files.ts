import fs from 'fs';
import path from 'path';

const ALLOWED_DATA_JSON_PATTERNS = [
  /^token-rotation-state\.json$/,
  /^codex-rotation-state\.json$/,
  /^codex-warmup-state\.json$/,
  /^claude-usage-cache\.json$/,
  /^restart-context\..+\.json$/,
];

function isAllowedDataStateJson(filename: string): boolean {
  return ALLOWED_DATA_JSON_PATTERNS.some((pattern) => pattern.test(filename));
}

export function listUnexpectedDataStateFiles(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) {
    return [];
  }

  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((filename) => path.extname(filename) === '.json')
    .filter((filename) => !isAllowedDataStateJson(filename))
    .sort();
}
