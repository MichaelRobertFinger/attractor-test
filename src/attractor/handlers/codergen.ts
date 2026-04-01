// Codergen Handler (LLM Task) - Section 4.5

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Handler, HandlerContext } from "./index.ts";
import type { Node, Graph, Outcome } from "../types.ts";
import type { Context } from "../context.ts";

export interface CodergenBackend {
  run(node: Node, prompt: string, context: Context): Promise<string | Outcome>;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

export class CodergenHandler implements Handler {
  constructor(private backend?: CodergenBackend) {}

  async execute(hctx: HandlerContext): Promise<Outcome> {
    const { node, context, logsRoot } = hctx;

    // 1. Build prompt
    let prompt = (node.attrs.prompt as string | undefined) ?? node.attrs.label ?? node.id;
    // $goal expansion is done by the transform, but do it here as fallback too
    const goal = context.getString("graph.goal");
    if (goal) prompt = prompt.replace(/\$goal/g, goal);

    // 2. Write prompt to logs
    const stageDir = join(logsRoot, node.id);
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, "prompt.md"), prompt);

    // 3. Call backend
    let responseText: string;

    if (this.backend) {
      try {
        const result = await this.backend.run(node, prompt, context);
        if (typeof result === "object" && result !== null && "status" in result) {
          // It's an Outcome
          const outcome = result as Outcome;
          await this.writeStatus(stageDir, outcome);
          return outcome;
        }
        responseText = String(result);
      } catch (err) {
        return { status: "FAIL", failureReason: String(err) };
      }
    } else {
      responseText = `[Simulated] Response for stage: ${node.id}`;
    }

    // 4. Write response to logs
    await writeFile(join(stageDir, "response.md"), responseText);

    // 5. Check for external status.json (status-file contract)
    const statusPath = join(stageDir, "status.json");
    if (existsSync(statusPath)) {
      try {
        const raw = await readFile(statusPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          outcome?: string;
          preferred_label?: string;
          suggested_next_ids?: string[];
          context_updates?: Record<string, unknown>;
          notes?: string;
        };

        const statusMap: Record<string, Outcome["status"]> = {
          success: "SUCCESS",
          fail: "FAIL",
          retry: "RETRY",
          partial_success: "PARTIAL_SUCCESS",
          skipped: "SKIPPED",
        };

        const outcome: Outcome = {
          status: statusMap[parsed.outcome?.toLowerCase() ?? ""] ?? "SUCCESS",
          preferredLabel: parsed.preferred_label,
          suggestedNextIds: parsed.suggested_next_ids,
          contextUpdates: {
            last_stage: node.id,
            last_response: truncate(responseText, 200),
            ...(parsed.context_updates ?? {}),
          },
          notes: parsed.notes,
        };
        return outcome;
      } catch {
        // ignore parse errors, fall through to default outcome
      }
    }

    // 6. Build and return outcome
    // If response is JSON, extract top-level scalar fields into context as <nodeId>.<field>
    const jsonContext: Record<string, unknown> = {};
    const stripped = responseText.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    try {
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            jsonContext[`${node.id}.${k}`] = v;
          }
        }
      }
    } catch { /* not JSON, ignore */ }

    const outcome: Outcome = {
      status: "SUCCESS",
      notes: `Stage completed: ${node.id}`,
      contextUpdates: {
        last_stage: node.id,
        last_response: truncate(responseText, 200),
        ...jsonContext,
      },
    };

    await this.writeStatus(stageDir, outcome);
    return outcome;
  }

  private async writeStatus(stageDir: string, outcome: Outcome): Promise<void> {
    const data = {
      outcome: outcome.status.toLowerCase(),
      preferred_label: outcome.preferredLabel ?? "",
      suggested_next_ids: outcome.suggestedNextIds ?? [],
      context_updates: outcome.contextUpdates ?? {},
      notes: outcome.notes ?? "",
      failure_reason: outcome.failureReason ?? "",
    };
    await writeFile(join(stageDir, "status.json"), JSON.stringify(data, null, 2));
  }
}
