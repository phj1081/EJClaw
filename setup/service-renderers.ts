import path from 'path';

import { STARTUP_PRECONDITION_EXIT_CODE } from '../src/startup-preconditions.js';
import type { ServiceDef } from './service-defs.js';

export function buildRuntimePathEnv(nodePath: string, homeDir: string): string {
  return `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin:${homeDir}/.npm-global/bin`;
}

function buildLaunchdEnvironmentEntries(
  nodePath: string,
  homeDir: string,
  extraEnv?: Record<string, string>,
): string[] {
  const envEntries = [
    `        <key>PATH</key>`,
    `        <string>${buildRuntimePathEnv(nodePath, homeDir)}</string>`,
    `        <key>HOME</key>`,
    `        <string>${homeDir}</string>`,
  ];
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      envEntries.push(`        <key>${k}</key>`);
      envEntries.push(`        <string>${v}</string>`);
    }
  }
  return envEntries;
}

function buildSystemdEnvironmentLines(
  nodePath: string,
  homeDir: string,
  extraEnv?: Record<string, string>,
): string[] {
  const envLines = [
    `Environment=HOME=${homeDir}`,
    `Environment=PATH=${buildRuntimePathEnv(nodePath, homeDir)}`,
  ];
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      envLines.push(`Environment=${k}=${v}`);
    }
  }
  return envLines;
}

export function buildLaunchdPlist(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): string {
  const envEntries = buildLaunchdEnvironmentEntries(
    nodePath,
    homeDir,
    def.extraEnv,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${def.launchdLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries.join('\n')}
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/${def.logName}.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/${def.logName}.error.log</string>
</dict>
</plist>`;
}

export function buildSystemdUnit(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  runningAsRoot: boolean,
): string {
  const envLines = buildSystemdEnvironmentLines(
    nodePath,
    homeDir,
    def.extraEnv,
  );

  const envFileLine = def.environmentFile
    ? `EnvironmentFile=${def.environmentFile}\n`
    : '';

  return `[Unit]
Description=${def.description}
After=network.target

[Service]
${envFileLine}Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
RestartPreventExitStatus=${STARTUP_PRECONDITION_EXIT_CODE}
${envLines.join('\n')}
StandardOutput=append:${projectRoot}/logs/${def.logName}.log
StandardError=append:${projectRoot}/logs/${def.logName}.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;
}

export function buildStackRestartSystemdUnit(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): string {
  const envLines = buildSystemdEnvironmentLines(nodePath, homeDir);

  return `[Unit]
Description=EJClaw Stack Restart Orchestrator
After=network.target

[Service]
Type=oneshot
WorkingDirectory=${projectRoot}
${envLines.join('\n')}
ExecStart=${nodePath} ${projectRoot}/setup/restart-stack.ts --direct
`;
}
