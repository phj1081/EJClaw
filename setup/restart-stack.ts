import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

import { getServiceManager, isRoot } from './platform.js';
import { getConfiguredServiceNames } from './service-defs.js';

type ServiceManager = ReturnType<typeof getServiceManager>;

interface RestartStackDeps {
  execFileSyncImpl?: typeof execFileSync;
  runningAsRoot?: boolean;
  serviceManager?: ServiceManager;
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
  if (services.length === 0) {
    throw new Error('No EJClaw services are configured in this project');
  }

  const execImpl = deps.execFileSyncImpl ?? execFileSync;
  const systemctlArgs = deps.runningAsRoot ?? isRoot() ? [] : ['--user'];

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

export async function run(_args: string[]): Promise<void> {
  const services = restartStackServices(process.cwd());
  console.log(`Restarted and verified: ${services.join(', ')}`);
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
