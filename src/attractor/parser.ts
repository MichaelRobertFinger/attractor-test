// DOT parser for Attractor - implements the restricted subset from spec Section 2

import type { Graph, Node, Edge, GraphAttrs, NodeAttrs, EdgeAttrs } from "./types.ts";

class ParseError extends Error {
  constructor(message: string, public position: number) {
    super(message);
    this.name = "ParseError";
  }
}

// Tokenizer
type TokenType =
  | "DIGRAPH" | "GRAPH_KW" | "NODE_KW" | "EDGE_KW" | "SUBGRAPH"
  | "IDENT" | "STRING" | "NUMBER" | "BOOL"
  | "LBRACE" | "RBRACE" | "LBRACKET" | "RBRACKET"
  | "ARROW" | "EQ" | "COMMA" | "SEMICOLON"
  | "EOF";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function tokenize(source: string): Token[] {
  // Strip comments
  let s = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const tokens: Token[] = [];
  let i = 0;

  while (i < s.length) {
    // Skip whitespace
    if (/\s/.test(s[i]!)) { i++; continue; }

    const pos = i;

    // Arrow
    if (s.slice(i, i + 2) === "->") {
      tokens.push({ type: "ARROW", value: "->", pos });
      i += 2;
      continue;
    }

    // Punctuation
    const punc: Record<string, TokenType> = {
      "{": "LBRACE", "}": "RBRACE",
      "[": "LBRACKET", "]": "RBRACKET",
      "=": "EQ", ",": "COMMA", ";": "SEMICOLON",
    };
    if (s[i]! in punc) {
      tokens.push({ type: punc[s[i]!]!, value: s[i]!, pos });
      i++;
      continue;
    }

    // String
    if (s[i] === '"') {
      let str = "";
      i++; // skip opening quote
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") {
          i++;
          const esc: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"' };
          str += esc[s[i]!] ?? s[i]!;
        } else {
          str += s[i]!;
        }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: "STRING", value: str, pos });
      continue;
    }

    // Identifiers and keywords
    if (/[A-Za-z_]/.test(s[i]!)) {
      let id = "";
      while (i < s.length && /[A-Za-z0-9_.\-:]/.test(s[i]!)) {
        id += s[i]!;
        i++;
      }
      const keywords: Record<string, TokenType> = {
        digraph: "DIGRAPH",
        graph: "GRAPH_KW",
        node: "NODE_KW",
        edge: "EDGE_KW",
        subgraph: "SUBGRAPH",
        true: "BOOL",
        false: "BOOL",
      };
      const tt = keywords[id.toLowerCase()];
      if (tt) {
        tokens.push({ type: tt, value: id, pos });
      } else {
        tokens.push({ type: "IDENT", value: id, pos });
      }
      continue;
    }

    // Numbers (including duration like 900s, 15m, etc.)
    if (/[0-9\-]/.test(s[i]!)) {
      let num = "";
      if (s[i] === "-") { num += "-"; i++; }
      while (i < s.length && /[0-9.]/.test(s[i]!)) {
        num += s[i]!;
        i++;
      }
      // Duration suffix
      while (i < s.length && /[a-z]/.test(s[i]!)) {
        num += s[i]!;
        i++;
      }
      tokens.push({ type: "NUMBER", value: num, pos });
      continue;
    }

    // Unknown character - skip
    i++;
  }

  tokens.push({ type: "EOF", value: "", pos: s.length });
  return tokens;
}

// Value parser
function parseValue(value: string): unknown {
  // Boolean
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;

  // Duration -> milliseconds
  const durationMatch = value.match(/^(-?\d+)(ms|s|m|h|d)$/);
  if (durationMatch) {
    const num = parseInt(durationMatch[1]!, 10);
    const unit = durationMatch[2]!;
    const multipliers: Record<string, number> = {
      ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000,
    };
    return num * (multipliers[unit] ?? 1);
  }

  // Float
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  // Integer
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);

  // String
  return value;
}

