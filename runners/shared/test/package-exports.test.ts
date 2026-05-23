import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('runner shared package exports', () => {
  it('points runtime imports at built JavaScript for node-launched MCP servers', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, '../package.json'),
        'utf8',
      ),
    ) as { exports: { '.': { default: string; types: string } } };

    expect(packageJson.exports['.']).toEqual({
      types: './src/index.ts',
      default: './dist/index.js',
    });
  });
});
