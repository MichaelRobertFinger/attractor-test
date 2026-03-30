// Manager Loop Handler (supervisor) - Section 4.11

import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";
import { evaluateCondition } from "../conditions.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ManagerLoopHandler implements Handler {
  async execute(hctx: HandlerContext): Promise<Outcome> {
    const { node, context } = hctx;

    const pollInterval = Number(node.attrs["manager.poll_interval"] ?? 45000);
    const maxCycles = Number(node.attrs["manager.max_cycles"] ?? 1000);
    const stopCondition = node.attrs["manager.stop_condition"] as string | undefined;

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      // Check child pipeline status from context
      const childStatus = context.getString("context.stack.child.status");

      if (childStatus === "completed" || childStatus === "failed") {
        const childOutcome = context.getString("context.stack.child.outcome");
        if (childOutcome === "success") {
          return { status: "SUCCESS", notes: "Child pipeline completed successfully" };
        }
        if (childStatus === "failed") {
          return { status: "FAIL", failureReason: "Child pipeline failed" };
        }
      }

      // Evaluate stop condition
      if (stopCondition) {
        const fakeOutcome: Outcome = { status: "SUCCESS" };
        if (evaluateCondition(stopCondition, fakeOutcome, context)) {
          return { status: "SUCCESS", notes: "Stop condition satisfied" };
        }
      }

      await sleep(pollInterval);
    }

    return { status: "FAIL", failureReason: "Max cycles exceeded in manager loop" };
  }
}
