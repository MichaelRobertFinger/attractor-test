// Pipeline Execution Engine - Section 3

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Graph, Node, Edge, Outcome } from "./types.ts";
import { Graph as GraphNS } from "./types.ts";
import { Context, Checkpoint } from "./context.ts";
import { evaluateCondition } from "./conditions.ts";
import { EventEmitter } from "./events.ts";
import {
  HandlerRegistry,
  StartHandler,
  ExitHandler,
  CodergenHandler,
  WaitForHumanHandler,
  ConditionalHandler,
  ParallelHandler,
  FanInHandler,
  ToolHandler,
  ManagerLoopHandler,
} from "./handlers/index.ts";
import type { CodergenBackend } from "./handlers/codergen.ts";
import type { Interviewer } from "./interviewer/types.ts";
import { AutoApproveInterviewer } from "./interviewer/implementations.ts";
import type { Transform } from "./transforms.ts";
import { applyTransforms } from "./transforms.ts";
import { validateOrRaise } from "./lint.ts";
import type { Diagnostic } from "./lint.ts";
import { parseDot } from "./parser.ts";

export interface EngineConfig {
  logsRoot?: string;
  backend?: CodergenBackend;
  interviewer?: Interviewer;
  transforms?: Transform[];
  validate?: boolean;
  skipTransforms?: boolean;
  resumeFromCheckpoint?: boolean;
}

export interface RunResult {
  status: "SUCCESS" | "FAIL";
  notes?: string;
  failureReason?: string;
  completedNodes: string[];
  nodeOutcomes: Record<string, Outcome>;
  diagnostics: Diagnostic[];
  logsRoot: string;
  context: Context;
}

// Retry policy for the engine
interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitter: boolean;
}

function buildRetryPolicy(node: Node, graph: Graph): RetryPolicy {
  const maxRetries =
    node.attrs.maxRetries != null
      ? Number(node.attrs.maxRetries)
      : Number(graph.attrs.defaultMaxRetries ?? 0);
  return {
    maxAttempts: maxRetries + 1,
    initialDelayMs: 200,
    backoffFactor: 2.0,
    maxDelayMs: 60000,
    jitter: true,
  };
}

function retryDelay(attempt: number, policy: RetryPolicy): number {
  const base = Math.min(
    policy.initialDelayMs * Math.pow(policy.backoffFactor, attempt - 1),
    policy.maxDelayMs
  );
  if (!policy.jitter) return base;
  return base * (0.5 + Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Edge selection - Section 3.3
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/^\[[a-z0-9]\]\s*/i, "")
    .replace(/^[a-z0-9]\)\s+/i, "")
    .replace(/^[a-z0-9]\s*-\s+/i, "");
}

function bestByWeightThenLexical(edges: Edge[]): Edge {
  return edges.reduce((best, e) => {
    const bw = best.attrs.weight ?? 0;
    const ew = e.attrs.weight ?? 0;
    if (ew > bw) return e;
    if (ew === bw && e.toNode < best.toNode) return e;
    return best;
  });
}

function selectEdge(
  node: Node,
  outcome: Outcome,
  context: Context,
  graph: Graph
): Edge | null {
  const edges = GraphNS.outgoingEdges(graph, node.id);
  if (edges.length === 0) return null;

  // Step 1: Condition-matching edges
  const conditionMatched: Edge[] = [];
  for (const edge of edges) {
    if (edge.attrs.condition) {
      if (evaluateCondition(edge.attrs.condition, outcome, context)) {
        conditionMatched.push(edge);
      }
    }
  }
  if (conditionMatched.length > 0) {
    return bestByWeightThenLexical(conditionMatched);
  }

  // Step 2: Preferred label
  if (outcome.preferredLabel) {
    const normalizedPreferred = normalizeLabel(outcome.preferredLabel);
    for (const edge of edges) {
      if (!edge.attrs.condition && edge.attrs.label) {
        if (normalizeLabel(edge.attrs.label) === normalizedPreferred) {
          return edge;
        }
      }
    }
  }

  // Step 3: Suggested next IDs
  if (outcome.suggestedNextIds?.length) {
    for (const suggestedId of outcome.suggestedNextIds) {
      for (const edge of edges) {
        if (!edge.attrs.condition && edge.toNode === suggestedId) {
          return edge;
        }
      }
    }
  }

  // Step 4 & 5: Weight with lexical tiebreak (unconditional edges)
  const unconditional = edges.filter((e) => !e.attrs.condition);
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional);
  }

  return null;
}

