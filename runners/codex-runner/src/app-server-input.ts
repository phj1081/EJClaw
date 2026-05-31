import fs from 'fs';

import { extractImageTagPaths } from 'ejclaw-runners-shared';

import type { AppServerInputItem } from './app-server-client.js';

export function parseAppServerInput(
  text: string,
  log: (message: string) => void = () => undefined,
): AppServerInputItem[] {
  const { cleanText, imagePaths } = extractImageTagPaths(text);
  const input: AppServerInputItem[] = [];

  if (cleanText) {
    input.push({ type: 'text', text: cleanText });
  }

  for (const imgPath of imagePaths) {
    if (fs.existsSync(imgPath)) {
      input.push({ type: 'localImage', path: imgPath });
      log(`Adding image input: ${imgPath}`);
    } else {
      log(`Image not found, skipping: ${imgPath}`);
    }
  }

  if (input.length === 0) {
    input.push({ type: 'text', text });
  }

  return input;
}
