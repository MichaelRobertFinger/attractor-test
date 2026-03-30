// Handler registry and interface - Section 4.1-4.2

import type { Node, Graph, Outcome, HandlerType } from "../types.ts";
import { SHAPE_TO_HANDLER } from "../types.ts";
import type { Context } from "../context.ts";

export interface HandlerContext {
  node: Node;
  context: Context;
  graph: Graph;
  logsRoot: string;
}

export interface Handler {
  execute(hctx: HandlerContext): Promise<Outcome>;
}

export class HandlerRegistry {
  private handlers: Map<string, Handler> = new Map();
  defaultHandler?: Handler;

  register(type: HandlerType, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  resolve(node: Node): Handler {
    // 1. Explicit type attribute
    const nodeType = node.attrs.type as HandlerType | undefined;
    if (nodeType && this.handlers.has(nodeType)) {
      return this.handlers.get(nodeType)!;
    }

    // 2. Shape-based resolution
    const shape = node.attrs.shape ?? "box";
    const handlerType = SHAPE_TO_HANDLER[shape];
    if (handlerType && this.handlers.has(handlerType)) {
      return this.handlers.get(handlerType)!;
    }

    // 3. Default
    if (this.defaultHandler) return this.defaultHandler;

    // Fallback to codergen if registered
    const codergen = this.handlers.get("codergen");
    if (codergen) return codergen;

    throw new Error(`No handler found for node "${node.id}" (shape=${shape}, type=${nodeType})`);
  }
}

export { StartHandler } from "./start.ts";
export { ExitHandler } from "./exit.ts";
export { CodergenHandler } from "./codergen.ts";
export { WaitForHumanHandler } from "./wait_human.ts";
export { ConditionalHandler } from "./conditional.ts";
export { ParallelHandler } from "./parallel.ts";
export { FanInHandler } from "./fan_in.ts";
export { ToolHandler } from "./tool.ts";
export { ManagerLoopHandler } from "./manager_loop.ts";
