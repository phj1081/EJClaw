import { describe, it, expect } from 'vitest';

import {
  ensureLinuxReadonlySandboxAppArmorSupport,
  getAppArmorRestrictUnprivilegedUsernsValue,
  canUseLinuxBubblewrapReadonlySandbox,
  getPlatform,
  isWSL,
  isRoot,
  isHeadless,
  hasSystemd,
  getServiceManager,
  commandExists,
  getNodeVersion,
  getNodeMajorVersion,
} from './platform.js';

// --- getPlatform ---

describe('getPlatform', () => {
  it('returns a valid platform string', () => {
    const result = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(result);
  });
});

// --- isWSL ---

describe('isWSL', () => {
  it('returns a boolean', () => {
    expect(typeof isWSL()).toBe('boolean');
  });

  it('checks /proc/version for WSL markers', () => {
    // On non-WSL Linux, should return false
    // On WSL, should return true
    // Just verify it doesn't throw
    const result = isWSL();
    expect(typeof result).toBe('boolean');
  });
});

// --- isRoot ---

describe('isRoot', () => {
  it('returns a boolean', () => {
    expect(typeof isRoot()).toBe('boolean');
  });
});

// --- isHeadless ---

describe('isHeadless', () => {
  it('returns a boolean', () => {
    expect(typeof isHeadless()).toBe('boolean');
  });
});

// --- hasSystemd ---

describe('hasSystemd', () => {
  it('returns a boolean', () => {
    expect(typeof hasSystemd()).toBe('boolean');
  });

  it('checks /proc/1/comm', () => {
    // On systemd systems, should return true
    // Just verify it doesn't throw
    const result = hasSystemd();
    expect(typeof result).toBe('boolean');
  });
});

// --- getServiceManager ---

describe('getServiceManager', () => {
  it('returns a valid service manager', () => {
    const result = getServiceManager();
    expect(['launchd', 'systemd', 'none']).toContain(result);
  });

  it('matches the detected platform', () => {
    const platform = getPlatform();
    const result = getServiceManager();
    if (platform === 'macos') {
      expect(result).toBe('launchd');
    } else {
      expect(['systemd', 'none']).toContain(result);
    }
  });
});

// --- commandExists ---

describe('commandExists', () => {
  it('returns true for node', () => {
    expect(commandExists('node')).toBe(true);
  });

  it('returns false for nonexistent command', () => {
    expect(commandExists('this_command_does_not_exist_xyz_123')).toBe(false);
  });
});

describe('canUseLinuxBubblewrapReadonlySandbox', () => {
  it('returns false outside linux', () => {
    expect(
      canUseLinuxBubblewrapReadonlySandbox('macos', () => {
        throw new Error('should not probe commands on macOS');
      }),
    ).toBe(false);
  });

  it('returns false when bwrap is not installed', () => {
    expect(canUseLinuxBubblewrapReadonlySandbox('linux', () => false)).toBe(
      false,
    );
  });

  it('returns true when linux bwrap readonly probe succeeds', () => {
    expect(
      canUseLinuxBubblewrapReadonlySandbox('linux', () => true, (() =>
        Buffer.from('')) as unknown as typeof import('child_process').execSync),
    ).toBe(true);
  });

  it('returns false when linux bwrap readonly probe fails', () => {
    expect(
      canUseLinuxBubblewrapReadonlySandbox('linux', () => true, (() => {
        throw new Error('permission denied');
      }) as typeof import('child_process').execSync),
    ).toBe(false);
  });
});

describe('getAppArmorRestrictUnprivilegedUsernsValue', () => {
  it('returns null when the proc sysctl path is unavailable', () => {
    expect(
      getAppArmorRestrictUnprivilegedUsernsValue((() => {
        throw new Error('missing');
      }) as typeof import('fs').readFileSync),
    ).toBeNull();
  });

  it('returns the trimmed proc sysctl value', () => {
    expect(
      getAppArmorRestrictUnprivilegedUsernsValue(
        (() => '1\n') as unknown as typeof import('fs').readFileSync,
      ),
    ).toBe('1');
  });
});

