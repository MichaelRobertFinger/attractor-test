// Coding Agent Session - Sections 2.1-2.10

import type { Message, ToolDefinition, ToolCall, ToolResult, StreamEvent } from "../llm/types.ts";
import { Client, getDefaultClient } from "../llm/client.ts";
import type { ExecutionEnvironment } from "./environment.ts";
import { LocalExecutionEnvironment } from "./environment.ts";
import type { RegisteredTool } from "./tools.ts";
import { truncateToolOutput, ToolRegistry, buildCoreTools } from "./tools.ts";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SessionState = "IDLE" | "PROCESSING" | "AWAITING_INPUT" | "CLOSED";

export type AgentEventKind =
  | "SESSION_START" | "SESSION_END" | "USER_INPUT" | "PROCESSING_END"
  | "ASSISTANT_TEXT_START" | "ASSISTANT_TEXT_DELTA" | "ASSISTANT_TEXT_END"
  | "TOOL_CALL_START" | "TOOL_CALL_END"
  | "STEERING_INJECTED" | "TURN_LIMIT" | "LOOP_DETECTION" | "WARNING" | "ERROR";

export interface AgentEvent {
  kind: AgentEventKind;
  timestamp: Date;
  sessionId: string;
  data: Record<string, unknown>;
}

export type AgentEventHandler = (event: AgentEvent) => void;

export interface SessionConfig {
  maxTurns?: number;
  maxToolRoundsPerInput?: number;
  defaultCommandTimeoutMs?: number;
  maxCommandTimeoutMs?: number;
  reasoningEffort?: "low" | "medium" | "high";
  enableLoopDetection?: boolean;
  loopDetectionWindow?: number;
  maxSubagentDepth?: number;
  toolOutputLimits?: Record<string, number>;
  toolLineLimits?: Record<string, number | null>;
}

export interface ProviderProfile {
  id: string;
  model: string;
  toolRegistry: ToolRegistry;
  buildSystemPrompt(env: ExecutionEnvironment, projectDocs: string): string;
  providerOptions?(): Record<string, unknown>;
  supportsParallelToolCalls: boolean;
  contextWindowSize: number;
}

type Turn =
  | { type: "user"; content: string; timestamp: Date }
  | { type: "assistant"; content: string; toolCalls: ToolCall[]; reasoning?: string; timestamp: Date }
  | { type: "tool_results"; results: ToolResult[]; timestamp: Date }
  | { type: "steering"; content: string; timestamp: Date };

function discoverProjectDocs(workingDir: string): string {
  const docFiles = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
  const parts: string[] = [];
  for (const file of docFiles) {
    const path = join(workingDir, file);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        parts.push(`## ${file}\n\n${content}`);
      } catch {}
    }
  }
  return parts.join("\n\n---\n\n");
}

