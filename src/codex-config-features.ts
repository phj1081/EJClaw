import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexConfigFeature = 'fast_mode' | 'goals';

export function codexConfigPath(): string {
  const override = process.env.EJCLAW_CODEX_CONFIG_PATH?.trim();
  if (override) return override;
  const home = process.env.EJCLAW_SETTINGS_HOME || os.homedir();
  return path.join(home, '.codex', 'config.toml');
}

export function readCodexFeatureFromContent(
  content: string,
  feature: CodexConfigFeature,
): boolean {
  const lines = content.split('\n');
  let inFeatures = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[features]') {
      inFeatures = true;
      continue;
    }
    if (inFeatures && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      break;
    }
    if (!inFeatures) continue;
    const match = trimmed.match(
      new RegExp(`^${feature}\\s*=\\s*(true|false)$`),
    );
    if (match) return match[1] === 'true';
  }

  return false;
}

export function readCodexFeatureFromFile(
  filePath: string,
  feature: CodexConfigFeature,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  return readCodexFeatureFromContent(
    fs.readFileSync(filePath, 'utf-8'),
    feature,
  );
}

export function writeCodexFeatureInContent(
  content: string,
  feature: CodexConfigFeature,
  value: boolean,
): string {
  const line = `${feature} = ${value}`;
  const re = new RegExp(`^\\s*${feature}\\s*=\\s*(true|false)\\s*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, line);
  }
  if (/^\[features\]/m.test(content)) {
    return content.replace(/^\[features\]\s*$/m, `[features]\n${line}`);
  }
  const trimmed = content.replace(/\s*$/, '');
  if (!trimmed) {
    return `[features]\n${line}\n`;
  }
  return `${trimmed}\n\n[features]\n${line}\n`;
}

export function writeCodexFeatureToFile(
  filePath: string,
  feature: CodexConfigFeature,
  value: boolean,
): void {
  const content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';
  const updated = writeCodexFeatureInContent(content, feature, value);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, updated, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}