describe('ensureLinuxReadonlySandboxAppArmorSupport', () => {
  it('does nothing outside linux', () => {
    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'macos',
      }),
    ).toBe('not-linux');
  });

  it('does nothing when apparmor does not block sandboxing', () => {
    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'linux',
        apparmorRestrictUnprivilegedUserns: '0',
        sandboxCapable: false,
      }),
    ).toBe('not-needed');
  });

  it('does nothing when sandbox is already capable', () => {
    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'linux',
        apparmorRestrictUnprivilegedUserns: '1',
        sandboxCapable: true,
      }),
    ).toBe('not-needed');
  });

  it('requires root when linux apparmor blocks sandboxing', () => {
    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'linux',
        apparmorRestrictUnprivilegedUserns: '1',
        sandboxCapable: false,
        isRootUser: false,
      }),
    ).toBe('requires-root');
  });

  it('writes and applies the sysctl when running as root', () => {
    const writes: string[] = [];
    const commands: string[] = [];
    const fileContents = new Map<string, string>([
      ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n'],
    ]);

    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'linux',
        apparmorRestrictUnprivilegedUserns: '1',
        sandboxCapable: false,
        isRootUser: true,
        readFileSyncFn: ((target) => {
          const value = fileContents.get(String(target));
          if (value == null) throw new Error('missing');
          return value;
        }) as typeof import('fs').readFileSync,
        mkdirSyncFn: (() => undefined) as typeof import('fs').mkdirSync,
        writeFileSyncFn: ((target, contents) => {
          const normalizedTarget = String(target);
          const normalizedContents = String(contents);
          writes.push(`${normalizedTarget}\n${normalizedContents}`);
          fileContents.set(normalizedTarget, normalizedContents);
        }) as typeof import('fs').writeFileSync,
        execFn: ((command) => {
          commands.push(String(command));
          fileContents.set(
            '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
            '0\n',
          );
          return Buffer.from('');
        }) as typeof import('child_process').execSync,
      }),
    ).toBe('configured');

    expect(writes[0]).toContain('/etc/sysctl.d/90-ejclaw-sandbox.conf');
    expect(writes[0]).toContain(
      'kernel.apparmor_restrict_unprivileged_userns=0',
    );
    expect(commands).toContain(
      'sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    );
  });

  it('skips rewriting an already-correct sysctl file but still applies and verifies', () => {
    const writes: string[] = [];
    const commands: string[] = [];
    const fileContents = new Map<string, string>([
      [
        '/etc/sysctl.d/90-ejclaw-sandbox.conf',
        '# Managed by EJClaw setup to allow bubblewrap readonly sandboxing.\n' +
          'kernel.apparmor_restrict_unprivileged_userns=0\n',
      ],
      ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n'],
    ]);

    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'linux',
        apparmorRestrictUnprivilegedUserns: '1',
        sandboxCapable: false,
        isRootUser: true,
        readFileSyncFn: ((target) => {
          const value = fileContents.get(String(target));
          if (value == null) throw new Error('missing');
          return value;
        }) as typeof import('fs').readFileSync,
        mkdirSyncFn: (() => undefined) as typeof import('fs').mkdirSync,
        writeFileSyncFn: ((target, contents) => {
          writes.push(`${String(target)}\n${String(contents)}`);
        }) as typeof import('fs').writeFileSync,
        execFn: ((command) => {
          commands.push(String(command));
          fileContents.set(
            '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
            '0\n',
          );
          return Buffer.from('');
        }) as typeof import('child_process').execSync,
      }),
    ).toBe('configured');

    expect(writes).toHaveLength(0);
    expect(commands).toContain(
      'sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    );
  });

  it('returns failed when the sysctl apply does not take effect', () => {
    const fileContents = new Map<string, string>([
      ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n'],
    ]);

    expect(
      ensureLinuxReadonlySandboxAppArmorSupport({
        platform: 'linux',
        apparmorRestrictUnprivilegedUserns: '1',
        sandboxCapable: false,
        isRootUser: true,
        readFileSyncFn: ((target: import('fs').PathOrFileDescriptor) => {
          const value = fileContents.get(String(target));
          if (value == null) throw new Error('missing');
          return value;
        }) as unknown as typeof import('fs').readFileSync,
        mkdirSyncFn: (() => undefined) as typeof import('fs').mkdirSync,
        writeFileSyncFn: (() => undefined) as typeof import('fs').writeFileSync,
        execFn: (() =>
          Buffer.from(
            '',
          )) as unknown as typeof import('child_process').execSync,
      }),
    ).toBe('failed');
  });
});

// --- getNodeVersion ---

describe('getNodeVersion', () => {
  it('returns a version string', () => {
    const version = getNodeVersion();
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// --- getNodeMajorVersion ---

describe('getNodeMajorVersion', () => {
  it('returns at least 20', () => {
    const major = getNodeMajorVersion();
    expect(major).not.toBeNull();
    expect(major!).toBeGreaterThanOrEqual(20);
  });
});