// Goal gate enforcement - Section 3.4
function checkGoalGates(
  graph: Graph,
  nodeOutcomes: Record<string, Outcome>
): { ok: boolean; failedGate?: Node } {
  for (const [nodeId, outcome] of Object.entries(nodeOutcomes)) {
    const node = graph.nodes.get(nodeId);
    if (!node?.attrs.goalGate) continue;
    if (outcome.status !== "SUCCESS" && outcome.status !== "PARTIAL_SUCCESS") {
      return { ok: false, failedGate: node };
    }
  }
  return { ok: true };
}

function getRetryTarget(failedGate: Node, graph: Graph): string | undefined {
  return (
    (failedGate.attrs.retryTarget as string | undefined) ??
    (failedGate.attrs.fallbackRetryTarget as string | undefined) ??
    (graph.attrs.retryTarget as string | undefined) ??
    (graph.attrs.fallbackRetryTarget as string | undefined)
  );
}

export class PipelineEngine {
  private registry: HandlerRegistry;
  readonly events: EventEmitter;

  constructor() {
    this.registry = new HandlerRegistry();
    this.events = new EventEmitter();
  }

  setup(config: EngineConfig): void {
    const interviewer = config.interviewer ?? new AutoApproveInterviewer();

    this.registry.register("start", new StartHandler());
    this.registry.register("exit", new ExitHandler());
    this.registry.register("codergen", new CodergenHandler(config.backend));
    this.registry.register("wait.human", new WaitForHumanHandler(interviewer));
    this.registry.register("conditional", new ConditionalHandler());
    this.registry.register(
      "parallel",
      new ParallelHandler((startNodeId, ctx, graph, logsRoot) =>
        this.executeFrom(startNodeId, ctx, graph, logsRoot, {})
      )
    );
    this.registry.register("parallel.fan_in", new FanInHandler());
    this.registry.register("tool", new ToolHandler());
    this.registry.register("stack.manager_loop", new ManagerLoopHandler());

    // Default handler
    this.registry.defaultHandler = new CodergenHandler(config.backend);
  }

  registerHandler(type: string, handler: import("./handlers/index.ts").Handler): void {
    this.registry.register(type, handler);
  }

  private async executeFrom(
    startNodeId: string,
    context: Context,
    graph: Graph,
    logsRoot: string,
    nodeOutcomes: Record<string, Outcome>
  ): Promise<Outcome> {
    const node = graph.nodes.get(startNodeId);
    if (!node) return { status: "FAIL", failureReason: `Node not found: ${startNodeId}` };

    context.set("current_node", startNodeId);

    const handler = this.registry.resolve(node);
    try {
      return await handler.execute({ node, context, graph, logsRoot });
    } catch (err) {
      return { status: "FAIL", failureReason: String(err) };
    }
  }

