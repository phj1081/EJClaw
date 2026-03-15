/**
 * Step: runners — Build agent runners (no container needed).
 * Agents run as direct host processes.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  // Build agent runners
  let buildOk = false;
  logger.info('Building agent runners');
  try {
    execSync('npm run build:runners', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Agent runners build succeeded');
  } catch (err) {
    logger.error({ err }, 'Agent runners build failed');
  }

  // Verify runner entry points exist
  const agentRunner = path.join(
    projectRoot,
    'runners',
    'agent-runner',
    'dist',
    'index.js',
  );
  const codexRunner = path.join(
    projectRoot,
    'runners',
    'codex-runner',
    'dist',
    'index.js',
  );
  const agentRunnerOk = fs.existsSync(agentRunner);
  const codexRunnerOk = fs.existsSync(codexRunner);

  const status = buildOk && agentRunnerOk ? 'success' : 'failed';

  emitStatus('SETUP_RUNNERS', {
    BUILD_OK: buildOk,
    AGENT_RUNNER: agentRunnerOk,
    CODEX_RUNNER: codexRunnerOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
