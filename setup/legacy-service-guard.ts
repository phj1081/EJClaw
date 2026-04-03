import os from 'os';
import path from 'path';

import type { ServiceManager } from './platform.js';
import { getLegacyServiceDefs } from './service-defs.js';
import {
  checkLaunchdServiceArtifact,
  checkNohupServiceArtifact,
  checkSystemdServiceInScope,
  type ServiceCheck,
  type SystemdScope,
} from './verify-services.js';

type LegacySource = 'launchd' | 'systemd-system' | 'systemd-user' | 'nohup';

export interface LegacyServiceIssue extends ServiceCheck {
  sources: LegacySource[];
}

function summarizeLegacyStatus(statuses: ServiceCheck['status'][]): ServiceCheck['status'] {
  if (statuses.includes('running')) {
    return 'running';
  }
  if (statuses.includes('stopped')) {
    return 'stopped';
  }
  return 'not_found';
}

export function detectLegacyServiceIssues(
  projectRoot: string,
  serviceManager: ServiceManager,
  homeDir = os.homedir(),
): LegacyServiceIssue[] {
  return getLegacyServiceDefs(projectRoot)
    .map((def) => {
      if (serviceManager === 'launchd') {
        const status = checkLaunchdServiceArtifact(
          def.launchdLabel,
          path.join(homeDir, 'Library', 'LaunchAgents', `${def.launchdLabel}.plist`),
        );
        if (status === 'not_found') return null;
        return {
          name: def.name,
          status,
          sources: ['launchd'] as LegacySource[],
        };
      }

      if (serviceManager === 'systemd') {
        const scopedChecks: Array<{ source: LegacySource; status: ServiceCheck['status'] }> = [
          {
            source: 'systemd-system',
            status: checkSystemdServiceInScope(def.name, 'system'),
          },
          {
            source: 'systemd-user',
            status: checkSystemdServiceInScope(def.name, 'user'),
          },
          {
            source: 'nohup',
            status: checkNohupServiceArtifact(projectRoot, def.name),
          },
        ];
        const detected = scopedChecks.filter(
          (current) => current.status !== 'not_found',
        );
        if (detected.length === 0) return null;
        return {
          name: def.name,
          status: summarizeLegacyStatus(detected.map((current) => current.status)),
          sources: detected.map((current) => current.source),
        };
      }

      const status = checkNohupServiceArtifact(projectRoot, def.name);
      if (status === 'not_found') return null;
      return {
        name: def.name,
        status,
        sources: ['nohup'] as LegacySource[],
      };
    })
    .filter((service): service is LegacyServiceIssue => Boolean(service));
}

function formatSystemdCleanupForScope(
  serviceNames: string[],
  homeDir: string,
  scope: SystemdScope,
): string[] {
  if (serviceNames.length === 0) return [];
  const systemctlPrefix = scope === 'system' ? 'systemctl' : 'systemctl --user';
  const unitDir =
    scope === 'system'
      ? '/etc/systemd/system'
      : path.join(homeDir, '.config', 'systemd', 'user');
  const unitPaths = serviceNames
    .map((serviceName) =>
      JSON.stringify(path.join(unitDir, `${serviceName}.service`)),
    )
    .join(' ');

  return [
    `${systemctlPrefix} disable --now ${serviceNames.join(' ')}`,
    `rm -f ${unitPaths}`,
    `${systemctlPrefix} daemon-reload`,
  ];
}

function formatLaunchdCleanup(serviceNames: string[], homeDir: string): string {
  if (serviceNames.length === 0) {
    return '';
  }
  const plistPaths = serviceNames.map((serviceName) => {
    const label = serviceName === 'ejclaw-codex'
      ? 'com.ejclaw-codex'
      : 'com.ejclaw-review';
    return path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  });

  return [
    ...plistPaths.map(
      (plistPath) =>
        `launchctl unload ${JSON.stringify(plistPath)} 2>/dev/null || true`,
    ),
    `rm -f ${plistPaths.map((plistPath) => JSON.stringify(plistPath)).join(' ')}`,
  ].join('\n');
}

function formatNohupCleanup(
  projectRoot: string,
  serviceNames: string[],
): string {
  if (serviceNames.length === 0) {
    return '';
  }
  const pidPaths = serviceNames
    .map((serviceName) => path.join(projectRoot, `${serviceName}.pid`))
    .map((currentPath) => JSON.stringify(currentPath));
  const wrapperPaths = serviceNames
    .map((serviceName) => path.join(projectRoot, `start-${serviceName}.sh`))
    .map((currentPath) => JSON.stringify(currentPath));

  return [
    ...pidPaths.map((pidPath) => `pkill -F ${pidPath} 2>/dev/null || true`),
    `rm -f ${[...pidPaths, ...wrapperPaths].join(' ')}`,
  ].join('\n');
}

export function formatLegacyServiceFailureMessage(args: {
  projectRoot: string;
  serviceManager: ServiceManager;
  services: LegacyServiceIssue[];
  homeDir?: string;
}): string {
  const homeDir = args.homeDir ?? os.homedir();
  const details = args.services
    .map(
      (service) =>
        `${service.name}=${service.status} [${service.sources.join(',')}]`,
    )
    .join(', ');

  let cleanupLines: string[] = [];
  if (args.serviceManager === 'launchd') {
    cleanupLines = formatLaunchdCleanup(
      args.services
        .filter((service) => service.sources.includes('launchd'))
        .map((service) => service.name),
      homeDir,
    ).split('\n');
  } else if (args.serviceManager === 'systemd') {
    cleanupLines = [
      ...formatSystemdCleanupForScope(
        args.services
          .filter((service) => service.sources.includes('systemd-system'))
          .map((service) => service.name),
        homeDir,
        'system',
      ),
      ...formatSystemdCleanupForScope(
        args.services
          .filter((service) => service.sources.includes('systemd-user'))
          .map((service) => service.name),
        homeDir,
        'user',
      ),
      ...formatNohupCleanup(
        args.projectRoot,
        args.services
          .filter((service) => service.sources.includes('nohup'))
          .map((service) => service.name),
      ).split('\n'),
    ].filter(Boolean);
  } else {
    cleanupLines = formatNohupCleanup(
      args.projectRoot,
      args.services.map((service) => service.name),
    ).split('\n');
  }

  return [
    `Legacy EJClaw multi-service install detected: ${details}`,
    'This setup is reinstall-only. Remove the legacy services before continuing.',
    'Suggested cleanup:',
    ...cleanupLines,
  ].join('\n');
}
