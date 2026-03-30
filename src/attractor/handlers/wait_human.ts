// Wait For Human Handler - Section 4.6

import type { Handler, HandlerContext } from "./index.ts";
import type { Outcome } from "../types.ts";
import type { Interviewer } from "../interviewer/types.ts";
import { parseAcceleratorKey } from "../interviewer/types.ts";
import { Graph } from "../types.ts";

export class WaitForHumanHandler implements Handler {
  constructor(private interviewer: Interviewer) {}

  async execute(hctx: HandlerContext): Promise<Outcome> {
    const { node, graph } = hctx;

    // 1. Derive choices from outgoing edges
    const edges = Graph.outgoingEdges(graph, node.id);
    if (edges.length === 0) {
      return { status: "FAIL", failureReason: "No outgoing edges for human gate" };
    }

    const choices = edges.map((edge) => {
      const label = edge.attrs.label ?? edge.toNode;
      const key = parseAcceleratorKey(label);
      return { key, label, to: edge.toNode };
    });

    // 2. Build question
    const question = {
      text: (node.attrs.label as string | undefined) ?? "Select an option:",
      type: "MULTIPLE_CHOICE" as const,
      options: choices.map((c) => ({ key: c.key, label: c.label })),
      stage: node.id,
      timeoutSeconds:
        node.attrs.timeout != null ? Number(node.attrs.timeout) / 1000 : undefined,
    };

    // 3. Present to interviewer
    const answer = await this.interviewer.ask(question);

    // 4. Handle timeout/skip
    if (answer.value === "TIMEOUT") {
      const defaultChoice = node.attrs["human.default_choice"] as string | undefined;
      if (defaultChoice) {
        const defaultEdge = edges.find(
          (e) => e.toNode === defaultChoice || e.attrs.label === defaultChoice
        );
        if (defaultEdge) {
          const chosen = choices.find((c) => c.to === defaultEdge.toNode) ?? choices[0]!;
          return {
            status: "SUCCESS",
            suggestedNextIds: [chosen.to],
            contextUpdates: {
              "human.gate.selected": chosen.key,
              "human.gate.label": chosen.label,
            },
          };
        }
      }
      return { status: "RETRY", failureReason: "human gate timeout, no default" };
    }

    if (answer.value === "SKIPPED") {
      return { status: "FAIL", failureReason: "human skipped interaction" };
    }

    // 5. Find matching choice
    let selected = choices.find(
      (c) =>
        c.key.toUpperCase() === String(answer.value).toUpperCase() ||
        (answer.selectedOption && c.key === answer.selectedOption.key)
    );
    if (!selected) selected = choices[0]!;

    // 6. Return
    return {
      status: "SUCCESS",
      suggestedNextIds: [selected.to],
      contextUpdates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
      },
    };
  }
}
