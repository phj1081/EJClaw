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

export function checkLaunchdService(label: string): ServiceStatus {
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    if (output.includes(label)) {
      const line = output.split('\n').find((candidate) => candidate.includes(label));
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

export function checkSystemdService(name: string): ServiceStatus {
  const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
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

export function checkService(
  projectRoot: string,
  serviceManager: 'launchd' | 'systemd' | 'none',
  serviceName: string,
  launchdLabel: string,
): ServiceStatus {
  if (serviceManager === 'launchd') {
    return checkLaunchdService(launchdLabel);
  }
  if (serviceManager === 'systemd') {
    return checkSystemdService(serviceName);
  }
  return checkNohupService(projectRoot, serviceName);
}

export function getServiceChecks(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  serviceManager: 'launchd' | 'systemd' | 'none',
): ServiceCheck[] {
  return serviceDefs.map((def) => ({
    name: def.name,
    status: checkService(
      projectRoot,
      serviceManager,
      def.name,
      def.launchdLabel,
    ),
  }));
}
