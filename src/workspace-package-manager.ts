import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export type WorkspacePackageManager = 'bun' | 'pnpm' | 'npm' | 'yarn';

export interface WorkspaceCommandSpec {
  packageManager: WorkspacePackageManager;
  file: string;
  args: string[];
  commandText: string;
}

export interface WorkspaceDependencyInstallResult {
  installed: boolean;
  packageManager: WorkspacePackageManager | null;
  commandText?: string;
}

const COREPACK_PROJECT_SPEC_DISABLED = '0';
const INSTALL_STATE_FILENAME = '.ejclaw-install-state.json';
const NODE_MODULES_NOISE_ENTRIES = new Set([
  '.cache',
  '.vite',
  '.vite-temp',
  INSTALL_STATE_FILENAME,
]);
const LOCKFILE_NAMES = [
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
] as const;

type PackageJsonMetadata = {
  packageManager?: string;
};

function readPackageJsonMetadata(repoDir: string): PackageJsonMetadata | null {
  const packageJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(packageJsonPath, 'utf-8'),
  ) as PackageJsonMetadata;
}

function detectPackageManagerFromField(
  packageManager: string | undefined,
): WorkspacePackageManager | null {
  if (!packageManager) {
    return null;
  }
  if (packageManager.startsWith('bun@')) return 'bun';
  if (packageManager.startsWith('pnpm@')) return 'pnpm';
  if (packageManager.startsWith('npm@')) return 'npm';
  if (packageManager.startsWith('yarn@')) return 'yarn';
  return null;
}

function hasLockfile(repoDir: string, ...names: readonly string[]): boolean {
  return names.some((name) => fs.existsSync(path.join(repoDir, name)));
}

function detectPackageManagersFromLockfiles(
  repoDir: string,
): WorkspacePackageManager[] {
  const detected = new Set<WorkspacePackageManager>();
  if (hasLockfile(repoDir, 'bun.lock', 'bun.lockb')) {
    detected.add('bun');
  }
  if (hasLockfile(repoDir, 'pnpm-lock.yaml')) {
    detected.add('pnpm');
  }
  if (hasLockfile(repoDir, 'package-lock.json', 'npm-shrinkwrap.json')) {
    detected.add('npm');
  }
  if (hasLockfile(repoDir, 'yarn.lock')) {
    detected.add('yarn');
  }
  return [...detected];
}

function detectYarnBerry(
  repoDir: string,
  packageManagerField: string | undefined,
): boolean {
  if (packageManagerField?.startsWith('yarn@')) {
    const version = packageManagerField
      .slice('yarn@'.length)
      .split(/[+-]/, 1)[0];
    const major = Number.parseInt(version.split('.', 1)[0] ?? '', 10);
    if (Number.isFinite(major) && major >= 2) {
      return true;
    }
  }
  return fs.existsSync(path.join(repoDir, '.yarnrc.yml'));
}

function buildCommandText(file: string, args: string[]): string {
  return [file, ...args].join(' ');
}

function buildCorepackCommand(
  packageManager: 'pnpm' | 'yarn',
  args: string[],
): WorkspaceCommandSpec {
  return {
    packageManager,
    file: 'corepack',
    args: [packageManager, ...args],
    commandText: buildCommandText('corepack', [packageManager, ...args]),
  };
}