  async run(graph: Graph, config: EngineConfig = {}): Promise<RunResult> {
    const logsRoot = config.logsRoot ?? join(process.cwd(), ".attractor", `run-${Date.now()}`);

    // Setup handlers
    this.setup(config);

    // Apply transforms
    if (!config.skipTransforms) {
      graph = applyTransforms(graph, config.transforms);
    }

    // Validate
    const diagnostics: Diagnostic[] = [];
    if (config.validate !== false) {
      try {
        diagnostics.push(...validateOrRaise(graph));
      } catch (err) {
        if (err instanceof import("./lint.ts").then) {
          throw err;
        }
        // ValidationError - rethrow
        throw err;
      }
    }

    // Initialize
    await mkdir(logsRoot, { recursive: true });

    const context = new Context();
    // Mirror graph attributes into context
    if (graph.attrs.goal) context.set("graph.goal", graph.attrs.goal);
    for (const [k, v] of Object.entries(graph.attrs)) {
      context.set(`graph.${k}`, v);
    }

    const completedNodes: string[] = [];
    const nodeOutcomes: Record<string, Outcome> = {};

    // Write manifest
    await writeFile(
      join(logsRoot, "manifest.json"),
      JSON.stringify(
        {
          name: graph.name,
          goal: graph.attrs.goal ?? "",
          startTime: new Date().toISOString(),
        },
        null,
        2
      )
    );

    // Resume from checkpoint?
    if (config.resumeFromCheckpoint) {
      const checkpoint = await Checkpoint.load(logsRoot);
      if (checkpoint) {
        context.applyUpdates(checkpoint.context.snapshot());
        completedNodes.push(...checkpoint.completedNodes);
      }
    }

    this.events.emit("pipeline_started", { name: graph.name, id: logsRoot });

    // Find start node
    const startNode = GraphNS.findStartNode(graph);
    if (!startNode) {
      return {
        status: "FAIL",
        failureReason: "No start node found",
        completedNodes,
        nodeOutcomes,
        diagnostics,
        logsRoot,
        context,
      };
    }

    let currentNode = startNode;
    const visited = new Set<string>(completedNodes);

    // Main execution loop
    while (true) {
      context.set("current_node", currentNode.id);

      // Check for terminal node
      const handlerType = GraphNS.resolveHandlerType(currentNode);
      if (handlerType === "exit" || currentNode.attrs.shape === "Msquare") {
        const { ok, failedGate } = checkGoalGates(graph, nodeOutcomes);
        if (!ok && failedGate) {
          const retryTarget = getRetryTarget(failedGate, graph);
          if (retryTarget) {
            const targetNode = graph.nodes.get(retryTarget);
            if (targetNode) {
              currentNode = targetNode;
              continue;
            }
          }
          this.events.emit("pipeline_failed", {
            error: `Goal gate unsatisfied: ${failedGate.id}`,
          });
          return {
            status: "FAIL",
            failureReason: `Goal gate unsatisfied and no retry target: ${failedGate.id}`,
            completedNodes,
            nodeOutcomes,
            diagnostics,
            logsRoot,
            context,
          };
        }

        // Execute exit handler (no-op)
        await this.registry.resolve(currentNode).execute({
          node: currentNode,
          context,
          graph,
          logsRoot,
        });
        completedNodes.push(currentNode.id);

        this.events.emit("pipeline_completed", { duration: 0, artifactCount: 0 });
        return {
          status: "SUCCESS",
          notes: "Pipeline completed",
          completedNodes,
          nodeOutcomes,
          diagnostics,
          logsRoot,
          context,
        };
      }

      // Build retry policy
      const retryPolicy = buildRetryPolicy(currentNode, graph);

      this.events.emit("stage_started", { name: currentNode.id, index: completedNodes.length });

      // Execute with retry
      let outcome = await this.executeWithRetry(
        currentNode,
        context,
        graph,
        logsRoot,
        retryPolicy
      );

      this.events.emit("stage_completed", {
        name: currentNode.id,
        index: completedNodes.length,
        duration: 0,
      });

      // Record
      completedNodes.push(currentNode.id);
      nodeOutcomes[currentNode.id] = outcome;
      visited.add(currentNode.id);

      // Apply context updates
      if (outcome.contextUpdates) {
        context.applyUpdates(outcome.contextUpdates);
      }
      context.set("outcome", outcome.status.toLowerCase());
      if (outcome.preferredLabel) {
        context.set("preferred_label", outcome.preferredLabel);
      }

      // Save checkpoint
      const checkpoint = new Checkpoint({
        currentNode: currentNode.id,
        completedNodes: [...completedNodes],
        context,
      });
      await checkpoint.save(logsRoot);
      this.events.emit("checkpoint_saved", { nodeId: currentNode.id });

      // Select next edge
      const nextEdge = selectEdge(currentNode, outcome, context, graph);

      if (!nextEdge) {
        if (outcome.status === "FAIL") {
          // Failure routing - Section 3.7
          const retryTarget =
            (currentNode.attrs.retryTarget as string | undefined) ??
            (currentNode.attrs.fallbackRetryTarget as string | undefined);

          if (retryTarget) {
            const targetNode = graph.nodes.get(retryTarget);
            if (targetNode) {
              currentNode = targetNode;
              continue;
            }
          }

          this.events.emit("pipeline_failed", { error: outcome.failureReason });
          return {
            status: "FAIL",
            failureReason: outcome.failureReason ?? "Stage failed with no recovery path",
            completedNodes,
            nodeOutcomes,
            diagnostics,
            logsRoot,
            context,
          };
        }

        // No more edges - pipeline complete
        this.events.emit("pipeline_completed", { duration: 0 });
        return {
          status: "SUCCESS",
          notes: "Pipeline completed (no more edges)",
          completedNodes,
          nodeOutcomes,
          diagnostics,
          logsRoot,
          context,
        };
      }

      // Handle loop_restart
      if (nextEdge.attrs.loopRestart) {
        this.events.emit("loop_restart", { target: nextEdge.toNode });
        // Fresh run from target node - simplified: just continue from target
        const targetNode = graph.nodes.get(nextEdge.toNode);
        if (targetNode) {
          currentNode = targetNode;
          continue;
        }
      }

      // Apply edge-level fidelity/thread overrides to context
      if (nextEdge.attrs.fidelity) context.set("_next_fidelity", nextEdge.attrs.fidelity);
      if (nextEdge.attrs.threadId) context.set("_next_thread_id", nextEdge.attrs.threadId);

      // Advance
      const nextNode = graph.nodes.get(nextEdge.toNode);
      if (!nextNode) {
        return {
          status: "FAIL",
          failureReason: `Edge target node not found: ${nextEdge.toNode}`,
          completedNodes,
          nodeOutcomes,
          diagnostics,
          logsRoot,
          context,
        };
      }

      currentNode = nextNode;
    }
  }

