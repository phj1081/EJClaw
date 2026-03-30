import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { getServiceManager, isRoot } from './platform.js';
import { STACK_RESTART_UNIT_NAME } from './restart-stack.js';
import type { ServiceDef } from './service-defs.js';
import {
  buildLaunchdPlist,
  buildStackRestartSystemdUnit,
  buildSystemdUnit,
} from './service-renderers.js';
import { emitStatus } from './status.js';

export function setupLaunchd(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    `${def.launchdLabel}.plist`,
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = buildLaunchdPlist(def, projectRoot, nodePath, homeDir);

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath, service: def.name }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info({ service: def.name }, 'launchctl load succeeded');
  } catch {
    logger.warn(
      { service: def.name },
      'launchctl load failed (may already be loaded)',
    );
  }

  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes(def.launchdLabel);
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_NAME: def.name,
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

export function setupLinux(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemdAll(serviceDefs, projectRoot, nodePath, homeDir);
  } else {
    for (const def of serviceDefs) {
      setupNohupFallback(def, projectRoot, nodePath, homeDir);
    }
  }
}

/**
 * Kill any orphaned ejclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned ejclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

function setupSystemdAll(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();
  const systemctlPrefix = runningAsRoot ? 'systemctl' : 'systemctl --user';

  if (!runningAsRoot) {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      for (const def of serviceDefs) {
        setupNohupFallback(def, projectRoot, nodePath, homeDir);
      }
      return;
    }
  }

  killOrphanedProcesses(projectRoot);

  for (const def of serviceDefs) {
    setupSystemdUnit(def, projectRoot, nodePath, homeDir, runningAsRoot);
  }
  setupSystemdStackRestartUnit(projectRoot, nodePath, homeDir, runningAsRoot);

  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  for (const def of serviceDefs) {
    try {
      execSync(`${systemctlPrefix} enable ${def.name}`, { stdio: 'ignore' });
    } catch (err) {
      logger.error({ err, service: def.name }, 'systemctl enable failed');
    }

    try {
      execSync(`${systemctlPrefix} start ${def.name}`, { stdio: 'ignore' });
    } catch (err) {
      logger.error({ err, service: def.name }, 'systemctl start failed');
    }

    let serviceLoaded = false;
    try {
      execSync(`${systemctlPrefix} is-active ${def.name}`, {
        stdio: 'ignore',
      });
      serviceLoaded = true;
    } catch {
      // Not active
    }

    emitStatus('SETUP_SERVICE', {
      SERVICE_NAME: def.name,
      SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      UNIT_PATH: getUnitPath(def.name, homeDir, runningAsRoot),
      SERVICE_LOADED: serviceLoaded,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  }
}

function getUnitPath(
  serviceName: string,
  homeDir: string,
  runningAsRoot: boolean,
): string {
  if (runningAsRoot) {
    return `/etc/systemd/system/${serviceName}.service`;
  }
  return path.join(
    homeDir,
    '.config',
    'systemd',
    'user',
    `${serviceName}.service`,
  );
}

function setupSystemdUnit(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  runningAsRoot: boolean,
): void {
  const unitPath = getUnitPath(def.name, homeDir, runningAsRoot);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });

  const unit = buildSystemdUnit(
    def,
    projectRoot,
    nodePath,
    homeDir,
    runningAsRoot,
  );

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath, service: def.name }, 'Wrote systemd unit');
}

function setupSystemdStackRestartUnit(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  runningAsRoot: boolean,
): void {
  const unitPath = getUnitPath(
    STACK_RESTART_UNIT_NAME.replace(/\.service$/, ''),
    homeDir,
    runningAsRoot,
  );
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(
    unitPath,
    buildStackRestartSystemdUnit(projectRoot, nodePath, homeDir),
  );
  logger.info(
    { unitPath, service: STACK_RESTART_UNIT_NAME },
    'Wrote stack restart systemd unit',
  );
}

function setupNohupFallback(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  _homeDir: string,
): void {
  logger.warn(
    { service: def.name },
    'No systemd detected — generating nohup wrapper script',
  );

  const wrapperPath = path.join(projectRoot, `start-${def.name}.sh`);
  const pidFile = path.join(projectRoot, `${def.name}.pid`);

  const exportLines: string[] = [];
  if (def.environmentFile) {
    exportLines.push(`# Load environment file`);
    exportLines.push(`set -a`);
    exportLines.push(`source ${JSON.stringify(def.environmentFile)}`);
    exportLines.push(`set +a`);
    exportLines.push('');
  }
  if (def.extraEnv) {
    for (const [k, v] of Object.entries(def.extraEnv)) {
      exportLines.push(`export ${k}=${JSON.stringify(v)}`);
    }
    exportLines.push('');
  }

  const lines = [
    '#!/bin/bash',
    `# start-${def.name}.sh — Start ${def.description} without systemd`,
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    ...exportLines,
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    `    echo "Stopping existing ${def.name} (PID $OLD_PID)..."`,
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    `echo "Starting ${def.description}..."`,
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/' + def.logName + '.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/' + def.logName + '.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    `echo "${def.name} started (PID $!)"`,
    `echo "Logs: tail -f ${projectRoot}/logs/${def.logName}.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath, service: def.name }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_NAME: def.name,
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
