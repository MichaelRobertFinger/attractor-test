// AST Transforms - Section 9.1-9.3

import type { Graph } from "./types.ts";
import { parseStylesheet, applyStylesheetToGraph } from "./stylesheet.ts";

export interface Transform {
  apply(graph: Graph): Graph;
}

// Variable Expansion Transform: replaces $goal in prompts
export class VariableExpansionTransform implements Transform {
  apply(graph: Graph): Graph {
    const goal = graph.attrs.goal ?? "";
    for (const node of graph.nodes.values()) {
      if (node.attrs.prompt && typeof node.attrs.prompt === "string") {
        node.attrs.prompt = node.attrs.prompt.replace(/\$goal/g, goal);
      }
    }
    return graph;
  }
}

// Stylesheet Application Transform
export class StylesheetTransform implements Transform {
  apply(graph: Graph): Graph {
    const stylesheetSrc = graph.attrs.modelStylesheet;
    if (!stylesheetSrc) return graph;

    const { rules } = parseStylesheet(String(stylesheetSrc));
    if (rules.length > 0) {
      applyStylesheetToGraph(graph, rules);
    }

    return graph;
  }
}

// Subgraph Class Derivation Transform: derives classes from subgraph labels
export class SubgraphClassTransform implements Transform {
  apply(graph: Graph): Graph {
    for (const node of graph.nodes.values()) {
      if (node.subgraphLabel) {
        const derived = node.subgraphLabel
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

        if (derived && !node.attrs.class) {
          node.attrs.class = derived;
        } else if (derived && node.attrs.class) {
          const existing = String(node.attrs.class);
          if (!existing.split(",").map((c) => c.trim()).includes(derived)) {
            node.attrs.class = `${existing},${derived}`;
          }
        }
      }
    }
    return graph;
  }
}

const BUILT_IN_TRANSFORMS: Transform[] = [
  new SubgraphClassTransform(),
  new VariableExpansionTransform(),
  new StylesheetTransform(),
];

export function applyTransforms(graph: Graph, extraTransforms: Transform[] = []): Graph {
  const allTransforms = [...BUILT_IN_TRANSFORMS, ...extraTransforms];
  let g = graph;
  for (const transform of allTransforms) {
    g = transform.apply(g);
  }
  return g;
}
