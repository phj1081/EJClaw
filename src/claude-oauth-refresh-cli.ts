import { forceRefreshToken } from './token-refresh.js';
import { getAllTokens, initTokenRotation } from './token-rotation.js';

async function main(): Promise<void> {
  initTokenRotation();

  const tokens = getAllTokens();
  const accountCount = Math.max(tokens.length, 1);
  let refreshed = 0;
  let checked = 0;

  for (let index = 0; index < accountCount; index += 1) {
    checked += 1;
    const token = await forceRefreshToken(index);
    if (token) refreshed += 1;
  }

  console.log(
    JSON.stringify({
      checked,
      refreshed,
      status: refreshed > 0 ? 'refreshed' : 'no_refresh',
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
