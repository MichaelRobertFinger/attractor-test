// Validation and Linting - Section 7

import type { Graph, Node, Edge } from "./types.ts";
import { parseCondition } from "./conditions.ts";
import { parseStylesheet } from "./stylesheet.ts";

export type Severity = "ERROR" | "WARNING" | "INFO";

export interface Diagnostic {
  rule: string;
  severity: Severity;
  message: string;
  nodeId?: string;
  edge?: [string, string];
  fix?: string;
}

export class ValidationError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "ERROR");
    super(
      `Pipeline validation failed with ${errors.length} error(s):\n` +
        errors.map((d) => `  [${d.rule}] ${d.message}`).join("\n")
    );
    this.name = "ValidationError";
  }
}

type LintRule = (graph: Graph) => Diagnostic[];

function findStartNodes(graph: Graph): Node[] {
  const byShape = Array.from(graph.nodes.values()).filter(
    (n) => n.attrs.shape === "Mdiamond"
  );
  if (byShape.length > 0) return byShape;
  const byId = ["start", "Start"].flatMap((id) => {
    const n = graph.nodes.get(id);
    return n ? [n] : [];
  });
  return byId;
}

function findExitNodes(graph: Graph): Node[] {
  const byShape = Array.from(graph.nodes.values()).filter(
    (n) => n.attrs.shape === "Msquare"
  );
  if (byShape.length > 0) return byShape;
  const byId = ["exit", "end"].flatMap((id) => {
    const n = graph.nodes.get(id);
    return n ? [n] : [];
  });
  return byId;
}

