// OpenAI Provider Profile (codex-rs-aligned) - Section 3.4

import type { ProviderProfile } from "../session.ts";
import type { ExecutionEnvironment } from "../environment.ts";
import { ToolRegistry, buildCoreTools } from "../tools.ts";
import { execSync } from "node:child_process";

export function createOpenAIProfile(model = "gpt-4o"): ProviderProfile {
  const registry = new ToolRegistry();
  for (const tool of buildCoreTools()) {
    registry.register(tool);
  }

  return {
    id: "openai",
    model,
    toolRegistry: registry,

    buildSystemPrompt(env: ExecutionEnvironment, projectDocs: string): string {
      const workingDir = env.workingDirectory();
      const plat = env.platform();

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
Today's date: ${new Date().toISOString().slice(0, 10)}
Model: ${model}
</environment>`;

      const baseInstructions = `You are an AI coding assistant. You help developers write, edit, understand, and debug code.

## Tool Usage Guidelines

- Use read_file to read files before editing them.
- Use write_file and edit_file to make changes.
- Use shell to run commands (builds, tests, linters).
- Use grep to search file contents and glob to find files.

## Code Quality

- Write clean, idiomatic code. No speculative features.
- Delete commented-out code.`;

      const projectSection = projectDocs
        ? `\n\n## Project Instructions\n\n${projectDocs}`
        : "";

      return `${baseInstructions}\n\n${envBlock}${projectSection}`;
    },

    supportsParallelToolCalls: true,
    contextWindowSize: 128000,
  };
}