function findNearestAncestorPackageManager(
  repoDir: string,
): WorkspacePackageManager | null {
  let currentDir = path.dirname(path.resolve(repoDir));

  while (true) {
    const packageManager = detectPackageManagerFromField(
      readPackageJsonMetadata(currentDir)?.packageManager,
    );
    if (packageManager) {
      return packageManager;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function buildWorkspaceCommandEnvironment(
  repoDir: string,
  packageManager: WorkspacePackageManager,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (packageManager !== 'pnpm') {
    return baseEnv;
  }

  const localPackageManager = readPackageJsonMetadata(repoDir)?.packageManager;
  if (typeof localPackageManager === 'string' && localPackageManager.trim()) {
    return baseEnv;
  }

  const ancestorPackageManager = findNearestAncestorPackageManager(repoDir);
  if (!ancestorPackageManager || ancestorPackageManager === packageManager) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    COREPACK_ENABLE_PROJECT_SPEC: COREPACK_PROJECT_SPEC_DISABLED,
  };
}

function computeInstallFingerprint(repoDir: string): string | null {
  const packageJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  const hash = createHash('sha256');
  const fingerprintFiles = [packageJsonPath];
  for (const lockfileName of LOCKFILE_NAMES) {
    const lockfilePath = path.join(repoDir, lockfileName);
    if (fs.existsSync(lockfilePath)) {
      fingerprintFiles.push(lockfilePath);
    }
  }

  for (const filePath of fingerprintFiles.sort()) {
    hash.update(path.basename(filePath));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }

  return hash.digest('hex');
}

function readInstallFingerprint(repoDir: string): string | null {
  const statePath = path.join(repoDir, 'node_modules', INSTALL_STATE_FILENAME);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      fingerprint?: string;
    };
    return typeof state.fingerprint === 'string' ? state.fingerprint : null;
  } catch {
    return null;
  }
}