function getGitContext(workingDir: string): string {
  try {
    const branch = execSync("git branch --show-current", {
      cwd: workingDir,
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    const status = execSync("git status --short", {
      cwd: workingDir,
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return `Git branch: ${branch}\nGit status: ${status || "clean"}`;
  } catch {
    return "Not a git repository";
  }
}

function historyToMessages(history: Turn[]): Message[] {
  const messages: Message[] = [];
  for (const turn of history) {
    if (turn.type === "user") {
      messages.push({ role: "user", content: [{ kind: "text", text: turn.content }] });
    } else if (turn.type === "steering") {
      // Steering turns become user messages
      messages.push({ role: "user", content: [{ kind: "text", text: turn.content }] });
    } else if (turn.type === "assistant") {
      const content: Message["content"] = [];
      if (turn.content) content.push({ kind: "text", text: turn.content });
      for (const tc of turn.toolCalls) {
        content.push({
          kind: "tool_call",
          toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
        });
      }
      messages.push({ role: "assistant", content });
    } else if (turn.type === "tool_results") {
      for (const result of turn.results) {
        messages.push({
          role: "tool",
          toolCallId: result.toolCallId,
          content: [
            {
              kind: "tool_result",
              toolResult: {
                toolCallId: result.toolCallId,
                content: result.content,
                isError: result.isError,
              },
            },
          ],
        });
      }
    }
  }
  return messages;
}

// Loop detection
function detectLoop(history: Turn[], windowSize: number): boolean {
  const recentCalls: string[] = [];
  for (let i = history.length - 1; i >= 0 && recentCalls.length < windowSize; i--) {
    const turn = history[i];
    if (turn?.type === "assistant" && turn.toolCalls.length > 0) {
      for (const tc of turn.toolCalls) {
        recentCalls.unshift(`${tc.name}:${JSON.stringify(tc.arguments).slice(0, 50)}`);
      }
    }
  }

  if (recentCalls.length < windowSize) return false;

  for (const patternLen of [1, 2, 3]) {
    if (windowSize % patternLen !== 0) continue;
    const pattern = recentCalls.slice(0, patternLen);
    let allMatch = true;
    for (let i = patternLen; i < windowSize; i += patternLen) {
      for (let j = 0; j < patternLen; j++) {
        if (recentCalls[i + j] !== pattern[j]) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) break;
    }
    if (allMatch) return true;
  }

  return false;
}

export class Session {
  readonly id: string;
  private history: Turn[] = [];
  private state: SessionState = "IDLE";
  private steeringQueue: string[] = [];
  private followupQueue: string[] = [];
  private handlers: AgentEventHandler[] = [];
  private abortController?: AbortController;
  private totalTurns = 0;

  constructor(
    public profile: ProviderProfile,
    public executionEnv: ExecutionEnvironment = new LocalExecutionEnvironment(),
    public config: SessionConfig = {},
    private llmClient: Client = getDefaultClient()
  ) {
    this.id = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.emit("SESSION_START", {});
  }

  on(handler: AgentEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private emit(kind: AgentEventKind, data: Record<string, unknown>): void {
    const event: AgentEvent = { kind, timestamp: new Date(), sessionId: this.id, data };
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {}
    }
  }

  steer(message: string): void {
    this.steeringQueue.push(message);
  }

  followUp(message: string): void {
    this.followupQueue.push(message);
  }

  async submit(input: string): Promise<string> {
    if (this.state === "CLOSED") throw new Error("Session is closed");

    this.state = "PROCESSING";
    this.history.push({ type: "user", content: input, timestamp: new Date() });
    this.emit("USER_INPUT", { content: input });

    // Drain steering
    this.drainSteering();

    let roundCount = 0;
    let finalText = "";

    const maxRoundsPerInput = this.config.maxToolRoundsPerInput ?? 0;
    const maxTurns = this.config.maxTurns ?? 0;

    try {
      while (true) {
        // Check limits
        if (maxRoundsPerInput > 0 && roundCount >= maxRoundsPerInput) {
          this.emit("TURN_LIMIT", { round: roundCount });
          break;
        }
        if (maxTurns > 0 && this.totalTurns >= maxTurns) {
          this.emit("TURN_LIMIT", { totalTurns: this.totalTurns });
          break;
        }

        if (this.abortController?.signal.aborted) break;

        // Build system prompt
        const projectDocs = discoverProjectDocs(this.executionEnv.workingDirectory());
        const systemPrompt = this.profile.buildSystemPrompt(this.executionEnv, projectDocs);
        const messages = historyToMessages(this.history);
        const toolDefs = this.profile.toolRegistry.definitions();

        const req = {
          model: this.profile.model,
          messages: [
            { role: "system" as const, content: [{ kind: "text" as const, text: systemPrompt }] },
            ...messages,
          ],
          tools: toolDefs.length > 0 ? toolDefs as ToolDefinition[] : undefined,
          toolChoice: toolDefs.length > 0 ? { mode: "auto" as const } : undefined,
          reasoningEffort: this.config.reasoningEffort,
          providerOptions: this.profile.providerOptions?.(),
        };

        this.emit("ASSISTANT_TEXT_START", {});

        const response = await this.llmClient.complete(req);

        this.totalTurns++;

        const { Response } = await import("../llm/types.ts");
        const text = Response.getText(response);
        const toolCalls = Response.getToolCalls(response);
        const reasoning = Response.getReasoning(response);

        finalText = text;

        this.history.push({
          type: "assistant",
          content: text,
          toolCalls,
          reasoning,
          timestamp: new Date(),
        });

        this.emit("ASSISTANT_TEXT_END", { text, reasoning });

        // Natural completion
        if (toolCalls.length === 0) break;

        // Execute tools
        roundCount++;
        const results = await this.executeToolCalls(toolCalls);
        this.history.push({ type: "tool_results", results, timestamp: new Date() });

        // Drain steering
        this.drainSteering();

        // Loop detection
        const window = this.config.loopDetectionWindow ?? 10;
        if (this.config.enableLoopDetection !== false && detectLoop(this.history, window)) {
          const warning = `Loop detected: the last ${window} tool calls follow a repeating pattern. Try a different approach.`;
          this.history.push({ type: "steering", content: warning, timestamp: new Date() });
          this.emit("LOOP_DETECTION", { message: warning });
        }
      }
    } finally {
      // Process follow-ups
      if (this.followupQueue.length > 0) {
        const next = this.followupQueue.shift()!;
        this.state = "IDLE";
        // Don't await - fire and forget for follow-ups
        setTimeout(() => this.submit(next), 0);
      } else {
        this.state = "IDLE";
        this.emit("PROCESSING_END", {});
      }
    }

    return finalText;
  }

  private drainSteering(): void {
    while (this.steeringQueue.length > 0) {
      const msg = this.steeringQueue.shift()!;
      this.history.push({ type: "steering", content: msg, timestamp: new Date() });
      this.emit("STEERING_INJECTED", { content: msg });
    }
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    if (this.profile.supportsParallelToolCalls && toolCalls.length > 1) {
      return Promise.all(toolCalls.map((tc) => this.executeSingleTool(tc)));
    }

    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      results.push(await this.executeSingleTool(tc));
    }
    return results;
  }

  private async executeSingleTool(toolCall: ToolCall): Promise<ToolResult> {
    this.emit("TOOL_CALL_START", { toolName: toolCall.name, callId: toolCall.id });

    const registered = this.profile.toolRegistry.get(toolCall.name);
    if (!registered) {
      const error = `Unknown tool: ${toolCall.name}`;
      this.emit("TOOL_CALL_END", { callId: toolCall.id, error });
      return { toolCallId: toolCall.id, content: error, isError: true };
    }

    try {
      const rawOutput = await registered.executor(toolCall.arguments, this.executionEnv);
      const truncated = truncateToolOutput(rawOutput, toolCall.name);

      // Full output in events, truncated to LLM
      this.emit("TOOL_CALL_END", { callId: toolCall.id, output: rawOutput });

      return { toolCallId: toolCall.id, content: truncated, isError: false };
    } catch (err) {
      const error = `Tool error (${toolCall.name}): ${err instanceof Error ? err.message : String(err)}`;
      this.emit("TOOL_CALL_END", { callId: toolCall.id, error });
      return { toolCallId: toolCall.id, content: error, isError: true };
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.state = "CLOSED";
    this.emit("SESSION_END", { finalState: "CLOSED" });
  }

  close(): void {
    this.state = "CLOSED";
    this.emit("SESSION_END", { finalState: "CLOSED" });
  }

  getHistory(): Turn[] {
    return [...this.history];
  }

  getState(): SessionState {
    return this.state;
  }
}
