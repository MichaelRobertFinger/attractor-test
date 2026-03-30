// Execution Environment - Section 4

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, execSync } from "node:child_process";
import { platform, homedir } from "node:os";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size?: number;
}

export interface GrepOptions {
  caseInsensitive?: boolean;
  maxResults?: number;
  globFilter?: string;
}

export interface ExecutionEnvironment {
  readFile(path: string, offset?: number, limit?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  listDirectory(path: string, depth?: number): Promise<DirEntry[]>;
  execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string,
    envVars?: Record<string, string>
  ): Promise<ExecResult>;
  grep(pattern: string, path: string, options?: GrepOptions): Promise<string>;
  glob(pattern: string, path?: string): Promise<string[]>;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  workingDirectory(): string;
  platform(): string;
  osVersion(): string;
}

// Environment variable filtering
const SENSITIVE_PATTERNS = [
  /_API_KEY$/i, /_SECRET$/i, /_TOKEN$/i, /_PASSWORD$/i, /_CREDENTIAL$/i,
  /_PASS$/i, /_AUTH$/i,
];

const ALWAYS_INCLUDE = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR",
  "GOPATH", "CARGO_HOME", "NVM_DIR", "PYENV_ROOT",
  "NODE_ENV", "DENO_DIR", "BUN_INSTALL",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (ALWAYS_INCLUDE.has(key)) {
      result[key] = value;
      continue;
    }
    if (SENSITIVE_PATTERNS.some((p) => p.test(key))) continue;
    result[key] = value;
  }
  return result;
}

// Read file with line numbers
function addLineNumbers(content: string, offset = 1): string {
  const lines = content.split("\n");
  return lines
    .slice(offset - 1)
    .map((line, i) => `${String(i + offset).padStart(4, " ")} | ${line}`)
    .join("\n");
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private cwd: string;

  constructor(workingDir?: string) {
    this.cwd = workingDir ?? process.cwd();
  }

  private resolvePath(p: string): string {
    if (p.startsWith("/")) return p;
    if (p.startsWith("~")) return join(homedir(), p.slice(1));
    return resolve(this.cwd, p);
  }

  async readFile(path: string, offset = 1, limit = 2000): Promise<string> {
    const resolved = this.resolvePath(path);
    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n");
    const sliced = lines.slice(offset - 1, offset - 1 + limit);
    return sliced
      .map((line, i) => `${String(i + offset).padStart(4, " ")} | ${line}`)
      .join("\n");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = this.resolvePath(path);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content);
  }

  async fileExists(path: string): Promise<boolean> {
    return existsSync(this.resolvePath(path));
  }

  async listDirectory(path: string, depth = 1): Promise<DirEntry[]> {
    const resolved = this.resolvePath(path);
    const entries: DirEntry[] = [];

    async function walk(dir: string, currentDepth: number): Promise<void> {
      if (currentDepth > depth) return;
      const items = await readdir(dir);
      for (const item of items) {
        const full = join(dir, item);
        const s = await stat(full).catch(() => null);
        if (!s) continue;
        entries.push({ name: full.slice(resolved.length + 1) || item, isDir: s.isDirectory(), size: s.size });
        if (s.isDirectory() && currentDepth < depth) {
          await walk(full, currentDepth + 1);
        }
      }
    }

    await walk(resolved, 1);
    return entries;
  }

  async execCommand(
    command: string,
    timeoutMs = 10000,
    workingDir?: string,
    envVars?: Record<string, string>
  ): Promise<ExecResult> {
    const cwd = workingDir ? this.resolvePath(workingDir) : this.cwd;
    const env = { ...filterEnv(process.env as Record<string, string>), ...(envVars ?? {}) };

    return new Promise((resolve) => {
      const start = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const isWindows = platform() === "win32";
      const shell = isWindows ? "cmd.exe" : "/bin/bash";
      const shellArg = isWindows ? "/c" : "-c";

      const proc = spawn(shell, [shellArg, command], {
        cwd,
        env,
        detached: !isWindows,
      });

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (!isWindows && proc.pid) {
            process.kill(-proc.pid, "SIGTERM");
            setTimeout(() => {
              try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch {}
            }, 2000);
          } else {
            proc.kill("SIGTERM");
          }
        } catch {}
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        if (timedOut) {
          stdout += `\n[ERROR: Command timed out after ${timeoutMs}ms. Partial output shown above.]`;
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          timedOut,
          durationMs,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  async grep(pattern: string, path: string, options: GrepOptions = {}): Promise<string> {
    const resolved = this.resolvePath(path);
    const maxResults = options.maxResults ?? 100;
    const caseFlag = options.caseInsensitive ? "-i" : "";
    const globFilter = options.globFilter ? `--include="${options.globFilter}"` : "";

    try {
      // Try ripgrep first
      const cmd = `rg ${caseFlag} ${globFilter} -n --no-heading "${pattern.replace(/"/g, '\\"')}" "${resolved}" | head -${maxResults}`;
      const result = await this.execCommand(cmd, 10000);
      if (result.exitCode <= 1) return result.stdout; // rg returns 1 when no match
    } catch {}

    // Fallback to grep
    try {
      const cmd = `grep -r ${caseFlag} -n "${pattern.replace(/"/g, '\\"')}" "${resolved}" | head -${maxResults}`;
      const result = await this.execCommand(cmd, 10000);
      return result.stdout;
    } catch (err) {
      return `Error: ${err}`;
    }
  }

  async glob(pattern: string, path?: string): Promise<string[]> {
    const basePath = path ? this.resolvePath(path) : this.cwd;
    try {
      const result = await this.execCommand(
        `find "${basePath}" -path "${pattern.includes("**") ? basePath + "/*" : basePath + "/" + pattern}" -type f 2>/dev/null | head -500`,
        10000
      );
      if (result.stdout.trim()) {
        return result.stdout.trim().split("\n").filter(Boolean);
      }
    } catch {}

    // Use Bun's glob
    try {
      const { Glob } = await import("bun");
      const globber = new Glob(pattern);
      const files: string[] = [];
      for await (const file of globber.scan({ cwd: basePath, onlyFiles: true })) {
        files.push(join(basePath, file));
      }
      return files;
    } catch {
      return [];
    }
  }

  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}

  workingDirectory(): string {
    return this.cwd;
  }

  platform(): string {
    return process.platform;
  }

  osVersion(): string {
    try {
      return execSync("uname -r", { encoding: "utf-8" }).trim();
    } catch {
      return process.platform;
    }
  }
}
