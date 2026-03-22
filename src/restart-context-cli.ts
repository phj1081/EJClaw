import { SERVICE_ID } from './config.js';
import { writeRestartContext } from './restart-context.js';

function printUsageAndExit(): never {
  console.error(
    [
      'Usage:',
      '  tsx src/restart-context-cli.ts write --chat-jid <jid> --summary <text> [--verify <text> ...] [--service-id <id> ...]',
    ].join('\n'),
  );
  process.exit(1);
}

const [, , command, ...args] = process.argv;
if (command !== 'write') {
  printUsageAndExit();
}

let chatJid = '';
let summary = '';
const verify: string[] = [];
const serviceIds: string[] = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const value = args[i + 1];
  if (!value) {
    printUsageAndExit();
  }

  if (arg === '--chat-jid' || arg === '--jid') {
    chatJid = value;
    i += 1;
    continue;
  }
  if (arg === '--summary') {
    summary = value;
    i += 1;
    continue;
  }
  if (arg === '--verify') {
    verify.push(value);
    i += 1;
    continue;
  }
  if (arg === '--service-id') {
    serviceIds.push(value);
    i += 1;
    continue;
  }

  printUsageAndExit();
}

if (!chatJid || !summary) {
  printUsageAndExit();
}

const written = writeRestartContext(
  {
    chatJid,
    summary,
    verify,
  },
  serviceIds.length > 0 ? serviceIds : [SERVICE_ID],
);

for (const filePath of written) {
  console.log(filePath);
}
