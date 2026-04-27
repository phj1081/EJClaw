import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  analyzeCodeQuality,
  evaluateCodeQuality,
  type CodeQualityBudget,
  type CodeQualityFinding,
  type CodeQualityMetrics,
} from './quality/code-quality.js';

interface QualityBudgetConfig {
  defaults: CodeQualityBudget;
  overrides?: Record<string, CodeQualityBudget>;
  testDefaults?: CodeQualityBudget;
}

const ROOT = resolve(import.meta.dir, '..');
const CONFIG_PATH = resolve(ROOT, 'quality/code-quality-budgets.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);
const IGNORED_PARTS = new Set([
  'dist',
  'node_modules',
  'coverage',
  'store',
  'data',
]);

const config = JSON.parse(
  readFileSync(CONFIG_PATH, 'utf8'),
) as QualityBudgetConfig;
const reportOnly = process.argv.includes('--report');
const metrics = collectMetrics();
const findings = metrics.flatMap((item) =>
  evaluateCodeQuality(item, budgetForFile(item.filePath, config)),
);

if (reportOnly) {
  for (const item of metrics
    .filter((metric) => config.overrides?.[metric.filePath])
    .sort((a, b) => b.lineCount - a.lineCount)) {
    console.log(
      [
        item.filePath,
        `lines=${item.lineCount}`,
        `fnLines=${item.maxFunctionLines}`,
        `complexity=${item.maxComplexity}`,
        `nesting=${item.maxNesting}`,
      ].join(' '),
    );
  }
}

if (findings.length > 0) {
  console.error(formatFindings(findings));
  process.exit(1);
}

console.log(
  `code quality OK (${metrics.length} files, ${Object.keys(config.overrides ?? {}).length} ratcheted hotspots)`,
);

function collectMetrics(): CodeQualityMetrics[] {
  return trackedFiles()
    .filter((filePath) => shouldAnalyze(filePath))
    .map((filePath) =>
      analyzeCodeQuality(
        filePath,
        readFileSync(resolve(ROOT, filePath), 'utf8'),
      ),
    );
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function shouldAnalyze(filePath: string): boolean {
  if (filePath.endsWith('.d.ts')) return false;
  const parts = filePath.split('/');
  if (parts.some((part) => IGNORED_PARTS.has(part))) return false;
  return SOURCE_EXTENSIONS.has(extensionFor(filePath));
}

function extensionFor(filePath: string): string {
  const match = /\.[^.]+$/.exec(filePath);
  return match?.[0] ?? '';
}

function budgetForFile(
  filePath: string,
  budgetConfig: QualityBudgetConfig,
): CodeQualityBudget {
  const base = isTestFile(filePath)
    ? (budgetConfig.testDefaults ?? budgetConfig.defaults)
    : budgetConfig.defaults;
  return {
    ...base,
    ...budgetConfig.overrides?.[filePath],
  };
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('/test/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx')
  );
}

function formatFindings(findings: CodeQualityFinding[]): string {
  const lines = findings.map((finding) => {
    const label = finding.owner
      ? `${finding.filePath} (${finding.owner})`
      : finding.filePath;
    return `- ${label}: ${finding.metric} ${finding.actual} > ${finding.budget}`;
  });
  return [
    'code quality budget failed:',
    ...lines,
    '',
    `Update the code to reduce the metric, or adjust ${relative(ROOT, CONFIG_PATH)} only when intentionally ratcheting a new baseline.`,
  ].join('\n');
}
