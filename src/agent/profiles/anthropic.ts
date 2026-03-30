// Anthropic Provider Profile (Claude Code-aligned) - Section 3.5

import type { ProviderProfile } from "../session.ts";
import type { ExecutionEnvironment } from "../environment.ts";
import { ToolRegistry, buildCoreTools } from "../tools.ts";
import { platform } from "node:os";
import { execSync } from "node:child_process";

export function createAnthropicProfile(model = "claude-sonnet-4-6"): ProviderProfile {
  const registry = new ToolRegistry();
  for (const tool of buildCoreTools()) {
    registry.register(tool);
  }

  return {
    id: "anthropic",
    model,
    toolRegistry: registry,

    buildSystemPrompt(env: ExecutionEnvironment, projectDocs: string): string {
      const workingDir = env.workingDirectory();
      const plat = env.platform();
      const osVer = env.osVersion();

      let isGit = false;
      let gitBranch = "";
      try {
        gitBranch = execSync("git branch --show-current", { cwd: workingDir, encoding: "utf-8", timeout: 2000 }).trim();
        isGit = true;
      } catch {}

      const envBlock = `<environment>
Working directory: ${workingDir}
Is git repository: ${isGit}
${isGit ? `Git branch: ${gitBranch}` : ""}
Platform: ${plat}
OS version: ${osVer}
Today's date: ${new Date().toISOString().slice(0, 10)}
Model: ${model}
</environment>`;

      const baseInstructions = `You are Claude, an AI coding assistant. You help developers write, edit, understand, and debug code.

## Tool Usage Guidelines

- **read_file before edit_file**: Always read a file before editing it to understand the current content.
- **edit_file format**: Use exact old_string/new_string matching. old_string must be unique in the file.
- **write_file for new files**: Use write_file to create files from scratch.
- **shell for commands**: Use shell to run tests, linters, git commands, and other CLI operations.
- **grep and glob for search**: Use grep to search file contents, glob to find files by pattern.

## File Operations

- Prefer editing existing files over creating new ones when possible.
- When editing, always include enough context in old_string to make it unique.
- Do not create unnecessary files or add redundant comments.

## Code Quality

- Write clean, idiomatic code following the language's conventions.
- Functions under 100 lines, cyclomatic complexity <= 8.
- Delete commented-out code. Self-documenting names over comments.
- Zero warnings from linters and type checkers.

## Coding Best Practices

- Test behavior, not implementation details.
- Fail fast with actionable error messages: what failed, what input, what to try.
- No speculative features — build only what is needed.`;

      const projectSection = projectDocs
        ? `\n\n## Project Instructions\n\n${projectDocs}`
        : "";

      return `${baseInstructions}\n\n${envBlock}${projectSection}`;
    },

    providerOptions() {
      return {
        anthropic: {
          beta_headers: ["interleaved-thinking-2025-05-14"],
        },
      };
    },

    supportsParallelToolCalls: false, // Anthropic does not support parallel tool calls
    contextWindowSize: 200000,
  };
}
