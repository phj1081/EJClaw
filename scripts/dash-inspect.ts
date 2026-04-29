#!/usr/bin/env bun
/**
 * Dashboard inspector via Playwright.
 *
 * Usage:
 *   bun scripts/dash-inspect.ts shot              # full-page screenshot
 *   bun scripts/dash-inspect.ts shot rooms        # screenshot of #/rooms
 *   bun scripts/dash-inspect.ts measure '<sel>'   # bounding box + computed style
 *   bun scripts/dash-inspect.ts click '<sel>'     # click and screenshot after
 *   bun scripts/dash-inspect.ts eval '<expr>'     # evaluate JS in page
 *   bun scripts/dash-inspect.ts dom '<sel>'       # outerHTML of selector
 *   bun scripts/dash-inspect.ts route <hash>      # navigate to #/<hash>
 *
 * Output: writes to /tmp/dash-shot.png + prints data to stdout.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';

const BASE = process.env.DASH_URL ?? 'http://100.101.210.95:5174';
const SHOT = '/tmp/dash-shot.png';

async function withPage<T>(
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    return await fn(page, ctx);
  } finally {
    await browser.close();
  }
}

async function gotoRoute(page: Page, route?: string) {
  const url = route ? `${BASE}/#/${route.replace(/^#?\/?/, '')}` : BASE;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
}

async function shot(page: Page) {
  await page.screenshot({ path: SHOT, fullPage: false });
  console.log(`screenshot saved: ${SHOT}`);
}

async function measure(page: Page, sel: string) {
  const all = await page.$$(sel);
  if (all.length === 0) {
    console.log(`NOT FOUND: ${sel}`);
    return;
  }
  for (let i = 0; i < Math.min(all.length, 6); i++) {
    const el = all[i];
    const box = await el.boundingBox();
    const style = await el.evaluate((node: object) => {
      const cs = (
        globalThis as unknown as {
          getComputedStyle: (e: object) => Record<string, string>;
        }
      ).getComputedStyle(node);
      return {
        display: cs.display,
        position: cs.position,
        margin: cs.margin,
        padding: cs.padding,
        width: cs.width,
        height: cs.height,
        boxSizing: cs.boxSizing,
        gridTemplateColumns: cs.gridTemplateColumns,
        gridTemplateRows: cs.gridTemplateRows,
      };
    });
    console.log(
      `[${i}] ${sel}\n  rect: ${box ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}` : 'none'}\n  ${JSON.stringify(style)}`,
    );
  }
}

async function evalExpr(page: Page, expr: string) {
  const result = await page.evaluate((e) => {
    return eval(e);
  }, expr);
  console.log(JSON.stringify(result, null, 2));
}

async function dom(page: Page, sel: string) {
  const el = await page.$(sel);
  if (!el) {
    console.log(`NOT FOUND: ${sel}`);
    return;
  }
  const html = await el.evaluate(
    (node: object) => (node as unknown as { outerHTML: string }).outerHTML,
  );
  console.log(
    html.length > 4000 ? `${html.slice(0, 4000)}\n…(truncated)` : html,
  );
}

async function clickAndShot(page: Page, sel: string) {
  await page.click(sel);
  await page.waitForTimeout(500);
  await shot(page);
}

const [, , cmd = 'shot', ...rest] = process.argv;

await withPage(async (page) => {
  // Default route from rest[0] when shot/measure/etc; otherwise look for explicit `route` arg.
  const routeArg =
    cmd === 'shot' && rest[0] && !rest[0].startsWith('.') ? rest[0] : 'rooms';
  await gotoRoute(page, routeArg);

  switch (cmd) {
    case 'shot':
      await shot(page);
      break;
    case 'measure':
      await measure(page, rest[0]);
      break;
    case 'click':
      await clickAndShot(page, rest[0]);
      break;
    case 'eval':
      await evalExpr(page, rest[0]);
      break;
    case 'dom':
      await dom(page, rest[0]);
      break;
    case 'route':
      await shot(page);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
});