const BUILT_IN_RULES: LintRule[] = [
  // start_node: exactly one start node
  (graph) => {
    const starts = findStartNodes(graph);
    if (starts.length === 0) {
      return [
        {
          rule: "start_node",
          severity: "ERROR",
          message:
            'Pipeline must have exactly one start node (shape=Mdiamond or id "start"/"Start")',
          fix: 'Add a node with shape=Mdiamond: start [shape=Mdiamond, label="Start"]',
        },
      ];
    }
    if (starts.length > 1) {
      return [
        {
          rule: "start_node",
          severity: "ERROR",
          message: `Pipeline has ${starts.length} start nodes; exactly one is required`,
          fix: "Remove extra start nodes or change their shape",
        },
      ];
    }
    return [];
  },

  // terminal_node: exactly one exit node
  (graph) => {
    const exits = findExitNodes(graph);
    if (exits.length === 0) {
      return [
        {
          rule: "terminal_node",
          severity: "ERROR",
          message:
            'Pipeline must have exactly one terminal node (shape=Msquare or id "exit"/"end")',
          fix: 'Add a node with shape=Msquare: exit [shape=Msquare, label="Exit"]',
        },
      ];
    }
    if (exits.length > 1) {
      return [
        {
          rule: "terminal_node",
          severity: "ERROR",
          message: `Pipeline has ${exits.length} terminal nodes; exactly one is required`,
        },
      ];
    }
    return [];
  },

  // start_no_incoming: start node has no incoming edges
  (graph) => {
    const starts = findStartNodes(graph);
    const diagnostics: Diagnostic[] = [];
    for (const start of starts) {
      const incoming = graph.edges.filter((e) => e.toNode === start.id);
      if (incoming.length > 0) {
        diagnostics.push({
          rule: "start_no_incoming",
          severity: "ERROR",
          message: `Start node "${start.id}" must have no incoming edges`,
          nodeId: start.id,
        });
      }
    }
    return diagnostics;
  },

  // exit_no_outgoing: exit node has no outgoing edges
  (graph) => {
    const exits = findExitNodes(graph);
    const diagnostics: Diagnostic[] = [];
    for (const exit of exits) {
      const outgoing = graph.edges.filter((e) => e.fromNode === exit.id);
      if (outgoing.length > 0) {
        diagnostics.push({
          rule: "exit_no_outgoing",
          severity: "ERROR",
          message: `Terminal node "${exit.id}" must have no outgoing edges`,
          nodeId: exit.id,
        });
      }
    }
    return diagnostics;
  },

  // edge_target_exists: all edge targets must exist
  (graph) => {
    const diagnostics: Diagnostic[] = [];
    for (const edge of graph.edges) {
      if (!graph.nodes.has(edge.fromNode)) {
        diagnostics.push({
          rule: "edge_target_exists",
          severity: "ERROR",
          message: `Edge references non-existent source node "${edge.fromNode}"`,
          edge: [edge.fromNode, edge.toNode],
        });
      }
      if (!graph.nodes.has(edge.toNode)) {
        diagnostics.push({
          rule: "edge_target_exists",
          severity: "ERROR",
          message: `Edge references non-existent target node "${edge.toNode}"`,
          edge: [edge.fromNode, edge.toNode],
        });
      }
    }
    return diagnostics;
  },

  // reachability: all nodes reachable from start
  (graph) => {
    const starts = findStartNodes(graph);
    if (starts.length !== 1) return []; // start_node rule handles this

    const start = starts[0]!;
    const visited = new Set<string>();
    const queue = [start.id];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      for (const edge of graph.edges) {
        if (edge.fromNode === nodeId && !visited.has(edge.toNode)) {
          queue.push(edge.toNode);
        }
      }
    }

    const diagnostics: Diagnostic[] = [];
    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        diagnostics.push({
          rule: "reachability",
          severity: "ERROR",
          message: `Node "${nodeId}" is unreachable from the start node`,
          nodeId,
          fix: `Add an edge from an existing node to "${nodeId}", or remove it`,
        });
      }
    }
    return diagnostics;
  },

  // condition_syntax: edge conditions must parse correctly
  (graph) => {
    const diagnostics: Diagnostic[] = [];
    for (const edge of graph.edges) {
      if (edge.attrs.condition) {
        const result = parseCondition(edge.attrs.condition);
        if (!result.valid) {
          diagnostics.push({
            rule: "condition_syntax",
            severity: "ERROR",
            message: `Invalid condition expression on edge ${edge.fromNode} -> ${edge.toNode}: ${result.error}`,
            edge: [edge.fromNode, edge.toNode],
          });
        }
      }
    }
    return diagnostics;
  },

  // stylesheet_syntax: model_stylesheet must be valid
  (graph) => {
    if (!graph.attrs.modelStylesheet) return [];
    const result = parseStylesheet(String(graph.attrs.modelStylesheet));
    if (result.error) {
      return [
        {
          rule: "stylesheet_syntax",
          severity: "ERROR",
          message: `Invalid model_stylesheet: ${result.error}`,
        },
      ];
    }
    return [];
  },

  // type_known: node type values should be recognized
  (graph) => {
    const knownTypes = new Set([
      "start", "exit", "codergen", "wait.human", "conditional",
      "parallel", "parallel.fan_in", "tool", "stack.manager_loop",
    ]);
    const diagnostics: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (node.attrs.type && !knownTypes.has(node.attrs.type as string)) {
        diagnostics.push({
          rule: "type_known",
          severity: "WARNING",
          message: `Node "${node.id}" has unrecognized type "${node.attrs.type}"`,
          nodeId: node.id,
        });
      }
    }
    return diagnostics;
  },

  // fidelity_valid: fidelity values must be valid
  (graph) => {
    const validFidelities = new Set([
      "full", "truncate", "compact", "summary:low", "summary:medium", "summary:high",
    ]);
    const diagnostics: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (node.attrs.fidelity && !validFidelities.has(String(node.attrs.fidelity))) {
        diagnostics.push({
          rule: "fidelity_valid",
          severity: "WARNING",
          message: `Node "${node.id}" has invalid fidelity "${node.attrs.fidelity}"`,
          nodeId: node.id,
        });
      }
    }
    for (const edge of graph.edges) {
      if (edge.attrs.fidelity && !validFidelities.has(edge.attrs.fidelity)) {
        diagnostics.push({
          rule: "fidelity_valid",
          severity: "WARNING",
          message: `Edge ${edge.fromNode} -> ${edge.toNode} has invalid fidelity "${edge.attrs.fidelity}"`,
          edge: [edge.fromNode, edge.toNode],
        });
      }
    }
    return diagnostics;
  },

  // retry_target_exists: retry targets must reference existing nodes
  (graph) => {
    const diagnostics: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (node.attrs.retryTarget && !graph.nodes.has(String(node.attrs.retryTarget))) {
        diagnostics.push({
          rule: "retry_target_exists",
          severity: "WARNING",
          message: `Node "${node.id}" retry_target "${node.attrs.retryTarget}" does not exist`,
          nodeId: node.id,
        });
      }
      if (node.attrs.fallbackRetryTarget && !graph.nodes.has(String(node.attrs.fallbackRetryTarget))) {
        diagnostics.push({
          rule: "retry_target_exists",
          severity: "WARNING",
          message: `Node "${node.id}" fallback_retry_target "${node.attrs.fallbackRetryTarget}" does not exist`,
          nodeId: node.id,
        });
      }
    }
    return diagnostics;
  },

  // goal_gate_has_retry: goal gate nodes should have a retry target
  (graph) => {
    const diagnostics: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      if (node.attrs.goalGate && !node.attrs.retryTarget && !node.attrs.fallbackRetryTarget
          && !graph.attrs.retryTarget && !graph.attrs.fallbackRetryTarget) {
        diagnostics.push({
          rule: "goal_gate_has_retry",
          severity: "WARNING",
          message: `Node "${node.id}" has goal_gate=true but no retry_target configured`,
          nodeId: node.id,
          fix: `Add retry_target="<nodeId>" to "${node.id}" or graph-level retry_target`,
        });
      }
    }
    return diagnostics;
  },

  // prompt_on_llm_nodes: codergen nodes should have a prompt
  (graph) => {
    const { SHAPE_TO_HANDLER } = require("./types.ts");
    const diagnostics: Diagnostic[] = [];
    for (const node of graph.nodes.values()) {
      const handlerType = node.attrs.type ?? SHAPE_TO_HANDLER[node.attrs.shape ?? "box"] ?? "codergen";
      if (handlerType === "codergen" && !node.attrs.prompt && !node.attrs.label) {
        diagnostics.push({
          rule: "prompt_on_llm_nodes",
          severity: "WARNING",
          message: `LLM node "${node.id}" has no prompt or label`,
          nodeId: node.id,
          fix: `Add a prompt attribute: ${node.id} [prompt="..."]`,
        });
      }
    }
    return diagnostics;
  },
];

export function validate(graph: Graph, extraRules: LintRule[] = []): Diagnostic[] {
  const allRules = [...BUILT_IN_RULES, ...extraRules];
  const diagnostics: Diagnostic[] = [];
  for (const rule of allRules) {
    try {
      diagnostics.push(...rule(graph));
    } catch (err) {
      diagnostics.push({
        rule: "internal",
        severity: "WARNING",
        message: `Lint rule threw an error: ${err}`,
      });
    }
  }
  return diagnostics;
}

export function validateOrRaise(graph: Graph, extraRules: LintRule[] = []): Diagnostic[] {
  const diagnostics = validate(graph, extraRules);
  const errors = diagnostics.filter((d) => d.severity === "ERROR");
  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
  return diagnostics;
}
