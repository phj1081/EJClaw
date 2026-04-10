const CANONICAL_DISCORD_KEYS = new Set([
  'DISCORD_OWNER_BOT_TOKEN',
  'DISCORD_REVIEWER_BOT_TOKEN',
  'DISCORD_ARBITER_BOT_TOKEN',
]);

const CANONICAL_SESSION_COMMAND_KEYS = new Set([
  'SESSION_COMMAND_ALLOWED_SENDERS',
]);

for (const key of Object.keys(process.env)) {
  if (key.startsWith('DISCORD_') && key.endsWith('_BOT_TOKEN')) {
    if (!CANONICAL_DISCORD_KEYS.has(key)) {
      delete process.env[key];
    }
    continue;
  }
  if (key.startsWith('SESSION_COMMAND_')) {
    if (!CANONICAL_SESSION_COMMAND_KEYS.has(key)) {
      delete process.env[key];
    }
  }
}
