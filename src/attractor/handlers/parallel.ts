// Parallel Handler (fan-out) - Section 4.8

import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";
import { Graph } from "../types.ts";

export class ParallelHandler implements Handler {
  // executeSubgraph is injected by the engine to avoid circular deps
  constructor(
    private executeSubgraph: (
      startNodeId: string,
      context: import("../context.ts").Context,
      graph: import("../types.ts").Graph,
      logsRoot: string
    ) => Promise<Outcome>
  ) {}

  async execute(hctx: HandlerContext): Promise<Outcome> {
    const { node, context, graph, logsRoot } = hctx;

    // 1. Fan-out edges
    const branches = Graph.outgoingEdges(graph, node.id);
    if (branches.length === 0) {
      return { status: "SUCCESS", notes: "Parallel node has no branches" };
    }

    // 2. Determine policy
    const joinPolicy = (node.attrs["join_policy"] as string | undefined) ?? "wait_all";
    const maxParallel = Number(node.attrs["max_parallel"] ?? 4);

    // 3. Execute branches concurrently
    const results: Outcome[] = [];
    const chunks: typeof branches[] = [];

    for (let i = 0; i < branches.length; i += maxParallel) {
      chunks.push(branches.slice(i, i + maxParallel));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async (branch) => {
          const branchCtx = context.clone();
          try {
            return await this.executeSubgraph(branch.toNode, branchCtx, graph, logsRoot);
          } catch (err) {
            return { status: "FAIL" as const, failureReason: String(err) };
          }
        })
      );
      results.push(...chunkResults);

      if (joinPolicy === "first_success" && chunkResults.some((r) => r.status === "SUCCESS")) {
        break;
      }
    }

    // 4. Store results in context
    context.set("parallel.results", results);

    // 5. Evaluate join policy
    const successCount = results.filter((r) => r.status === "SUCCESS" || r.status === "PARTIAL_SUCCESS").length;
    const failCount = results.filter((r) => r.status === "FAIL").length;

    if (joinPolicy === "wait_all") {
      return {
        status: failCount === 0 ? "SUCCESS" : "PARTIAL_SUCCESS",
        contextUpdates: { "parallel.results": results },
        notes: `Parallel complete: ${successCount} succeeded, ${failCount} failed`,
      };
    }

    if (joinPolicy === "first_success") {
      return {
        status: successCount > 0 ? "SUCCESS" : "FAIL",
        contextUpdates: { "parallel.results": results },
        failureReason: successCount === 0 ? "No parallel branch succeeded" : undefined,
      };
    }

    return { status: "SUCCESS", contextUpdates: { "parallel.results": results } };
  }
}
