import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { isRoot } from './platform.js';
import type { ServiceDef } from './service-defs.js';

export type ServiceStatus =
  | 'running'
  | 'stopped'
  | 'not_found'
  | 'not_configured';

export interface ServiceCheck {
  name: string;
  status: ServiceStatus;
}

export interface ServiceCheckOptions {
  detectArtifacts?: boolean;
  homeDir?: string;
}

export type SystemdScope = 'system' | 'user';

export function checkLaunchdService(label: string): ServiceStatus {
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    if (output.includes(label)) {
      const line = output
        .split('\n')
        .find((candidate) => candidate.includes(label));
      if (line) {
        const pidField = line.trim().split(/\s+/)[0];
        return pidField !== '-' && pidField ? 'running' : 'stopped';
      }
    }
  } catch {
    // launchctl not available
  }
  return 'not_found';
}

function getLaunchdPlistPath(homeDir: string, launchdLabel: string): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
}

export function checkLaunchdServiceArtifact(
  label: string,
  plistPath: string,
): ServiceStatus {
  const status = checkLaunchdService(label);
  if (status !== 'not_found') {
    return status;
  }
  return fs.existsSync(plistPath) ? 'stopped' : 'not_found';
}

export function checkSystemdServiceInScope(
  name: string,
  scope: SystemdScope,
): ServiceStatus {
  const prefix = scope === 'system' ? 'systemctl' : 'systemctl --user';
  try {
    execSync(`${prefix} is-active ${name}`, { stdio: 'ignore' });
    return 'running';
  } catch {
    try {
      const output = execSync(`${prefix} list-unit-files`, {
        encoding: 'utf-8',
      });
      if (output.includes(name)) {
        return 'stopped';
      }
    } catch {
      // systemctl not available
    }
  }
  return 'not_found';
}

export function checkSystemdService(name: string): ServiceStatus {
  return checkSystemdServiceInScope(name, isRoot() ? 'system' : 'user');
}

export function checkNohupService(
  projectRoot: string,
  serviceName: string,
): ServiceStatus {
  const pidFile = path.join(projectRoot, `${serviceName}.pid`);
  if (fs.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = Number(raw);
      if (raw && Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        return 'running';
      }
    } catch {
      return 'stopped';
    }
  }
  return 'not_found';
}

export function checkNohupServiceArtifact(
  projectRoot: string,
  serviceName: string,
): ServiceStatus {
  const status = checkNohupService(projectRoot, serviceName);
  if (status !== 'not_found') {
    return status;
  }
  const wrapperPath = path.join(projectRoot, `start-${serviceName}.sh`);
  return fs.existsSync(wrapperPath) ? 'stopped' : 'not_found';
}

export function checkService(
  projectRoot: string,
  serviceManager: 'launchd' | 'systemd' | 'none',
  serviceName: string,
  launchdLabel: string,
  options: ServiceCheckOptions = {},
): ServiceStatus {
  if (serviceManager === 'launchd') {
    if (options.detectArtifacts && options.homeDir) {
      return checkLaunchdServiceArtifact(
        launchdLabel,
        getLaunchdPlistPath(options.homeDir, launchdLabel),
      );
    }
    return checkLaunchdService(launchdLabel);
  }
  if (serviceManager === 'systemd') {
    return checkSystemdService(serviceName);
  }
  if (options.detectArtifacts) {
    return checkNohupServiceArtifact(projectRoot, serviceName);
  }
  return checkNohupService(projectRoot, serviceName);
}

export function getServiceChecks(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  serviceManager: 'launchd' | 'systemd' | 'none',
  options: ServiceCheckOptions = {},
): ServiceCheck[] {
  return serviceDefs.map((def) => ({
    name: def.name,
    status: checkService(
      projectRoot,
      serviceManager,
      def.name,
      def.launchdLabel,
      options,
    ),
  }));
}
