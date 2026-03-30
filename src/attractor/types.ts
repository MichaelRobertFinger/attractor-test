// Attractor - Core Types

export type NodeShape =
  | "Mdiamond"
  | "Msquare"
  | "box"
  | "hexagon"
  | "diamond"
  | "component"
  | "tripleoctagon"
  | "parallelogram"
  | "house"
  | string;

export type HandlerType =
  | "start"
  | "exit"
  | "codergen"
  | "wait.human"
  | "conditional"
  | "parallel"
  | "parallel.fan_in"
  | "tool"
  | "stack.manager_loop"
  | string;

export const SHAPE_TO_HANDLER: Record<string, HandlerType> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  hexagon: "wait.human",
  diamond: "conditional",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
  house: "stack.manager_loop",
};

export interface NodeAttrs {
  label?: string;
  shape?: NodeShape;
  type?: HandlerType;
  prompt?: string;
  maxRetries?: number;
  goalGate?: boolean;
  retryTarget?: string;
  fallbackRetryTarget?: string;
  fidelity?: string;
  threadId?: string;
  class?: string;
  timeout?: number; // milliseconds
  llmModel?: string;
  llmProvider?: string;
  reasoningEffort?: "low" | "medium" | "high";
  autoStatus?: boolean;
  allowPartial?: boolean;
  // additional attrs stored here
  [key: string]: unknown;
}

export interface EdgeAttrs {
  label?: string;
  condition?: string;
  weight?: number;
  fidelity?: string;
  threadId?: string;
  loopRestart?: boolean;
}

export interface Node {
  id: string;
  attrs: NodeAttrs;
  subgraphLabel?: string; // derived class from enclosing subgraph
}

export interface Edge {
  fromNode: string;
  toNode: string;
  attrs: EdgeAttrs;
}

export interface GraphAttrs {
  goal?: string;
  label?: string;
  modelStylesheet?: string;
  defaultMaxRetries?: number;
  retryTarget?: string;
  fallbackRetryTarget?: string;
  defaultFidelity?: string;
  [key: string]: unknown;
}

export interface Graph {
  name: string;
  attrs: GraphAttrs;
  nodes: Map<string, Node>;
  edges: Edge[];
  source: string; // original DOT source
}

export namespace Graph {
  export function outgoingEdges(graph: Graph, nodeId: string): Edge[] {
    return graph.edges.filter((e) => e.fromNode === nodeId);
  }

  export function incomingEdges(graph: Graph, nodeId: string): Edge[] {
    return graph.edges.filter((e) => e.toNode === nodeId);
  }

  export function findStartNode(graph: Graph): Node | undefined {
    // 1. shape=Mdiamond
    for (const node of graph.nodes.values()) {
      if (node.attrs.shape === "Mdiamond") return node;
    }
    // 2. id="start" or "Start"
    return graph.nodes.get("start") ?? graph.nodes.get("Start");
  }

  export function findExitNode(graph: Graph): Node | undefined {
    // 1. shape=Msquare
    for (const node of graph.nodes.values()) {
      if (node.attrs.shape === "Msquare") return node;
    }
    // 2. id="exit" or "end"
    return graph.nodes.get("exit") ?? graph.nodes.get("end");
  }

  export function resolveHandlerType(node: Node): HandlerType {
    if (node.attrs.type) return node.attrs.type;
    const shape = node.attrs.shape ?? "box";
    return SHAPE_TO_HANDLER[shape] ?? "codergen";
  }
}

export type StageStatus = "SUCCESS" | "FAIL" | "PARTIAL_SUCCESS" | "RETRY" | "SKIPPED";

export interface Outcome {
  status: StageStatus;
  preferredLabel?: string;
  suggestedNextIds?: string[];
  contextUpdates?: Record<string, unknown>;
  notes?: string;
  failureReason?: string;
}

export namespace Outcome {
  export function success(notes?: string, contextUpdates?: Record<string, unknown>): Outcome {
    return { status: "SUCCESS", notes, contextUpdates };
  }
  export function fail(reason: string): Outcome {
    return { status: "FAIL", failureReason: reason };
  }
  export function retry(reason?: string): Outcome {
    return { status: "RETRY", failureReason: reason };
  }
  export function partialSuccess(notes?: string): Outcome {
    return { status: "PARTIAL_SUCCESS", notes };
  }
}
