export type ServiceKind = 'primary' | 'legacy';

export interface ServiceDef {
  /** Stable topology kind used by setup/verify logic */
  kind: ServiceKind;
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

interface ServiceTemplate {
  kind: ServiceKind;
  name: string;
  launchdLabel: string;
  description: string;
  logName: string;
}

const CURRENT_SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    kind: 'primary',
    name: 'ejclaw',
    launchdLabel: 'com.ejclaw',
    description: 'EJClaw Personal Assistant (Claude Code)',
    logName: 'ejclaw',
  },
];

const LEGACY_SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    kind: 'legacy',
    name: 'ejclaw-codex',
    launchdLabel: 'com.ejclaw-codex',
    description: 'Legacy EJClaw Codex Assistant',
    logName: 'ejclaw-codex',
  },
  {
    kind: 'legacy',
    name: 'ejclaw-review',
    launchdLabel: 'com.ejclaw-review',
    description: 'Legacy EJClaw Codex Review Assistant',
    logName: 'ejclaw-review',
  },
];

function materializeServiceDef(template: ServiceTemplate): ServiceDef {
  const environmentFile = undefined;

  return {
    kind: template.kind,
    name: template.name,
    launchdLabel: template.launchdLabel,
    description: template.description,
    logName: template.logName,
    environmentFile,
    extraEnv: undefined,
  };
}

export function getServiceDefs(projectRoot: string): ServiceDef[] {
  void projectRoot;
  return CURRENT_SERVICE_TEMPLATES.map((template) =>
    materializeServiceDef(template),
  );
}

export function getLegacyServiceDefs(projectRoot: string): ServiceDef[] {
  void projectRoot;
  return LEGACY_SERVICE_TEMPLATES.map((template) =>
    materializeServiceDef(template),
  );
}

export function getConfiguredServiceNames(projectRoot: string): string[] {
  return getServiceDefs(projectRoot).map((def) => def.name);
}

export function getLegacyServiceNames(projectRoot: string): string[] {
  return getLegacyServiceDefs(projectRoot).map((def) => def.name);
}
