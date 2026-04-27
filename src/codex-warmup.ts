import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { AppConfig } from './config/schema.js';
import {
  getAllCodexAccounts,
  getCodexAuthPath,
} from './codex-token-rotation.js';
import { logger } from './logger.js';

export type CodexWarmupConfig = AppConfig['codexWarmup'];

interface CodexWarmupAccountState {
  lastWarmupAt?: string;
  lastAttemptAt?: string;
  lastErrorAt?: string;
  zeroUsageWarmupUntil?: string;
  failures?: number;
}

interface CodexWarmupState {
  lastWarmupAt?: string;
  lastAttemptAt?: string;
  disabledUntil?: string;
  consecutiveFailures?: number;
  accounts?: Record<string, CodexWarmupAccountState>;
}

interface CodexWarmupRuntimeOptions {
  nowMs?: number;
  statePath?: string;
  shouldSkip?: () => boolean;
}

export type CodexWarmupCycleResult =
  | { status: 'disabled' }
  | { status: 'skipped'; reason: string }
  | { status: 'warmed'; accountIndex: number }
  | { status: 'failed'; accountIndex: number; reason: string };

const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'codex-warmup-state.json');
const DEFAULT_ZERO_USAGE_WARMUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function parseTimestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readWarmupState(statePath: string): CodexWarmupState {
  try {
    if (!fs.existsSync(statePath)) return { accounts: {} };
    const parsed = JSON.parse(
      fs.readFileSync(statePath, 'utf8'),
    ) as CodexWarmupState;
    if (!parsed.accounts || typeof parsed.accounts !== 'object') {
      parsed.accounts = {};
    }
    return parsed;
  } catch (err) {
    logger.warn(
      { err, statePath },
      'Failed to read Codex warm-up state; starting fresh',
    );
    return { accounts: {} };
  }
}

