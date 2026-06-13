export const ALLOWED_JSON_LOGIC_OPERATORS = new Set([
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "and",
  "or",
  "!",
  "var",
  "in",
] as const);

export interface JsonLogicRuleIssue {
  readonly message: string;
}

export interface JsonLogicRuleInspection {
  readonly variablePaths: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<JsonLogicRuleIssue>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inspectNode = (
  node: unknown,
  variablePaths: string[],
  seenPaths: Set<string>,
  issues: JsonLogicRuleIssue[],
): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      inspectNode(item, variablePaths, seenPaths, issues);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }

  const entries = Object.entries(node);
  if (entries.length !== 1) {
    issues.push({ message: "JSONLogic rule objects must contain exactly one operator" });
    for (const value of Object.values(node)) {
      inspectNode(value, variablePaths, seenPaths, issues);
    }
    return;
  }

  const entry = entries[0];
  if (entry === undefined) {
    return;
  }
  const [operator, operand] = entry;
  if (!ALLOWED_JSON_LOGIC_OPERATORS.has(operator as never)) {
    issues.push({ message: `unsupported JSONLogic operator: ${operator}` });
    inspectNode(operand, variablePaths, seenPaths, issues);
    return;
  }

  if (operator === "var") {
    if (typeof operand !== "string") {
      issues.push({ message: "JSONLogic var must be a string path without a default" });
      return;
    }
    if (!seenPaths.has(operand)) {
      seenPaths.add(operand);
      variablePaths.push(operand);
    }
    return;
  }

  inspectNode(operand, variablePaths, seenPaths, issues);
};

export const inspectJsonLogicRule = (rule: unknown): JsonLogicRuleInspection => {
  const variablePaths: string[] = [];
  const issues: JsonLogicRuleIssue[] = [];
  inspectNode(rule, variablePaths, new Set(), issues);
  return { variablePaths, issues };
};
