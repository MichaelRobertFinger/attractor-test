// Tool Handler - Section 4.10

import { execSync } from "node:child_process";
import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";

export class ToolHandler implements Handler {
  async execute(hctx: HandlerContext): Promise<Outcome> {
    const { node } = hctx;

    const command = node.attrs["tool_command"] as string | undefined;
    if (!command) {
      return { status: "FAIL", failureReason: "No tool_command specified" };
    }

    const timeoutMs = node.attrs.timeout as number | undefined;

    try {
      const stdout = execSync(command, {
        timeout: timeoutMs ?? 30000,
        encoding: "utf-8",
      });

      return {
        status: "SUCCESS",
        contextUpdates: { "tool.output": stdout },
        notes: `Tool completed: ${command}`,
      };
    } catch (err: unknown) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      const output = e.stdout ?? e.stderr ?? "";
      return {
        status: "FAIL",
        failureReason: `Tool failed: ${e.message ?? String(err)}${output ? `\n${output}` : ""}`,
      };
    }
  }
}
