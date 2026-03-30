import type { Request, Response, Message, ToolCall, ToolResult, Usage, StreamEvent } from "./types.ts";
import { Usage as UsageNS, NoObjectGeneratedError } from "./types.ts";
import { Client, getDefaultClient } from "./client.ts";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: (args: Record<string, unknown>) => Promise<string | Record<string, unknown>> | string | Record<string, unknown>;
}

export interface StepResult {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  finishReason: Response["finishReason"];
  usage: Usage;
  response: Response;
}

export interface GenerateResult {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  finishReason: Response["finishReason"];
  usage: Usage;
  totalUsage: Usage;
  steps: StepResult[];
  response: Response;
  output?: unknown;
}

export interface GenerateOptions {
  model: string;
  prompt?: string;
  messages?: Message[];
  system?: string;
  tools?: Tool[];
  maxToolRounds?: number;
  responseFormat?: Request["responseFormat"];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  reasoningEffort?: "low" | "medium" | "high";
  provider?: string;
  providerOptions?: Record<string, unknown>;
  maxRetries?: number;
  client?: Client;
}

async function executeAllTools(
  tools: Tool[],
  calls: ToolCall[]
): Promise<ToolResult[]> {
  return Promise.all(
    calls.map(async (call) => {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool?.execute) {
        return { toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
      }
      try {
        const result = await tool.execute(call.arguments);
        return {
          toolCallId: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
          isError: false,
        };
      } catch (err) {
        return {
          toolCallId: call.id,
          content: `Tool error (${call.name}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    })
  );
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const client = opts.client ?? getDefaultClient();
  const maxToolRounds = opts.maxToolRounds ?? 1;

  // Build initial messages
  let messages: Message[] = [];
  if (opts.system) messages.push({ role: "system", content: [{ kind: "text", text: opts.system }] });
  if (opts.messages) {
    messages.push(...opts.messages);
  } else if (opts.prompt) {
    messages.push({ role: "user", content: [{ kind: "text", text: opts.prompt }] });
  }

  const toolDefs = opts.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const steps: StepResult[] = [];
  let totalUsage = UsageNS.zero();

  for (let round = 0; round <= maxToolRounds; round++) {
    const req: Request = {
      model: opts.model,
      messages,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(toolDefs?.length ? { tools: toolDefs } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.stopSequences ? { stopSequences: opts.stopSequences } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
    };

    const response = await client.complete(req);
    const { getText, getToolCalls, getReasoning } = await import("./types.ts").then(m => m.Response);
    const text = getText(response);
    const toolCalls = getToolCalls(response);
    const reasoning = getReasoning(response);

    totalUsage = UsageNS.add(totalUsage, response.usage);

    const hasToolCalls = toolCalls.length > 0 && response.finishReason.reason === "tool_calls";
    let toolResults: ToolResult[] = [];

    if (hasToolCalls && round < maxToolRounds && opts.tools) {
      toolResults = await executeAllTools(opts.tools, toolCalls);
    }

    steps.push({
      text,
      reasoning,
      toolCalls,
      toolResults,
      finishReason: response.finishReason,
      usage: response.usage,
      response,
    });

    if (!hasToolCalls || round >= maxToolRounds || !opts.tools) break;

    // Continue conversation
    messages = [...messages, response.message];
    for (const result of toolResults) {
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

  const lastStep = steps[steps.length - 1]!;
  return {
    text: lastStep.text,
    reasoning: lastStep.reasoning,
    toolCalls: lastStep.toolCalls,
    toolResults: lastStep.toolResults,
    finishReason: lastStep.finishReason,
    usage: lastStep.usage,
    totalUsage,
    steps,
    response: lastStep.response,
  };
}

export interface StreamOptions extends GenerateOptions {
  onEvent?: (event: StreamEvent) => void;
}

export async function* streamGenerate(opts: StreamOptions): AsyncGenerator<StreamEvent> {
  const client = opts.client ?? getDefaultClient();
  let messages: Message[] = [];
  if (opts.system) messages.push({ role: "system", content: [{ kind: "text", text: opts.system }] });
  if (opts.messages) messages.push(...opts.messages);
  else if (opts.prompt) messages.push({ role: "user", content: [{ kind: "text", text: opts.prompt }] });

  const toolDefs = opts.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const req: Request = {
    model: opts.model,
    messages,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(toolDefs?.length ? { tools: toolDefs } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
  };

  for await (const event of client.stream(req)) {
    opts.onEvent?.(event);
    yield event;
  }
}

export async function generateObject<T = unknown>(
  opts: GenerateOptions & { schema: Record<string, unknown> }
): Promise<T> {
  const result = await generate({
    ...opts,
    responseFormat: { type: "json_schema", jsonSchema: opts.schema },
  });

  try {
    return JSON.parse(result.text) as T;
  } catch {
    // Fallback: try to extract JSON from the text
    const match = result.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        // fall through
      }
    }
    throw new NoObjectGeneratedError(
      `Failed to parse structured output: ${result.text.slice(0, 200)}`
    );
  }
}
