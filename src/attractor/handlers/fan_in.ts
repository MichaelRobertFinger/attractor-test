// Fan-In Handler - Section 4.9

import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";

export class FanInHandler implements Handler {
  async execute(hctx: HandlerContext): Promise<Outcome> {
    const { node, context } = hctx;

    // 1. Read parallel results
    const results = context.get("parallel.results") as Outcome[] | undefined;
    if (!results || results.length === 0) {
      return { status: "FAIL", failureReason: "No parallel results to evaluate" };
    }

    // 2. Heuristic selection
    const statusRank: Record<string, number> = {
      SUCCESS: 0,
      PARTIAL_SUCCESS: 1,
      RETRY: 2,
      FAIL: 3,
      SKIPPED: 4,
    };

    const sorted = [...results].sort(
      (a, b) => (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99)
    );

    const best = sorted[0]!;

    if (best.status === "FAIL") {
      return {
        status: "FAIL",
        failureReason: "All parallel branches failed",
      };
    }

    return {
      status: "SUCCESS",
      contextUpdates: {
        "parallel.fan_in.best_outcome": best.status,
      },
      notes: `Fan-in selected best candidate with status: ${best.status}`,
    };
  }
}