  private async executeWithRetry(
    node: Node,
    context: Context,
    graph: Graph,
    logsRoot: string,
    policy: RetryPolicy
  ): Promise<Outcome> {
    const handler = this.registry.resolve(node);

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      let outcome: Outcome;

      try {
        outcome = await handler.execute({ node, context, graph, logsRoot });
      } catch (err) {
        if (attempt < policy.maxAttempts) {
          const delay = retryDelay(attempt, policy);
          this.events.emit("stage_retrying", {
            name: node.id,
            attempt,
            delay,
            error: String(err),
          });
          await sleep(delay);
          continue;
        }
        return { status: "FAIL", failureReason: String(err) };
      }

      if (outcome.status === "SUCCESS" || outcome.status === "PARTIAL_SUCCESS") {
        context.set(`internal.retry_count.${node.id}`, 0);
        return outcome;
      }

      if (outcome.status === "RETRY") {
        if (attempt < policy.maxAttempts) {
          const retryCount = (context.getNumber(`internal.retry_count.${node.id}`) ?? 0) + 1;
          context.set(`internal.retry_count.${node.id}`, retryCount);
          const delay = retryDelay(attempt, policy);
          this.events.emit("stage_retrying", {
            name: node.id,
            index: 0,
            attempt,
            delay,
          });
          await sleep(delay);
          continue;
        }

        if (node.attrs.allowPartial) {
          return { status: "PARTIAL_SUCCESS", notes: "retries exhausted, partial accepted" };
        }
        return { status: "FAIL", failureReason: "max retries exceeded" };
      }

      if (outcome.status === "FAIL") {
        return outcome;
      }

      return outcome;
    }

    return { status: "FAIL", failureReason: "max retries exceeded" };
  }

  async runDot(source: string, config: EngineConfig = {}): Promise<RunResult> {
    const graph = parseDot(source);
    return this.run(graph, config);
  }
}

// Convenience factory
export function createEngine(): PipelineEngine {
  return new PipelineEngine();
}
