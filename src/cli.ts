#!/usr/bin/env bun
// Attractor CLI

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { parseDot } from "./attractor/parser.ts";
import { validate, validateOrRaise } from "./attractor/lint.ts";
import { PipelineEngine } from "./attractor/engine.ts";
import { SimpleLLMBackend, AgentCodergenBackend } from "./attractor/backends/agent.ts";
import { ConsoleInterviewer } from "./attractor/interviewer/implementations.ts";
import { Client } from "./llm/client.ts";

const HELP = `
Attractor - DOT-based AI pipeline runner

USAGE
  attractor run <pipeline.dot> [options]
  attractor lint <pipeline.dot>
  attractor parse <pipeline.dot>

COMMANDS
  run    Execute a pipeline
  lint   Validate a pipeline without running it
  parse  Parse and display the graph structure

OPTIONS
  --logs-root <dir>     Directory for logs and checkpoints (default: .attractor/run-<timestamp>)
  --backend <type>      Backend type: simple | agent (default: simple)
  --model <model>       LLM model to use (default: claude-sonnet-4-6)
  --working-dir <dir>   Working directory for the agent backend
  --auto-approve        Auto-approve all human gates
  --resume              Resume from checkpoint
  --no-validate         Skip pipeline validation
  --verbose             Print detailed event output
  --help                Show this help
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "logs-root": { type: "string" },
      backend: { type: "string" },
      model: { type: "string" },
      "working-dir": { type: "string" },
      "auto-approve": { type: "boolean" },
      resume: { type: "boolean" },
      "no-validate": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const [command, pipelineFile] = positionals;

  if (!command || !pipelineFile) {
    console.error("Usage: attractor <command> <pipeline.dot>");
    process.exit(1);
  }

  const filePath = resolve(pipelineFile);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const source = readFileSync(filePath, "utf-8");

  if (command === "parse") {
    const graph = parseDot(source);
    console.log(`Graph: ${graph.name}`);
    console.log(`Goal: ${graph.attrs.goal ?? "(none)"}`);
    console.log(`\nNodes (${graph.nodes.size}):`);
    for (const node of graph.nodes.values()) {
      console.log(
        `  ${node.id.padEnd(20)} shape=${node.attrs.shape ?? "box"} type=${node.attrs.type ?? "(auto)"} label="${node.attrs.label ?? node.id}"`
      );
    }
    console.log(`\nEdges (${graph.edges.length}):`);
    for (const edge of graph.edges) {
      const cond = edge.attrs.condition ? ` [${edge.attrs.condition}]` : "";
      const label = edge.attrs.label ? ` "${edge.attrs.label}"` : "";
      console.log(`  ${edge.fromNode} -> ${edge.toNode}${label}${cond}`);
    }
    return;
  }

  if (command === "lint") {
    const graph = parseDot(source);
    const diagnostics = validate(graph);
    const errors = diagnostics.filter((d) => d.severity === "ERROR");
    const warnings = diagnostics.filter((d) => d.severity === "WARNING");

    if (diagnostics.length === 0) {
      console.log("✓ Pipeline is valid");
      return;
    }

    for (const d of diagnostics) {
      const icon = d.severity === "ERROR" ? "✗" : "⚠";
      const location = d.nodeId ? ` (node: ${d.nodeId})` : d.edge ? ` (edge: ${d.edge[0]} -> ${d.edge[1]})` : "";
      console.log(`${icon} [${d.rule}] ${d.message}${location}`);
      if (d.fix) console.log(`  → ${d.fix}`);
    }

    console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
    if (errors.length > 0) process.exit(1);
    return;
  }

  if (command === "run") {
    const graph = parseDot(source);
    const model = values.model ?? "claude-sonnet-4-6";
    const backendType = values.backend ?? "simple";
    const workingDir = values["working-dir"] ?? process.cwd();

    const client = Client.fromEnv();

    let backend;
    if (backendType === "agent") {
      backend = new AgentCodergenBackend({ workingDir, client });
    } else {
      backend = new SimpleLLMBackend(model, client);
    }

    const interviewer = values["auto-approve"] ? undefined : new ConsoleInterviewer();

    const engine = new PipelineEngine();

    if (values.verbose) {
      engine.events.on((event) => {
        const { kind } = event;
        const data = event.data as Record<string, unknown>;
        if (kind === "stage_started") {
          console.log(`\n▶ [${data["name"]}]`);
        } else if (kind === "stage_completed") {
          console.log(`  ✓ Completed`);
        } else if (kind === "stage_failed") {
          console.log(`  ✗ Failed: ${data["error"]}`);
        } else if (kind === "stage_retrying") {
          console.log(`  ↺ Retrying (attempt ${data["attempt"]})...`);
        } else if (kind === "checkpoint_saved") {
          // silent
        } else if (kind === "pipeline_started") {
          console.log(`Pipeline: ${graph.name}`);
          if (graph.attrs.goal) console.log(`Goal: ${graph.attrs.goal}`);
          console.log();
        } else if (kind === "pipeline_completed") {
          console.log(`\n✓ Pipeline completed`);
        } else if (kind === "pipeline_failed") {
          console.log(`\n✗ Pipeline failed: ${data["error"]}`);
        } else if (kind === "interview_started") {
          // handled by ConsoleInterviewer
        }
      });
    } else {
      // Minimal output
      engine.events.on((event) => {
        if (event.kind === "pipeline_started") {
          console.log(`Running pipeline: ${graph.name}`);
        } else if (event.kind === "stage_started") {
          process.stdout.write(`  ${(event.data as Record<string, unknown>)["name"]}... `);
        } else if (event.kind === "stage_completed") {
          console.log("done");
        } else if (event.kind === "stage_failed") {
          console.log("FAILED");
        } else if (event.kind === "pipeline_completed") {
          console.log("\nPipeline completed successfully");
        } else if (event.kind === "pipeline_failed") {
          console.log(`\nPipeline failed: ${(event.data as Record<string, unknown>)["error"]}`);
        }
      });
    }

    try {
      const result = await engine.run(graph, {
        logsRoot: values["logs-root"],
        backend,
        interviewer,
        validate: !values["no-validate"],
        resumeFromCheckpoint: values.resume,
      });

      if (result.status === "FAIL") {
        console.error(`\nFailed: ${result.failureReason}`);
        process.exit(1);
      }

      if (values.verbose) {
        console.log(`\nLogs: ${result.logsRoot}`);
        console.log(`Completed nodes: ${result.completedNodes.join(", ")}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    return;
  }

  console.error(`Unknown command: ${command}`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
