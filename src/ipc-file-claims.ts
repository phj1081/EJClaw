import fs from 'fs';
import path from 'path';

const IPC_PROCESSING_DIRNAME = '.processing';

function buildIpcErrorPath(
  errorDir: string,
  prefix: string,
  fileName: string,
): string {
  return path.join(errorDir, `${prefix}-${Date.now()}-${fileName}`);
}

export function claimIpcFile(filePath: string): string | null {
  const processingDir = path.join(
    path.dirname(filePath),
    IPC_PROCESSING_DIRNAME,
  );
  fs.mkdirSync(processingDir, { recursive: true });

  const claimedPath = path.join(processingDir, path.basename(filePath));
  try {
    fs.renameSync(filePath, claimedPath);
    return claimedPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function quarantineClaimedIpcFiles(
  ipcDir: string,
  errorDir: string,
  prefix: string,
): string[] {
  const processingDir = path.join(ipcDir, IPC_PROCESSING_DIRNAME);
  if (!fs.existsSync(processingDir)) {
    return [];
  }

  const movedPaths: string[] = [];
  for (const file of fs
    .readdirSync(processingDir)
    .filter((f) => f.endsWith('.json'))) {
    const claimedPath = path.join(processingDir, file);
    const errorPath = buildIpcErrorPath(errorDir, prefix, file);
    fs.renameSync(claimedPath, errorPath);
    movedPaths.push(errorPath);
  }

  return movedPaths;
}

export function moveClaimedIpcFileToError(
  claimedPath: string,
  errorDir: string,
  prefix: string,
): void {
  fs.renameSync(
    claimedPath,
    buildIpcErrorPath(errorDir, prefix, path.basename(claimedPath)),
  );
}
