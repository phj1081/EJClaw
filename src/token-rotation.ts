import fs from 'fs';
import os from 'os';
import path from 'path';

const HOST_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_ACCOUNTS_DIR = path.join(os.homedir(), '.claude-accounts');

let activeIndex = 0;
const rateLimitedAccounts = new Set<number>();

function listClaudeAccounts(): string[] {
  if (!fs.existsSync(CLAUDE_ACCOUNTS_DIR)) return [];

  return fs
    .readdirSync(CLAUDE_ACCOUNTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((a, b) => Number(a.name) - Number(b.name))
    .map((entry) => path.join(CLAUDE_ACCOUNTS_DIR, entry.name));
}

function copyIfExists(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function syncHostClaudeAccount(accountDir: string): void {
  copyIfExists(
    path.join(accountDir, '.credentials.json'),
    path.join(HOST_CLAUDE_DIR, '.credentials.json'),
  );
  copyIfExists(
    path.join(accountDir, 'settings.json'),
    path.join(HOST_CLAUDE_DIR, 'settings.json'),
  );
}

export function getTokenCount(): number {
  const accounts = listClaudeAccounts();
  return accounts.length > 0 ? accounts.length : 1;
}

export function rotateToken(_reason?: string): boolean {
  const accounts = listClaudeAccounts();
  if (accounts.length <= 1) return false;

  rateLimitedAccounts.add(activeIndex);

  const candidates = accounts.map((_, index) => index);
  const nextIndex =
    candidates.find(
      (index) => index !== activeIndex && !rateLimitedAccounts.has(index),
    ) ?? candidates.find((index) => index !== activeIndex);

  if (nextIndex === undefined) return false;

  syncHostClaudeAccount(accounts[nextIndex]);
  activeIndex = nextIndex;
  return true;
}

export function markTokenHealthy(): void {
  rateLimitedAccounts.delete(activeIndex);
}
