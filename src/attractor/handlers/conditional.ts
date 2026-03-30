import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";

export class ConditionalHandler implements Handler {
  async execute(hctx: HandlerContext): Promise<Outcome> {
    return {
      status: "SUCCESS",
      notes: `Conditional node evaluated: ${hctx.node.id}`,
    };
  }
}