function writeWarmupState(statePath: string, state: CodexWarmupState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${statePath}.tmp`, statePath);
}

function getPreferredCodexPathEntries(): string[] {
  const entries = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  if (process.versions.bun || path.basename(process.execPath) === 'bun') {
    entries.push(path.join(os.homedir(), '.hermes', 'node', 'bin'));
  }
  return [...new Set(entries)];
}

function resolveCodexBinary(): string {
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  return fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';
}

function ensureAccountState(
  state: CodexWarmupState,
  accountIndex: number,
): CodexWarmupAccountState {
  state.accounts ??= {};
  const key = String(accountIndex);
  state.accounts[key] ??= {};
  return state.accounts[key];
}

function selectWarmupCandidate(
  config: CodexWarmupConfig,
  state: CodexWarmupState,
  nowMs: number,
): { accountIndex: number; zeroUsageWarmupUntil: string } | { reason: string } {
  const disabledUntilMs = parseTimestamp(state.disabledUntil);
  if (disabledUntilMs != null && disabledUntilMs > nowMs) {
    return { reason: 'disabled_cooldown' };
  }

  const lastGlobalWarmupMs = parseTimestamp(state.lastWarmupAt);
  if (
    lastGlobalWarmupMs != null &&
    config.staggerMs > 0 &&
    nowMs - lastGlobalWarmupMs < config.staggerMs
  ) {
    return { reason: 'stagger_wait' };
  }

  const accounts = getAllCodexAccounts();
  if (accounts.length === 0) return { reason: 'no_accounts' };

  for (const account of accounts) {
    if (account.isRateLimited) continue;
    if (typeof account.cachedUsagePct !== 'number') continue;
    if (typeof account.cachedUsageD7Pct !== 'number') continue;
    if (account.cachedUsagePct > config.maxUsagePct) continue;
    if (account.cachedUsageD7Pct > config.maxD7UsagePct) continue;

    const accountState = state.accounts?.[String(account.index)];
    const zeroUsageWarmupUntilMs = parseTimestamp(
      accountState?.zeroUsageWarmupUntil,
    );
    if (zeroUsageWarmupUntilMs != null && zeroUsageWarmupUntilMs > nowMs) {
      continue;
    }

    const lastWarmupMs = parseTimestamp(accountState?.lastWarmupAt);
    if (lastWarmupMs != null && nowMs - lastWarmupMs < config.minIntervalMs) {
      continue;
    }

    const resetD7Ms = parseTimestamp(account.resetD7At);
    const zeroUsageWarmupUntilMsForState =
      resetD7Ms != null && resetD7Ms > nowMs
        ? resetD7Ms
        : nowMs + DEFAULT_ZERO_USAGE_WARMUP_WINDOW_MS;

    return {
      accountIndex: account.index,
      zeroUsageWarmupUntil: new Date(
        zeroUsageWarmupUntilMsForState,
      ).toISOString(),
    };
  }

  return { reason: 'no_eligible_accounts' };
}

function runCodexWarmupCommand(
  accountDir: string,
  config: CodexWarmupConfig,
): Promise<{ ok: boolean; reason: string }> {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    os.tmpdir(),
    '-m',
    config.model,
    config.prompt,
  ];

  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CODEX_HOME: accountDir,
    PATH: [...getPreferredCodexPathEntries(), process.env.PATH || '']
      .filter(Boolean)
      .join(path.delimiter),
  };

  return new Promise((resolve) => {
    let done = false;
    let proc: ChildProcess | null = null;
    let stderr = '';
    const finish = (result: { ok: boolean; reason: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (proc && result.reason === 'timeout') {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout' }),
      config.commandTimeoutMs,
    );

    try {
      proc = spawn(resolveCodexBinary(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to spawn Codex warm-up command');
      finish({ ok: false, reason: 'spawn_error' });
      return;
    }

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    proc.on('error', (err) => {
      logger.warn({ err }, 'Codex warm-up process error');
      finish({ ok: false, reason: 'process_error' });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, reason: 'ok' });
        return;
      }
      logger.warn(
        { exitCode: code, stderr: stderr.trim() || undefined },
        'Codex warm-up command failed',
      );
      finish({ ok: false, reason: `exit_${code ?? 'unknown'}` });
    });
  });
}

export async function runCodexWarmupCycle(
  config: CodexWarmupConfig,
  runtime: CodexWarmupRuntimeOptions = {},
): Promise<CodexWarmupCycleResult> {
  if (!config.enabled) return { status: 'disabled' };
  if (runtime.shouldSkip?.())
    return { status: 'skipped', reason: 'runtime_busy' };

  const nowMs = runtime.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const statePath = runtime.statePath ?? DEFAULT_STATE_FILE;
  const state = readWarmupState(statePath);
  const selected = selectWarmupCandidate(config, state, nowMs);
  if ('reason' in selected) {
    return { status: 'skipped', reason: selected.reason };
  }

  const authPath = getCodexAuthPath(selected.accountIndex);
  if (!authPath || !fs.existsSync(authPath)) {
    return { status: 'skipped', reason: 'missing_auth' };
  }
  const accountDir = path.dirname(authPath);
  const accountState = ensureAccountState(state, selected.accountIndex);
  state.lastAttemptAt = nowIso;
  accountState.lastAttemptAt = nowIso;

  logger.info(
    { account: selected.accountIndex + 1, model: config.model },
    'Starting Codex warm-up prompt',
  );
  const result = await runCodexWarmupCommand(accountDir, config);

  if (result.ok) {
    state.lastWarmupAt = nowIso;
    state.consecutiveFailures = 0;
    delete state.disabledUntil;
    accountState.lastWarmupAt = nowIso;
    accountState.zeroUsageWarmupUntil = selected.zeroUsageWarmupUntil;
    accountState.failures = 0;
    writeWarmupState(statePath, state);
    logger.info(
      { account: selected.accountIndex + 1 },
      'Codex warm-up prompt completed',
    );
    return { status: 'warmed', accountIndex: selected.accountIndex };
  }

  state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
  accountState.lastErrorAt = nowIso;
  accountState.failures = (accountState.failures ?? 0) + 1;
  if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
    state.disabledUntil = new Date(
      nowMs + config.failureCooldownMs,
    ).toISOString();
  }
  writeWarmupState(statePath, state);
  logger.warn(
    {
      account: selected.accountIndex + 1,
      reason: result.reason,
      consecutiveFailures: state.consecutiveFailures,
      disabledUntil: state.disabledUntil,
    },
    'Codex warm-up prompt failed',
  );
  return {
    status: 'failed',
    accountIndex: selected.accountIndex,
    reason: result.reason,
  };
}
