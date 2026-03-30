// Gemini Provider Profile (gemini-cli-aligned) - Section 3.6

import type { ProviderProfile } from "../session.ts";
import type { ExecutionEnvironment } from "../environment.ts";
import { ToolRegistry, buildCoreTools } from "../tools.ts";
import { execSync } from "node:child_process";

export function createGeminiProfile(model = "gemini-2.0-flash"): ProviderProfile {
  const registry = new ToolRegistry();
  for (const tool of buildCoreTools()) {
    registry.register(tool);
  }

  return {
    id: "gemini",
    model,
    toolRegistry: registry,

    buildSystemPrompt(env: ExecutionEnvironment, projectDocs: string): string {
      const workingDir = env.workingDirectory();

      let isGit = false;
      try {
        execSync("git rev-parse --git-dir", { cwd: workingDir, timeout: 2000 });
        isGit = true;
      } catch {}

      const envBlock = `<environment>
Working directory: ${workingDir}
Is git repository: ${isGit}
Platform: ${env.platform()}
Today's date: ${new Date().toISOString().slice(0, 10)}
Model: ${model}
</environment>`;

      const baseInstructions = `You are a helpful coding assistant. You help developers write, edit, and debug code.

Use read_file, write_file, edit_file, shell, grep, and glob to accomplish tasks.
Always read files before editing them.`;

      const projectSection = projectDocs
        ? `\n\n## Project Instructions\n\n${projectDocs}`
        : "";

      return `${baseInstructions}\n\n${envBlock}${projectSection}`;
    },

    supportsParallelToolCalls: true,
    contextWindowSize: 1048576,
  };
}
