// Tool registry and built-in tools - Sections 3.3, 3.8

import type { ExecutionEnvironment } from "./environment.ts";
import type { ToolDefinition } from "../llm/types.ts";

export type { ToolDefinition };

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: (args: Record<string, unknown>, env: ExecutionEnvironment) => Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }
}

// Output truncation - Section 5.1
const DEFAULT_TOOL_LIMITS: Record<string, number> = {
  read_file: 50000,
  shell: 30000,
  grep: 20000,
  glob: 20000,
  edit_file: 10000,
  apply_patch: 10000,
  write_file: 1000,
};

const DEFAULT_LINE_LIMITS: Record<string, number | null> = {
  shell: 256,
  grep: 200,
  glob: 500,
  read_file: null,
  edit_file: null,
};

const DEFAULT_TRUNCATION_MODES: Record<string, "head_tail" | "tail"> = {
  read_file: "head_tail",
  shell: "head_tail",
  grep: "tail",
  glob: "tail",
  edit_file: "tail",
  write_file: "tail",
};

export function truncateOutput(
  output: string,
  maxChars: number,
  mode: "head_tail" | "tail" = "head_tail"
): string {
  if (output.length <= maxChars) return output;

  if (mode === "head_tail") {
    const half = Math.floor(maxChars / 2);
    const removed = output.length - maxChars;
    return (
      output.slice(0, half) +
      `\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. ` +
      `The full output is available in the event stream. ` +
      `If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` +
      output.slice(-half)
    );
  }

  const removed = output.length - maxChars;
  return (
    `[WARNING: Tool output was truncated. First ${removed} characters were removed. ` +
    `The full output is available in the event stream.]\n\n` +
    output.slice(-maxChars)
  );
}

export function truncateLines(output: string, maxLines: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;

  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - headCount - tailCount;

  return (
    lines.slice(0, headCount).join("\n") +
    `\n[... ${omitted} lines omitted ...]\n` +
    lines.slice(-tailCount).join("\n")
  );
}

export function truncateToolOutput(
  output: string,
  toolName: string,
  charLimit?: number,
  lineLimit?: number | null
): string {
  const maxChars = charLimit ?? DEFAULT_TOOL_LIMITS[toolName] ?? 30000;
  const mode = DEFAULT_TRUNCATION_MODES[toolName] ?? "head_tail";

  // Step 1: Character truncation first
  let result = truncateOutput(output, maxChars, mode);

  // Step 2: Line truncation
  const maxLines = lineLimit !== undefined ? lineLimit : DEFAULT_LINE_LIMITS[toolName];
  if (maxLines != null) {
    result = truncateLines(result, maxLines);
  }

  return result;
}

// Built-in tool implementations
export function buildCoreTools(): RegisteredTool[] {
  return [
    // read_file
    {
      definition: {
        name: "read_file",
        description: "Read a file from the filesystem. Returns line-numbered content.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file" },
            offset: { type: "number", description: "1-based line number to start reading from" },
            limit: { type: "number", description: "Max lines to read (default: 2000)" },
          },
          required: ["file_path"],
        },
      },
      executor: async (args, env) => {
        const path = args["file_path"] as string;
        const offset = (args["offset"] as number | undefined) ?? 1;
        const limit = (args["limit"] as number | undefined) ?? 2000;
        try {
          return await env.readFile(path, offset, limit);
        } catch (err) {
          return `Error reading file: ${err}`;
        }
      },
    },

    // write_file
    {
      definition: {
        name: "write_file",
        description: "Write content to a file. Creates the file and parent directories if needed.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path" },
            content: { type: "string", description: "The full file content" },
          },
          required: ["file_path", "content"],
        },
      },
      executor: async (args, env) => {
        const path = args["file_path"] as string;
        const content = args["content"] as string;
        try {
          await env.writeFile(path, content);
          return `Written ${Buffer.byteLength(content)} bytes to ${path}`;
        } catch (err) {
          return `Error writing file: ${err}`;
        }
      },
    },

    // edit_file (old_string/new_string)
    {
      definition: {
        name: "edit_file",
        description:
          "Replace an exact string occurrence in a file. old_string must be unique in the file.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            old_string: { type: "string", description: "Exact text to find" },
            new_string: { type: "string", description: "Replacement text" },
            replace_all: {
              type: "boolean",
              description: "Replace all occurrences (default: false)",
            },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
      executor: async (args, env) => {
        const path = args["file_path"] as string;
        const oldStr = args["old_string"] as string;
        const newStr = args["new_string"] as string;
        const replaceAll = (args["replace_all"] as boolean | undefined) ?? false;

        try {
          const content = await env.readFile(path, 1, 999999);
          // Strip line numbers
          const raw = content
            .split("\n")
            .map((line) => line.replace(/^\s*\d+\s*\|\s?/, ""))
            .join("\n");

          const count = raw.split(oldStr).length - 1;
          if (count === 0) {
            return `Error: old_string not found in ${path}`;
          }
          if (count > 1 && !replaceAll) {
            return `Error: old_string appears ${count} times in ${path}. Use replace_all=true or provide more context.`;
          }

          const updated = replaceAll
            ? raw.split(oldStr).join(newStr)
            : raw.replace(oldStr, newStr);
          await env.writeFile(path, updated);
          return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${path}`;
        } catch (err) {
          return `Error editing file: ${err}`;
        }
      },
    },

    // shell
    {
      definition: {
        name: "shell",
        description: "Execute a shell command. Returns stdout, stderr, and exit code.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to run" },
            timeout_ms: { type: "number", description: "Override default timeout" },
            description: { type: "string", description: "Human-readable description" },
          },
          required: ["command"],
        },
      },
      executor: async (args, env) => {
        const command = args["command"] as string;
        const timeoutMs = (args["timeout_ms"] as number | undefined) ?? 10000;
        const result = await env.execCommand(command, timeoutMs);
        let output = result.stdout;
        if (result.stderr) output += `\nSTDERR:\n${result.stderr}`;
        output += `\nExit code: ${result.exitCode} (${result.durationMs}ms)`;
        return output;
      },
    },

    // grep
    {
      definition: {
        name: "grep",
        description: "Search file contents using regex patterns.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern" },
            path: { type: "string", description: "Directory or file to search" },
            glob_filter: { type: "string", description: "File pattern filter (e.g. *.py)" },
            case_insensitive: { type: "boolean" },
            max_results: { type: "number" },
          },
          required: ["pattern"],
        },
      },
      executor: async (args, env) => {
        const pattern = args["pattern"] as string;
        const path = (args["path"] as string | undefined) ?? env.workingDirectory();
        return env.grep(pattern, path, {
          caseInsensitive: args["case_insensitive"] as boolean | undefined,
          maxResults: args["max_results"] as number | undefined,
          globFilter: args["glob_filter"] as string | undefined,
        });
      },
    },

    // glob
    {
      definition: {
        name: "glob",
        description: "Find files matching a glob pattern.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts)" },
            path: { type: "string", description: "Base directory" },
          },
          required: ["pattern"],
        },
      },
      executor: async (args, env) => {
        const pattern = args["pattern"] as string;
        const path = args["path"] as string | undefined;
        const files = await env.glob(pattern, path);
        return files.join("\n");
      },
    },
  ];
}
