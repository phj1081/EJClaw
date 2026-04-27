import ts from 'typescript';

export interface CodeQualityBudget {
  maxComplexity?: number;
  maxFunctionLines?: number;
  maxLines?: number;
  maxNesting?: number;
  owner?: string;
}

export interface CodeQualityMetrics {
  filePath: string;
  lineCount: number;
  maxComplexity: number;
  maxFunctionLines: number;
  maxNesting: number;
  nonEmptyLineCount: number;
}

export interface CodeQualityFinding {
  actual: number;
  budget: number;
  filePath: string;
  metric: keyof Pick<
    CodeQualityMetrics,
    'lineCount' | 'maxComplexity' | 'maxFunctionLines' | 'maxNesting'
  >;
  owner?: string;
}

interface FunctionMetrics {
  complexity: number;
  lines: number;
  nesting: number;
}

export function analyzeCodeQuality(
  filePath: string,
  sourceText: string,
): CodeQualityMetrics {
  const lines = sourceText.split(/\r?\n/);
  const textMetrics = {
    filePath,
    lineCount: lines.length,
    nonEmptyLineCount: lines.filter((line) => line.trim().length > 0).length,
  };
  if (!/\.(?:c|m)?[jt]sx?$/.test(filePath)) {
    return {
      ...textMetrics,
      maxComplexity: 0,
      maxFunctionLines: 0,
      maxNesting: 0,
    };
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );
  const functions: FunctionMetrics[] = [];

  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) {
      functions.push(analyzeFunction(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return {
    ...textMetrics,
    maxComplexity: maxOf(functions.map((fn) => fn.complexity)),
    maxFunctionLines: maxOf(functions.map((fn) => fn.lines)),
    maxNesting: maxOf(functions.map((fn) => fn.nesting)),
  };
}

export function evaluateCodeQuality(
  metrics: CodeQualityMetrics,
  budget: CodeQualityBudget,
): CodeQualityFinding[] {
  const findings: CodeQualityFinding[] = [];
  addFinding(findings, metrics, budget, 'lineCount', budget.maxLines);
  addFinding(
    findings,
    metrics,
    budget,
    'maxFunctionLines',
    budget.maxFunctionLines,
  );
  addFinding(findings, metrics, budget, 'maxComplexity', budget.maxComplexity);
  addFinding(findings, metrics, budget, 'maxNesting', budget.maxNesting);
  return findings;
}

function addFinding(
  findings: CodeQualityFinding[],
  metrics: CodeQualityMetrics,
  budget: CodeQualityBudget,
  metric: CodeQualityFinding['metric'],
  limit: number | undefined,
) {
  if (limit === undefined) return;
  const actual = metrics[metric];
  if (actual <= limit) return;
  findings.push({
    actual,
    budget: limit,
    filePath: metrics.filePath,
    metric,
    owner: budget.owner,
  });
}

function analyzeFunction(
  sourceFile: ts.SourceFile,
  node: ts.SignatureDeclaration,
): FunctionMetrics {
  const startLine = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  ).line;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  let complexity = 1;
  let maxNesting = 0;

  const walk = (current: ts.Node, nesting: number) => {
    if (current !== node && isFunctionLike(current)) return;

    if (isDecisionNode(current)) {
      complexity += 1;
      const nextNesting = nesting + 1;
      maxNesting = Math.max(maxNesting, nextNesting);
      ts.forEachChild(current, (child) => walk(child, nextNesting));
      return;
    }

    if (
      ts.isBinaryExpression(current) &&
      isLogicalOperator(current.operatorToken.kind)
    ) {
      complexity += 1;
    }

    ts.forEachChild(current, (child) => walk(child, nesting));
  };

  walk(node, 0);

  return {
    complexity,
    lines: endLine - startLine + 1,
    nesting: maxNesting,
  };
}

function isDecisionNode(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node)
  );
}

function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function maxOf(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
