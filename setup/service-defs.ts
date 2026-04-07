export type ServiceKind = 'primary';

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

function materializeServiceDef(template: ServiceTemplate): ServiceDef {
  const environmentFile = undefined;
  const extraEnv =
    template.kind === 'primary'
      ? {
          EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
        }
      : undefined;

  return {
    kind: template.kind,
    name: template.name,
    launchdLabel: template.launchdLabel,
    description: template.description,
    logName: template.logName,
    environmentFile,
    extraEnv,
  };
}

export function getServiceDefs(projectRoot: string): ServiceDef[] {
  void projectRoot;
  return CURRENT_SERVICE_TEMPLATES.map((template) =>
    materializeServiceDef(template),
  );
}

export function getConfiguredServiceNames(projectRoot: string): string[] {
  return getServiceDefs(projectRoot).map((def) => def.name);
}
