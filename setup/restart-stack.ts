import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

import { getServiceManager, isRoot } from './platform.js';
import { getConfiguredServiceNames } from './service-defs.js';

type ServiceManager = ReturnType<typeof getServiceManager>;
export const STACK_RESTART_UNIT_NAME = 'ejclaw-stack-restart.service';
const UNIT_NOT_FOUND_PATTERN =
  /(Unit .* not found|Could not find the requested service|not-found)/i;
const MANAGED_SERVICE_CALLER_FALLBACK_MESSAGE =
  'Stack restart unit is not installed yet. Run `bun run setup -- --step service` from an external shell before retrying from a managed EJClaw service.';

interface RestartStackDeps {
  execFileSyncImpl?: typeof execFileSync;
  runningAsRoot?: boolean;
  serviceManager?: ServiceManager;
  direct?: boolean;
  serviceId?: string | null;
}

function restartStackServicesDirect(
  projectRoot: string,
  deps: RestartStackDeps = {},
): string[] {
  const serviceManager = deps.serviceManager ?? getServiceManager();
  if (serviceManager !== 'systemd') {
    throw new Error(
      'restart:stack only supports Linux systemd services in this repo',
    );
  }

  const services = getConfiguredServiceNames(projectRoot);
  if (services.length === 0) {
    throw new Error('No EJClaw services are configured in this project');
  }

  const execImpl = deps.execFileSyncImpl ?? execFileSync;
  const systemctlArgs = (deps.runningAsRoot ?? isRoot()) ? [] : ['--user'];

  execImpl('systemctl', [...systemctlArgs, 'restart', ...services], {
    stdio: 'ignore',
  });

  for (const service of services) {
    execImpl('systemctl', [...systemctlArgs, 'is-active', '--quiet', service], {
      stdio: 'ignore',
    });
  }

  return services;
}

export function restartStackServices(
  projectRoot: string,
  deps: RestartStackDeps = {},
): string[] {
  const serviceManager = deps.serviceManager ?? getServiceManager();
  if (serviceManager !== 'systemd') {
    throw new Error(
      'restart:stack only supports Linux systemd services in this repo',
    );
  }

  const services = getConfiguredServiceNames(projectRoot);
  const execImpl = deps.execFileSyncImpl ?? execFileSync;
  const systemctlArgs = (deps.runningAsRoot ?? isRoot()) ? [] : ['--user'];

  if (deps.direct) {
    return restartStackServicesDirect(projectRoot, deps);
  }

  try {
    execImpl(
      'systemctl',
      [...systemctlArgs, 'start', '--wait', STACK_RESTART_UNIT_NAME],
      {
        stdio: 'ignore',
      },
    );
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr || '')
        : '';
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout || '')
        : '';
    const message =
      error instanceof Error ? error.message : `${stdout}\n${stderr}`.trim();
    const combined = `${message}\n${stdout}\n${stderr}`;
    const unitMissing = UNIT_NOT_FOUND_PATTERN.test(combined);
    const callerServiceId =
      deps.serviceId === undefined ? process.env.SERVICE_ID : deps.serviceId;
    const managedServiceCaller = Boolean(callerServiceId);

    if (!unitMissing) {
      throw error;
    }
    if (managedServiceCaller) {
      throw new Error(MANAGED_SERVICE_CALLER_FALLBACK_MESSAGE);
    }

    return restartStackServicesDirect(projectRoot, deps);
  }

  return services;
}

export async function run(args: string[]): Promise<void> {
  const direct = args.includes('--direct');
  const services = restartStackServices(process.cwd(), { direct });
  if (direct) {
    console.log(`Restarted and verified: ${services.join(', ')}`);
    return;
  }
  console.log(
    `Restarted and verified via ${STACK_RESTART_UNIT_NAME}: ${services.join(', ')}`,
  );
}

if (process.argv[1]) {
  const isMain =
    import.meta.url === pathToFileURL(process.argv[1]).href ||
    import.meta.url === pathToFileURL(process.argv[1]).toString();
  if (isMain) {
    run([]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
  }
}
