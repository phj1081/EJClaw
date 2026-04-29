/**
 * Cross-platform detection utilities for EJClaw setup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export type Platform = 'macos' | 'linux' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';
export type LinuxReadonlySandboxAppArmorSetupResult =
  | 'not-linux'
  | 'not-needed'
  | 'requires-root'
  | 'failed'
  | 'configured';

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  // No display server available
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  // macOS is never headless in practice (even SSH sessions can open URLs)
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    // Check if systemd is PID 1
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Returns true if the command was attempted, false if no method available.
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      // Try xdg-open first, then wslview for WSL
      if (commandExists('xdg-open')) {
        execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      if (isWSL() && commandExists('wslview')) {
        execSync(`wslview ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      // WSL without wslview: try cmd.exe
      if (isWSL()) {
        try {
          execSync(`cmd.exe /c start "" ${JSON.stringify(url)}`, {
            stdio: 'ignore',
          });
          return true;
        } catch {
          // cmd.exe not available
        }
      }
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  return 'none';
}

export function getNodePath(): string {
  try {
    return execSync('command -v bun', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function canUseLinuxBubblewrapReadonlySandbox(
  platform: Platform = getPlatform(),
  commandExistsFn: (name: string) => boolean = commandExists,
  execFn: typeof execSync = execSync,
): boolean {
  if (platform !== 'linux') return false;
  if (!commandExistsFn('bwrap')) return false;

  try {
    execFn('bwrap --ro-bind / / /bin/true', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readProcSysValue(
  procPath: string,
  readFileSyncFn: typeof fs.readFileSync = fs.readFileSync,
): string | null {
  try {
    return readFileSyncFn(procPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function getAppArmorRestrictUnprivilegedUsernsValue(
  readFileSyncFn: typeof fs.readFileSync = fs.readFileSync,
): string | null {
  return readProcSysValue(
    '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    readFileSyncFn,
  );
}

export function ensureLinuxReadonlySandboxAppArmorSupport(options?: {
  platform?: Platform;
  isRootUser?: boolean;
  apparmorRestrictUnprivilegedUserns?: string | null;
  sandboxCapable?: boolean;
  readFileSyncFn?: typeof fs.readFileSync;
  mkdirSyncFn?: typeof fs.mkdirSync;
  writeFileSyncFn?: typeof fs.writeFileSync;
  execFn?: typeof execSync;
}): LinuxReadonlySandboxAppArmorSetupResult {
  const platform = options?.platform ?? getPlatform();
  if (platform !== 'linux') return 'not-linux';
  const readFileSyncFn = options?.readFileSyncFn ?? fs.readFileSync;

  const apparmorRestrictUnprivilegedUserns =
    options?.apparmorRestrictUnprivilegedUserns ??
    getAppArmorRestrictUnprivilegedUsernsValue(readFileSyncFn);
  const sandboxCapable =
    options?.sandboxCapable ?? canUseLinuxBubblewrapReadonlySandbox(platform);

  if (apparmorRestrictUnprivilegedUserns !== '1' || sandboxCapable) {
    return 'not-needed';
  }

  const isRootUser = options?.isRootUser ?? isRoot();
  if (!isRootUser) return 'requires-root';

  const mkdirSyncFn = options?.mkdirSyncFn ?? fs.mkdirSync;
  const writeFileSyncFn = options?.writeFileSyncFn ?? fs.writeFileSync;
  const execFn = options?.execFn ?? execSync;
  const sysctlPath = '/etc/sysctl.d/90-ejclaw-sandbox.conf';
  const sysctlContents =
    '# Managed by EJClaw setup to allow bubblewrap readonly sandboxing.\n' +
    'kernel.apparmor_restrict_unprivileged_userns=0\n';
  let existingContents: string | null;

  try {
    existingContents = readFileSyncFn(sysctlPath, 'utf-8');
  } catch {
    existingContents = null;
  }

  try {
    mkdirSyncFn('/etc/sysctl.d', { recursive: true });
    if (existingContents !== sysctlContents) {
      writeFileSyncFn(sysctlPath, sysctlContents);
    }
    execFn('sysctl -w kernel.apparmor_restrict_unprivileged_userns=0', {
      stdio: 'ignore',
    });

    const appliedValue =
      getAppArmorRestrictUnprivilegedUsernsValue(readFileSyncFn);
    if (appliedValue !== '0') {
      throw new Error(
        `kernel.apparmor_restrict_unprivileged_userns remained ${appliedValue ?? 'unavailable'} after sysctl apply`,
      );
    }
    return 'configured';
  } catch {
    return 'failed';
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