// Convert parsed attribute key to camelCase internal name
function normalizeAttrKey(key: string): string {
  // Handle qualified keys like "tool.command" -> keep as is for custom attrs
  const map: Record<string, string> = {
    label: "label",
    shape: "shape",
    type: "type",
    prompt: "prompt",
    max_retries: "maxRetries",
    max_retry: "maxRetries", // legacy alias
    goal_gate: "goalGate",
    retry_target: "retryTarget",
    fallback_retry_target: "fallbackRetryTarget",
    fidelity: "fidelity",
    thread_id: "threadId",
    class: "class",
    timeout: "timeout",
    llm_model: "llmModel",
    llm_provider: "llmProvider",
    reasoning_effort: "reasoningEffort",
    auto_status: "autoStatus",
    allow_partial: "allowPartial",
    // Graph attrs
    goal: "goal",
    model_stylesheet: "modelStylesheet",
    default_max_retries: "defaultMaxRetries",
    default_max_retry: "defaultMaxRetries",
    default_fidelity: "defaultFidelity",
    // Edge attrs
    condition: "condition",
    weight: "weight",
    loop_restart: "loopRestart",
    // Subgraph layout
    rankdir: "rankdir",
    // passthrough everything else as-is
  };
  return map[key] ?? key;
}

function normalizeEdgeAttrKey(key: string): string {
  const map: Record<string, string> = {
    label: "label",
    condition: "condition",
    weight: "weight",
    fidelity: "fidelity",
    thread_id: "threadId",
    loop_restart: "loopRestart",
  };
  return map[key] ?? key;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "EOF", value: "", pos: 0 };
  }

  private consume(): Token {
    const t = this.tokens[this.pos]!;
    this.pos++;
    return t;
  }

  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new ParseError(
        `Expected ${type} but got ${t.type} ("${t.value}") at position ${t.pos}`,
        t.pos
      );
    }
    return this.consume();
  }

  private tryConsume(type: TokenType): Token | null {
    if (this.peek().type === type) return this.consume();
    return null;
  }

  private parseIdent(): string {
    const t = this.peek();
    if (
      t.type === "IDENT" ||
      t.type === "GRAPH_KW" ||
      t.type === "NODE_KW" ||
      t.type === "EDGE_KW" ||
      t.type === "SUBGRAPH" ||
      t.type === "DIGRAPH"
    ) {
      return this.consume().value;
    }
    throw new ParseError(`Expected identifier but got ${t.type} ("${t.value}")`, t.pos);
  }

  private parseValue(): string {
    const t = this.peek();
    if (t.type === "STRING") return this.consume().value;
    if (t.type === "NUMBER") return this.consume().value;
    if (t.type === "BOOL") return this.consume().value;
    if (t.type === "IDENT" || t.type === "GRAPH_KW" || t.type === "NODE_KW" || t.type === "EDGE_KW") {
      // BareValue - may include dots and colons
      return this.consume().value;
    }
    throw new ParseError(`Expected value but got ${t.type} ("${t.value}")`, t.pos);
  }

  private parseAttrBlock(): Record<string, string> {
    this.expect("LBRACKET");
    const attrs: Record<string, string> = {};

    while (this.peek().type !== "RBRACKET" && this.peek().type !== "EOF") {
      // Key can be a qualified identifier like "human.default_choice"
      let key = this.parseIdent();
      // Check for qualified key
      while (this.peek().type === "IDENT" && this.tokens[this.pos - 1]?.value === ".") {
        key += "." + this.parseIdent();
      }
      this.expect("EQ");
      const value = this.parseValue();
      attrs[key] = value;

      this.tryConsume("COMMA");
      // Allow semicolons as separators inside attr blocks too
      this.tryConsume("SEMICOLON");
    }

    this.expect("RBRACKET");
    return attrs;
  }

  parse(): Graph {
    this.expect("DIGRAPH");

    // Optional graph name
    let graphName = "G";
    if (this.peek().type === "IDENT") {
      graphName = this.consume().value;
    }

    this.expect("LBRACE");

    const graphAttrs: GraphAttrs = {};
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Default blocks
    const nodeDefaults: NodeAttrs = {};
    const edgeDefaults: EdgeAttrs = {};

    const parseStatements = (
      subgraphLabel?: string,
      inheritedNodeAttrs: NodeAttrs = {}
    ) => {
      while (
        this.peek().type !== "RBRACE" &&
        this.peek().type !== "EOF"
      ) {
        const t = this.peek();

        // graph [...]
        if (t.type === "GRAPH_KW") {
          this.consume();
          if (this.peek().type === "LBRACKET") {
            const rawAttrs = this.parseAttrBlock();
            for (const [k, v] of Object.entries(rawAttrs)) {
              const nk = normalizeAttrKey(k);
              (graphAttrs as Record<string, unknown>)[nk] = parseValue(v);
            }
          }
          this.tryConsume("SEMICOLON");
          continue;
        }

        // node [...]
        if (t.type === "NODE_KW") {
          this.consume();
          if (this.peek().type === "LBRACKET") {
            const rawAttrs = this.parseAttrBlock();
            for (const [k, v] of Object.entries(rawAttrs)) {
              const nk = normalizeAttrKey(k);
              (nodeDefaults as Record<string, unknown>)[nk] = parseValue(v);
              // Also apply to inherited
              (inheritedNodeAttrs as Record<string, unknown>)[nk] = parseValue(v);
            }
          }
          this.tryConsume("SEMICOLON");
          continue;
        }

        // edge [...]
        if (t.type === "EDGE_KW") {
          this.consume();
          if (this.peek().type === "LBRACKET") {
            const rawAttrs = this.parseAttrBlock();
            for (const [k, v] of Object.entries(rawAttrs)) {
              const nk = normalizeEdgeAttrKey(k);
              (edgeDefaults as Record<string, unknown>)[nk] = parseValue(v);
            }
          }
          this.tryConsume("SEMICOLON");
          continue;
        }

        // subgraph
        if (t.type === "SUBGRAPH") {
          this.consume();
          let sgLabel: string | undefined;
          if (this.peek().type === "IDENT") {
            sgLabel = this.consume().value;
          }
          this.expect("LBRACE");

          // Try to read subgraph-level attrs
          let derivedClass: string | undefined;
          const subInherited = { ...inheritedNodeAttrs };

          parseStatements(sgLabel, subInherited);
          this.expect("RBRACE");
          void derivedClass;
          this.tryConsume("SEMICOLON");
          continue;
        }

        // Graph-level attr declaration: key = value
        if (
          t.type === "IDENT" &&
          this.tokens[this.pos + 1]?.type === "EQ" &&
          this.tokens[this.pos + 2]?.type !== "EQ"
        ) {
          const key = this.consume().value;
          this.expect("EQ");
          const value = this.parseValue();
          const nk = normalizeAttrKey(key);
          (graphAttrs as Record<string, unknown>)[nk] = parseValue(value);
          this.tryConsume("SEMICOLON");
          continue;
        }

        // Node or edge statement
        // Peek ahead to determine if edge (has ->)
        const id = this.parseIdent();

        if (this.peek().type === "ARROW") {
          // Edge statement: id -> id -> id ... [attrs]
          const chain = [id];
          while (this.peek().type === "ARROW") {
            this.consume(); // ->
            chain.push(this.parseIdent());
          }

          let rawEdgeAttrs: Record<string, string> = {};
          if (this.peek().type === "LBRACKET") {
            rawEdgeAttrs = this.parseAttrBlock();
          }

          const edgeAttrs: EdgeAttrs = { ...edgeDefaults };
          for (const [k, v] of Object.entries(rawEdgeAttrs)) {
            const nk = normalizeEdgeAttrKey(k);
            (edgeAttrs as Record<string, unknown>)[nk] = parseValue(v);
          }

          // Ensure all nodes in chain exist
          for (const nodeId of chain) {
            if (!nodes.has(nodeId)) {
              nodes.set(nodeId, {
                id: nodeId,
                attrs: { ...inheritedNodeAttrs },
                subgraphLabel,
              });
            }
          }

          // Create individual edges for each pair (chained edge expansion)
          for (let i = 0; i < chain.length - 1; i++) {
            edges.push({
              fromNode: chain[i]!,
              toNode: chain[i + 1]!,
              attrs: { ...edgeAttrs },
            });
          }

          this.tryConsume("SEMICOLON");
        } else {
          // Node statement
          let rawNodeAttrs: Record<string, string> = {};
          if (this.peek().type === "LBRACKET") {
            rawNodeAttrs = this.parseAttrBlock();
          }

          const nodeAttrs: NodeAttrs = { ...inheritedNodeAttrs };
          for (const [k, v] of Object.entries(rawNodeAttrs)) {
            const nk = normalizeAttrKey(k);
            (nodeAttrs as Record<string, unknown>)[nk] = parseValue(v);
          }

          const existing = nodes.get(id);
          if (existing) {
            // Merge attrs - explicit attrs override existing
            nodes.set(id, {
              ...existing,
              attrs: { ...existing.attrs, ...nodeAttrs },
              subgraphLabel: subgraphLabel ?? existing.subgraphLabel,
            });
          } else {
            nodes.set(id, { id, attrs: nodeAttrs, subgraphLabel });
          }

          this.tryConsume("SEMICOLON");
        }
      }
    };

    parseStatements();
    this.expect("RBRACE");

    return {
      name: graphName,
      attrs: graphAttrs,
      nodes,
      edges,
      source: "",
    };
  }
}

export function parseDot(source: string): Graph {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  const graph = parser.parse();
  graph.source = source;
  return graph;
}
