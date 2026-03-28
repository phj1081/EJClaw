import fs from 'fs';
import path from 'path';

export interface ServiceDef {
  /** systemd unit name / nohup script name */
  name: string;
  /** launchd label */
  launchdLabel: string;
  /** Human-readable description for systemd/launchd */
  description: string;
  /** Log file prefix (e.g. "ejclaw" → logs/ejclaw.log) */
  logName: string;
  /** Absolute path to EnvironmentFile (systemd) — loaded before Environment= */
  environmentFile?: string;
  /** Extra Environment= lines for systemd / env dict entries for launchd */
  extraEnv?: Record<string, string>;
}

export function getServiceDefs(projectRoot: string): ServiceDef[] {
  const defs: ServiceDef[] = [
    {
      name: 'ejclaw',
      launchdLabel: 'com.ejclaw',
      description: 'EJClaw Personal Assistant (Claude Code)',
      logName: 'ejclaw',
    },
  ];

  const codexEnvPath = path.join(projectRoot, '.env.codex');
  if (fs.existsSync(codexEnvPath)) {
    defs.push({
      name: 'ejclaw-codex',
      launchdLabel: 'com.ejclaw-codex',
      description: 'EJClaw Codex Assistant',
      logName: 'ejclaw-codex',
      environmentFile: codexEnvPath,
      extraEnv: {
        ASSISTANT_NAME: 'codex',
      },
    });
  }

  const reviewEnvPath = path.join(projectRoot, '.env.codex-review');
  if (fs.existsSync(reviewEnvPath)) {
    defs.push({
      name: 'ejclaw-review',
      launchdLabel: 'com.ejclaw-review',
      description: 'EJClaw Codex Review Assistant',
      logName: 'ejclaw-review',
      environmentFile: reviewEnvPath,
      extraEnv: {
        ASSISTANT_NAME: 'codex',
      },
    });
  }

  return defs;
}

export function getConfiguredServiceNames(projectRoot: string): string[] {
  return getServiceDefs(projectRoot).map((def) => def.name);
}
