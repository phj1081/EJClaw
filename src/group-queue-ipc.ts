import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export function queueFollowUpMessage(
  groupFolder: string,
  text: string,
): string {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filepath = path.join(inputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
  fs.renameSync(tempPath, filepath);
  return filename;
}

export function writeCloseSentinel(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}
