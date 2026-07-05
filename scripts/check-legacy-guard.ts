/**
 * Legacy compat guard (docs/legacy-compat-removal-spec.md §12).
 *
 * Production code must not reference legacy tables, env aliases, state keys,
 * or read-time repair helpers. Only the explicit migration command files may
 * reference the legacy `registered_groups` layer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface LegacyPattern {
  label: string;
  pattern: RegExp;
  /** Files allowed to match, e.g. the explicit migration command. */
  allowedFiles?: Set<string>;
}

const ROOT = resolve(import.meta.dir, '..');
const SCANNED_ROOTS = ['src/', 'setup/', 'runners/', 'scripts/'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const SELF = 'scripts/check-legacy-guard.ts';

const MIGRATION_COMMAND_FILES = new Set([
  'setup/migrate-room-registrations.ts',
  'setup/legacy-room-registrations.ts',
]);

const LEGACY_PATTERNS: LegacyPattern[] = [
  {
    label: 'legacy registered_groups table/json source',
    pattern: /registered_groups/,
    allowedFiles: MIGRATION_COMMAND_FILES,
  },
  {
    label: 'legacy migration-on-startup helper',
    pattern:
      /migrateJsonStateFromFiles|syncLegacyRegisteredGroupsIntoStoredRooms/,
  },
  {
    label: 'legacy env alias',
    pattern:
      /DISCORD_BOT_TOKEN|DISCORD_CLAUDE_BOT_TOKEN|DISCORD_CODEX_BOT_TOKEN|DISCORD_CODEX_MAIN_BOT_TOKEN|DISCORD_REVIEW_BOT_TOKEN|DISCORD_CODEX_REVIEW_BOT_TOKEN|SESSION_COMMAND_USER_IDS/,
  },
  {
    label: 'legacy router state alias',
    pattern: /last_timestamp|last_agent_timestamp/,
  },
  {
    label: 'read-time repair helper',
    pattern:
      /legacy-rebuilds|resolveStablePairedTaskOwnerAgentType|resolveStableReviewerAgentType/,
  },
];

const violations = scanProductionFiles();
if (violations.length > 0) {
  console.error('legacy guard failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    '\nSee docs/legacy-compat-removal-spec.md. Legacy references are only allowed in explicit migration command files.',
  );
  process.exit(1);
}

console.log('legacy guard OK (no legacy references in production code)');

function scanProductionFiles(): string[] {
  const found: string[] = [];
  for (const filePath of productionFiles()) {
    const lines = readFileSync(resolve(ROOT, filePath), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { label, pattern, allowedFiles } of LEGACY_PATTERNS) {
        if (allowedFiles?.has(filePath)) continue;
        if (pattern.test(line)) {
          found.push(`${filePath}:${index + 1}: ${label}`);
        }
      }
    });
  }
  return found;
}

function productionFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(
      (filePath) =>
        filePath !== SELF &&
        SCANNED_ROOTS.some((root) => filePath.startsWith(root)) &&
        SOURCE_EXTENSIONS.some((ext) => filePath.endsWith(ext)) &&
        !isTestFile(filePath),
    );
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('/test/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx')
  );
}
