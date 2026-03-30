import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";

export class StartHandler implements Handler {
  async execute(_hctx: HandlerContext): Promise<Outcome> {
    return { status: "SUCCESS" };
  }
}