function writeInstallFingerprint(
  repoDir: string,
  packageManager: WorkspacePackageManager,
  fingerprint: string,
): void {
  const nodeModulesDir = path.join(repoDir, 'node_modules');
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(nodeModulesDir, INSTALL_STATE_FILENAME),
    JSON.stringify(
      {
        packageManager,
        fingerprint,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function hasRunnableNodeModulesTree(repoDir: string): boolean {
  const nodeModulesDir = path.join(repoDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    return false;
  }

  try {
    return fs
      .readdirSync(nodeModulesDir)
      .some((entry) => !NODE_MODULES_NOISE_ENTRIES.has(entry));
  } catch {
    return false;
  }
}

function backfillInstallFingerprintIfPossible(
  repoDir: string,
  packageManager: WorkspacePackageManager,
): boolean {
  if (!hasRunnableNodeModulesTree(repoDir)) {
    return false;
  }

  if (readInstallFingerprint(repoDir)) {
    return false;
  }

  const expectedFingerprint = computeInstallFingerprint(repoDir);
  if (!expectedFingerprint) {
    return false;
  }

  writeInstallFingerprint(repoDir, packageManager, expectedFingerprint);
  return true;
}

export function detectWorkspacePackageManager(
  repoDir: string,
): WorkspacePackageManager | null {
  const packageJson = readPackageJsonMetadata(repoDir);
  if (!packageJson) {
    return null;
  }

  const fromField = detectPackageManagerFromField(packageJson.packageManager);
  if (fromField) {
    return fromField;
  }
  const lockfilePackageManagers = detectPackageManagersFromLockfiles(repoDir);
  if (lockfilePackageManagers.length > 1) {
    throw new Error(
      `Ambiguous package manager for ${repoDir}: multiple lockfiles detected (${lockfilePackageManagers.join(
        ', ',
      )}). Add packageManager to package.json to disambiguate.`,
    );
  }
  if (lockfilePackageManagers.length === 1) {
    return lockfilePackageManagers[0]!;
  }
  return 'npm';
}

export function buildWorkspaceScriptCommand(
  repoDir: string,
  scriptName: string,
): WorkspaceCommandSpec {
  const packageManager = detectWorkspacePackageManager(repoDir) ?? 'npm';

  switch (packageManager) {
    case 'bun':
      return {
        packageManager,
        file: 'bun',
        args: ['run', scriptName],
        commandText: buildCommandText('bun', ['run', scriptName]),
      };
    case 'pnpm':
      return buildCorepackCommand(packageManager, ['run', scriptName]);
    case 'yarn':
      return buildCorepackCommand(packageManager, ['run', scriptName]);
    case 'npm':
      if (scriptName === 'test') {
        return {
          packageManager,
          file: 'npm',
          args: ['test'],
          commandText: 'npm test',
        };
      }
      return {
        packageManager,
        file: 'npm',
        args: ['run', scriptName],
        commandText: buildCommandText('npm', ['run', scriptName]),
      };
  }
}

export function resolveWorkspaceInstallCommand(
  repoDir: string,
): WorkspaceCommandSpec | null {
  const packageJson = readPackageJsonMetadata(repoDir);
  if (!packageJson) {
    return null;
  }

  const packageManager = detectWorkspacePackageManager(repoDir) ?? 'npm';
  switch (packageManager) {
    case 'bun':
      return {
        packageManager,
        file: 'bun',
        args: ['install', '--frozen-lockfile'],
        commandText: buildCommandText('bun', ['install', '--frozen-lockfile']),
      };
    case 'pnpm':
      return buildCorepackCommand(packageManager, [
        'install',
        '--frozen-lockfile',
      ]);
    case 'yarn': {
      const immutableArg = detectYarnBerry(repoDir, packageJson.packageManager)
        ? '--immutable'
        : '--frozen-lockfile';
      return buildCorepackCommand(packageManager, ['install', immutableArg]);
    }
    case 'npm':
      if (hasLockfile(repoDir, 'package-lock.json', 'npm-shrinkwrap.json')) {
        return {
          packageManager,
          file: 'npm',
          args: ['ci'],
          commandText: 'npm ci',
        };
      }
      return {
        packageManager,
        file: 'npm',
        args: ['install'],
        commandText: 'npm install',
      };
  }
}

export function hasInstalledNodeModules(repoDir: string): boolean {
  if (!hasRunnableNodeModulesTree(repoDir)) {
    return false;
  }

  const expectedFingerprint = computeInstallFingerprint(repoDir);
  if (!expectedFingerprint) {
    return false;
  }

  return readInstallFingerprint(repoDir) === expectedFingerprint;
}

export function ensureWorkspaceDependenciesInstalled(
  repoDir: string,
): WorkspaceDependencyInstallResult {
  const packageManager = detectWorkspacePackageManager(repoDir);
  if (!packageManager) {
    return { installed: false, packageManager: null };
  }
  if (hasInstalledNodeModules(repoDir)) {
    return { installed: false, packageManager };
  }

  if (backfillInstallFingerprintIfPossible(repoDir, packageManager)) {
    return { installed: false, packageManager };
  }

  const command = resolveWorkspaceInstallCommand(repoDir);
  if (!command) {
    return { installed: false, packageManager };
  }

  try {
    execFileSync(command.file, command.args, {
      cwd: repoDir,
      env: buildWorkspaceCommandEnvironment(repoDir, command.packageManager),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr.trim()
        : '';
    const stdout =
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout.trim()
        : '';
    const detail =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Failed to install workspace dependencies with "${command.commandText}" in ${repoDir}: ${detail}`,
    );
  }

  const fingerprint = computeInstallFingerprint(repoDir);
  if (fingerprint) {
    writeInstallFingerprint(repoDir, packageManager, fingerprint);
  }

  if (!hasInstalledNodeModules(repoDir)) {
    throw new Error(
      `Workspace dependency install did not produce a usable node_modules tree in ${repoDir}.`,
    );
  }

  return {
    installed: true,
    packageManager,
    commandText: command.commandText,
  };
}

export function detectPnpmStorePath(workspaceDir: string): string | null {
  if (detectWorkspacePackageManager(workspaceDir) !== 'pnpm') {
    return null;
  }
  if (process.env.PNPM_STORE_DIR && fs.existsSync(process.env.PNPM_STORE_DIR)) {
    return process.env.PNPM_STORE_DIR;
  }

  const candidates: Array<[string, string[]]> = [
    ['pnpm', ['store', 'path']],
    ['corepack', ['pnpm', 'store', 'path']],
  ];
  for (const [file, args] of candidates) {
    try {
      const storePath = execFileSync(file, args, {
        cwd: workspaceDir,
        env: buildWorkspaceCommandEnvironment(workspaceDir, 'pnpm'),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      if (storePath && fs.existsSync(storePath)) {
        return storePath;
      }
    } catch {
      // Try the next candidate.
    }
  }

  const defaultStore = path.join(
    process.env.HOME || '',
    '.local',
    'share',
    'pnpm',
    'store',
  );
  return fs.existsSync(defaultStore) ? defaultStore : null;
}
