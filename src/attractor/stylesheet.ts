// Model Stylesheet - Section 8
// CSS-like rules for per-node LLM model/provider defaults

import type { Graph, Node } from "./types.ts";

export interface StyleDeclaration {
  llmModel?: string;
  llmProvider?: string;
  reasoningEffort?: "low" | "medium" | "high";
}

export type SelectorType = "universal" | "shape" | "class" | "id";

export interface StyleRule {
  selector: string;
  selectorType: SelectorType;
  specificity: number;
  declarations: StyleDeclaration;
}

export function parseStylesheet(css: string): { rules: StyleRule[]; error?: string } {
  const rules: StyleRule[] = [];

  // Parse rules: Selector { Declaration; Declaration; }
  const rulePattern = /([^{]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(css)) !== null) {
    const selector = match[1]!.trim();
    const body = match[2]!.trim();

    if (!selector) continue;

    let selectorType: SelectorType;
    let specificity: number;
    let normalizedSelector: string;

    if (selector === "*") {
      selectorType = "universal";
      specificity = 0;
      normalizedSelector = "*";
    } else if (selector.startsWith("#")) {
      selectorType = "id";
      specificity = 3;
      normalizedSelector = selector.slice(1);
    } else if (selector.startsWith(".")) {
      selectorType = "class";
      specificity = 2;
      normalizedSelector = selector.slice(1);
    } else {
      selectorType = "shape";
      specificity = 1;
      normalizedSelector = selector;
    }

    const declarations: StyleDeclaration = {};

    // Parse declarations: property: value;
    const declPattern = /([a-zA-Z_]+)\s*:\s*([^;]+)/g;
    let declMatch: RegExpExecArray | null;

    while ((declMatch = declPattern.exec(body)) !== null) {
      const prop = declMatch[1]!.trim();
      const value = declMatch[2]!.trim().replace(/^["']|["']$/g, "");

      if (prop === "llm_model") declarations.llmModel = value;
      else if (prop === "llm_provider") declarations.llmProvider = value;
      else if (prop === "reasoning_effort") {
        if (value === "low" || value === "medium" || value === "high") {
          declarations.reasoningEffort = value;
        }
      }
    }

    rules.push({
      selector: normalizedSelector,
      selectorType,
      specificity,
      declarations,
    });
  }

  return { rules };
}

function getNodeClasses(node: Node): string[] {
  const classes: string[] = [];

  // From class attribute
  if (node.attrs.class) {
    classes.push(...String(node.attrs.class).split(",").map((c) => c.trim()));
  }

  // From subgraph label derivation
  if (node.subgraphLabel) {
    const derived = node.subgraphLabel
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (derived) classes.push(derived);
  }

  return classes;
}

export function applyStylesheet(rules: StyleRule[], node: Node): StyleDeclaration {
  const result: StyleDeclaration = {};
  const shape = node.attrs.shape ?? "box";
  const classes = getNodeClasses(node);

  // Sort rules by specificity (ascending) so higher specificity wins
  const sortedRules = [...rules].sort((a, b) => a.specificity - b.specificity);

  for (const rule of sortedRules) {
    let matches = false;

    switch (rule.selectorType) {
      case "universal":
        matches = true;
        break;
      case "shape":
        matches = rule.selector === shape;
        break;
      case "class":
        matches = classes.includes(rule.selector);
        break;
      case "id":
        matches = rule.selector === node.id;
        break;
    }

    if (matches) {
      if (rule.declarations.llmModel !== undefined) result.llmModel = rule.declarations.llmModel;
      if (rule.declarations.llmProvider !== undefined) result.llmProvider = rule.declarations.llmProvider;
      if (rule.declarations.reasoningEffort !== undefined)
        result.reasoningEffort = rule.declarations.reasoningEffort;
    }
  }

  return result;
}

export function applyStylesheetToGraph(graph: Graph, rules: StyleRule[]): void {
  for (const node of graph.nodes.values()) {
    const style = applyStylesheet(rules, node);

    // Only set if node doesn't already have explicit values
    if (style.llmModel && !node.attrs.llmModel) node.attrs.llmModel = style.llmModel;
    if (style.llmProvider && !node.attrs.llmProvider) node.attrs.llmProvider = style.llmProvider;
    if (style.reasoningEffort && !node.attrs.reasoningEffort)
      node.attrs.reasoningEffort = style.reasoningEffort;
  }
}
