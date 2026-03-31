# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Attractor is a DOT-graph-based AI pipeline runner. Pipelines are defined as Graphviz `digraph` files; the engine parses them, resolves node handlers by shape/type, and executes stages sequentially (with retry, checkpointing, and conditional routing).

## Commands

```sh
bun run start            # run the CLI (bun src/cli.ts)
bun run lint             # type-check only (tsc --noEmit)
bun test                 # run tests
bun test src/foo.test.ts # run a single test file

# CLI usage
bun src/cli.ts run <pipeline.dot> [--backend simple|agent] [--model claude-sonnet-4-6] [--verbose] [--resume]
bun src/cli.ts lint <pipeline.dot>
bun src/cli.ts parse <pipeline.dot>
```

**Required env vars** (at least one):
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`

`Client.fromEnv()` auto-detects which providers are available from env.

## Architecture

Three layers, cleanly separated:

### `src/llm/` — LLM client abstraction
- `Client` — multi-provider client with middleware chain and retry. `Client.fromEnv()` is the standard constructor.
- `adapters/` — `AnthropicAdapter`, `OpenAIAdapter`, `GeminiAdapter` each implement `ProviderAdapter`.
- `generate.ts` — convenience wrappers around `Client`.

### `src/agent/` — Agentic tool-loop
- `Session` — multi-turn tool-use loop. Submits prompts, executes tool calls, detects loops, supports steering injection.
- `ProviderProfile` — interface that bundles a model, tool registry, and system-prompt builder. Implementations in `profiles/`.
- `tools.ts` — `ToolRegistry` and `buildCoreTools()` (shell, file I/O, etc.).
- `environment.ts` — `LocalExecutionEnvironment` wraps cwd for tool execution.

### `src/attractor/` — Pipeline engine
- `parser.ts` — hand-written DOT tokenizer/parser; produces a `Graph` (nodes + edges + attrs).
- `engine.ts` — `PipelineEngine.run()` is the main execution loop: find start node, execute handler, select next edge via `selectEdge()`, repeat.
- `handlers/` — one file per handler type; all implement `Handler { execute(hctx): Promise<Outcome> }`.
- `lint.ts` — `validate()` / `validateOrRaise()` run built-in rules on a graph before execution.
- `context.ts` — `Context` (key-value store threaded through execution) and `Checkpoint` (JSON file at `<logsRoot>/checkpoint.json`).
- `conditions.ts` — evaluates edge `condition=` expressions against context/outcome.
- `stylesheet.ts` — parses `model_stylesheet` attr for per-node model overrides.
- `transforms.ts` — pre-execution graph transforms (applied before validation).

### `src/attractor/backends/`
- `SimpleLLMBackend` — single `client.complete()` call per node.
- `AgentCodergenBackend` — full `Session` tool loop per node; used with `--backend agent`.

## Node Shape → Handler Mapping

| DOT shape | Handler type | Purpose |
|---|---|---|
| `Mdiamond` | `start` | Entry point (exactly one required) |
| `Msquare` | `exit` | Terminal node (exactly one required) |
| `box` (default) | `codergen` | LLM task node |
| `hexagon` | `wait.human` | Human-in-the-loop gate |
| `diamond` | `conditional` | Branch by outcome/context |
| `component` | `parallel` | Fan-out parallel sub-pipeline |
| `tripleoctagon` | `parallel.fan_in` | Collect parallel results |
| `parallelogram` | `tool` | Direct tool execution |
| `house` | `stack.manager_loop` | Manager/worker loop |

Nodes can also set `type=<handler>` explicitly to override shape-based resolution.

## Key Node Attributes

`prompt`, `label`, `max_retries`, `goal_gate`, `retry_target`, `fallback_retry_target`, `llm_model`, `llm_provider`, `reasoning_effort`, `fidelity`, `timeout`, `allow_partial`

Edge attributes: `condition`, `label`, `weight`, `loop_restart`, `fidelity`, `thread_id`

## Bun Conventions

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of jest or vitest
- Use `bun install` instead of npm/yarn/pnpm install
- Bun automatically loads `.env` — don't use dotenv
- Prefer `Bun.file` over `node:fs` readFile/writeFile
- Use `Bun.$\`cmd\`` instead of execa
