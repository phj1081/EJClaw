import { execFileSync } from 'child_process';

export function resolveCanonicalSourceRef(workDir: string): string {
  const treeHash = resolveCanonicalTreeHash(workDir);
  return treeHash || 'HEAD';
}

function resolveCanonicalTreeHash(workDir: string): string | null {
  try {
    const treeHash = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return treeHash || null;
  } catch {
    return null;
  }
}

export function hasCodeChangesSinceRef(
  workDir: string,
  sourceRef: string | null | undefined,
): boolean | null {
  if (!sourceRef) return null;
  try {
    execFileSync('git', ['diff', '--quiet', sourceRef, 'HEAD'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return false;
  } catch (error) {
    const exitCode =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : null;
    if (exitCode === 1) {
      return true;
    }
    return null;
  }
}
