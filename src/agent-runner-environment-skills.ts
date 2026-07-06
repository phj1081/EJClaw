import fs from 'fs';
import path from 'path';

import type { AgentType } from './types.js';
import type { StoredRoomSkillOverride } from './db/rooms.js';

export function syncDirectoryEntries(
  sources: string[],
  destination: string,
): void {
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    for (const entry of fs.readdirSync(source)) {
      const srcPath = path.join(source, entry);
      const dstPath = path.join(destination, entry);
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

export type SkillSyncScope =
  | 'codex-user'
  | 'claude-user'
  | 'runner'
  | 'workdir';

export interface SkillSyncSource {
  dir: string;
  scope: SkillSyncScope;
}

function getDisabledSkillNamesByScope(
  overrides: StoredRoomSkillOverride[] | undefined,
  agentType: AgentType,
): Map<SkillSyncScope, Set<string>> {
  const disabled = new Map<SkillSyncScope, Set<string>>();
  for (const override of overrides ?? []) {
    if (override.agentType !== agentType || override.enabled !== false)
      continue;
    if (
      override.skillScope !== 'codex-user' &&
      override.skillScope !== 'claude-user' &&
      override.skillScope !== 'runner'
    ) {
      continue;
    }
    const names = disabled.get(override.skillScope) ?? new Set<string>();
    names.add(override.skillName);
    disabled.set(override.skillScope, names);
  }
  return disabled;
}

export function hasDisabledSkillOverrides(
  overrides: StoredRoomSkillOverride[] | undefined,
  agentType: AgentType,
): boolean {
  return (overrides ?? []).some(
    (override) =>
      override.agentType === agentType && override.enabled === false,
  );
}

export function syncRoomSkillDirectories(args: {
  sources: SkillSyncSource[];
  destination: string;
  agentType: AgentType;
  overrides?: StoredRoomSkillOverride[];
}): void {
  const disabledNamesByScope = getDisabledSkillNamesByScope(
    args.overrides,
    args.agentType,
  );

  fs.rmSync(args.destination, { recursive: true, force: true });
  fs.mkdirSync(args.destination, { recursive: true });

  for (const source of args.sources) {
    if (!fs.existsSync(source.dir)) continue;
    for (const entry of fs.readdirSync(source.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (disabledNamesByScope.get(source.scope)?.has(entry.name)) continue;

      const srcPath = path.join(source.dir, entry.name);
      const dstPath = path.join(args.destination, entry.name);
      fs.cpSync(srcPath, dstPath, { recursive: true });
    }
  }
}
