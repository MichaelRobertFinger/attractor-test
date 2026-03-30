// Condition expression evaluator - Section 10

import type { Outcome } from "./types.ts";
import type { Context } from "./context.ts";

// Grammar:
// ConditionExpr ::= Clause ('&&' Clause)*
// Clause        ::= Key Operator Literal
// Key           ::= 'outcome' | 'preferred_label' | 'context.' Path | bare key
// Operator      ::= '=' | '!='
// Literal       ::= String | BareLiteral

function resolveKey(key: string, outcome: Outcome, context: Context): string {
  const trimmed = key.trim();

  if (trimmed === "outcome") {
    return outcome.status.toLowerCase();
  }

  if (trimmed === "preferred_label") {
    return outcome.preferredLabel ?? "";
  }

  if (trimmed.startsWith("context.")) {
    const contextKey = trimmed.slice("context.".length);
    const val = context.get(contextKey);
    if (val != null) return String(val);
    // Also try with full path
    const val2 = context.get(trimmed);
    if (val2 != null) return String(val2);
    return "";
  }

  // Direct context lookup
  const val = context.get(trimmed);
  if (val != null) return String(val);
  return "";
}

function parseLiteral(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return trimmed;
}

function evaluateClause(clause: string, outcome: Outcome, context: Context): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return true;

  // Check for != first (before =)
  const neqIdx = trimmed.indexOf("!=");
  if (neqIdx !== -1) {
    const key = trimmed.slice(0, neqIdx).trim();
    const value = parseLiteral(trimmed.slice(neqIdx + 2));
    return resolveKey(key, outcome, context) !== value;
  }

  const eqIdx = trimmed.indexOf("=");
  if (eqIdx !== -1) {
    const key = trimmed.slice(0, eqIdx).trim();
    const value = parseLiteral(trimmed.slice(eqIdx + 1));
    return resolveKey(key, outcome, context) === value;
  }

  // Bare key: truthy check
  return Boolean(resolveKey(trimmed, outcome, context));
}

export function evaluateCondition(
  condition: string,
  outcome: Outcome,
  context: Context
): boolean {
  if (!condition || !condition.trim()) return true; // empty = always eligible

  const clauses = condition.split("&&");
  for (const clause of clauses) {
    if (!evaluateClause(clause, outcome, context)) return false;
  }
  return true;
}

export function parseCondition(condition: string): { valid: boolean; error?: string } {
  if (!condition || !condition.trim()) return { valid: true };

  try {
    const clauses = condition.split("&&");
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (!trimmed) continue;

      const hasNeq = trimmed.includes("!=");
      const hasEq = trimmed.includes("=");

      if (!hasNeq && !hasEq) {
        // bare key - valid
        continue;
      }

      // Find the operator position
      const op = hasNeq ? "!=" : "=";
      const idx = trimmed.indexOf(op);
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + op.length).trim();

      if (!key) {
        return { valid: false, error: `Empty key in condition clause: "${clause}"` };
      }
      if (!value) {
        return { valid: false, error: `Empty value in condition clause: "${clause}"` };
      }
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}
