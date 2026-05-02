import path from 'path';

import { DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import type { RegisteredGroup } from './types.js';

function unique(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

export function resolveRuntimeAttachmentBaseDirs(
  group: RegisteredGroup,
): string[] | undefined {
  const workspaceRoot = isValidGroupFolder(group.folder)
    ? path.resolve(DATA_DIR, 'workspaces', group.folder)
    : null;
  const dirs = unique([group.workDir, workspaceRoot]);
  return dirs.length > 0 ? dirs : undefined;
}
