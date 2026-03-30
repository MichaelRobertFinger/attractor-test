import Anthropic from "@anthropic-ai/sdk";
import type {
  Request,
  Response,
  Message,
  ContentPart,
  ToolDefinition,
  StreamEvent,
  Usage,
} from "../types.ts";
import {
  AuthenticationError,
  RateLimitError,
  ServerError,
  InvalidRequestError,
  ContextLengthError,
  NetworkError,
  SDKError,
  ProviderError,
} from "../types.ts";

const PROVIDER = "anthropic";

function mapRequestToAnthropic(req: Request): Anthropic.MessageCreateParams {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemParts.push(
        msg.content
          .filter((p) => p.kind === "text")
          .map((p) => p.text ?? "")
          .join("")
      );
      continue;
    }

    if (msg.role === "tool") {
      // Anthropic tool results go as user messages with tool_result blocks
      const results: Anthropic.ToolResultBlockParam[] = msg.content
        .filter((p) => p.kind === "tool_result" && p.toolResult)
        .map((p) => ({
          type: "tool_result" as const,
          tool_use_id: p.toolResult!.toolCallId,
          content:
            typeof p.toolResult!.content === "string"
              ? p.toolResult!.content
              : JSON.stringify(p.toolResult!.content),
          is_error: p.toolResult!.isError,
        }));
      messages.push({ role: "user", content: results });
      continue;
    }

    const role = msg.role === "user" ? "user" : "assistant";
    const content: Anthropic.ContentBlockParam[] = [];

    for (const part of msg.content) {
      if (part.kind === "text" && part.text) {
        content.push({ type: "text", text: part.text });
      } else if (part.kind === "tool_call" && part.toolCall) {
        content.push({
          type: "tool_use",
          id: part.toolCall.id,
          name: part.toolCall.name,
          input:
            typeof part.toolCall.arguments === "string"
              ? JSON.parse(part.toolCall.arguments)
              : part.toolCall.arguments,
        });
      } else if (part.kind === "thinking" && part.thinking) {
        content.push({
          type: "thinking",
          thinking: part.thinking.text,
          signature: part.thinking.signature ?? "",
        } as unknown as Anthropic.ContentBlockParam);
      } else if (part.kind === "image" && part.image) {
        if (part.image.url) {
          content.push({
            type: "image",
            source: { type: "url", url: part.image.url },
          } as unknown as Anthropic.ContentBlockParam);
        } else if (part.image.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: (part.image.mediaType ?? "image/png") as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: Buffer.from(part.image.data).toString("base64"),
            },
          });
        }
      }
    }

    if (content.length > 0) {
      messages.push({ role, content });
    }
  }

  const tools: Anthropic.Tool[] | undefined =
    req.tools && req.tools.length > 0
      ? req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }))
      : undefined;

  const opts = (req.providerOptions?.["anthropic"] as Record<string, unknown>) ?? {};
  const betaHeaders = (opts["beta_headers"] as string[]) ?? [];

  const params: Anthropic.MessageCreateParams = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8096,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    ...(tools ? { tools } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stopSequences ? { stop_sequences: req.stopSequences } : {}),
  };

  // Tool choice
  if (req.toolChoice && tools) {
    if (req.toolChoice.mode === "auto") {
      (params as unknown as Record<string, unknown>).tool_choice = { type: "auto" };
    } else if (req.toolChoice.mode === "required") {
      (params as unknown as Record<string, unknown>).tool_choice = { type: "any" };
    } else if (req.toolChoice.mode === "named" && req.toolChoice.toolName) {
      (params as unknown as Record<string, unknown>).tool_choice = {
        type: "tool",
        name: req.toolChoice.toolName,
      };
    }
    // none = omit tools - handled above
  }

  void betaHeaders; // used via client headers below
  return params;
}

function mapResponseFromAnthropic(
  resp: Anthropic.Message,
  model: string
): Response {
  const content: ContentPart[] = [];
  let reasoningTokens: number | undefined;

  for (const block of resp.content) {
    if (block.type === "text") {
      content.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({
        kind: "tool_call",
        toolCall: {
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        },
      });
    } else if (block.type === "thinking") {
      const b = block as { type: "thinking"; thinking: string; signature?: string };
      const text = b.thinking;
      const tokenEst = Math.ceil(text.length / 4);
      reasoningTokens = (reasoningTokens ?? 0) + tokenEst;
      content.push({
        kind: "thinking",
        thinking: { text, signature: b.signature, redacted: false },
      });
    }
  }

  const usage: Usage = {
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
    reasoningTokens,
    cacheReadTokens:
      (resp.usage as unknown as Record<string, unknown>)["cache_read_input_tokens"] as
        | number
        | undefined,
    cacheWriteTokens:
      (resp.usage as unknown as Record<string, unknown>)["cache_creation_input_tokens"] as
        | number
        | undefined,
  };

  let finishReason: Response["finishReason"];
  switch (resp.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      finishReason = { reason: "stop", raw: resp.stop_reason };
      break;
    case "max_tokens":
      finishReason = { reason: "length", raw: resp.stop_reason };
      break;
    case "tool_use":
      finishReason = { reason: "tool_calls", raw: resp.stop_reason };
      break;
    default:
      finishReason = { reason: "other", raw: resp.stop_reason ?? undefined };
  }

  return {
    id: resp.id,
    model,
    provider: PROVIDER,
    message: { role: "assistant", content },
    finishReason,
    usage,
  };
}

function mapError(err: unknown, provider = PROVIDER): SDKError {
  if (err instanceof Anthropic.APIError) {
    const msg = err.message;
    const status = err.status;
    if (status === 401) return new AuthenticationError(msg, provider);
    if (status === 429) {
      const retryAfter = err.headers?.["retry-after"]
        ? parseFloat(err.headers["retry-after"] as string)
        : undefined;
      return new RateLimitError(msg, provider, retryAfter);
    }
    if (status === 413 || msg.toLowerCase().includes("context length")) {
      return new ContextLengthError(msg, provider);
    }
    if (status === 400 || status === 422) {
      return new InvalidRequestError(msg, provider);
    }
    if (status && status >= 500) return new ServerError(msg, provider, status);
    return new ProviderError(msg, provider, { statusCode: status, retryable: false });
  }
  if (err instanceof Error) {
    return new NetworkError(err.message, err);
  }
  return new SDKError(String(err));
}

export class AnthropicAdapter {
  readonly name = PROVIDER;
  private client: Anthropic;

  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(req: Request): Promise<Response> {
    try {
      const params = mapRequestToAnthropic(req);
      const opts = (req.providerOptions?.["anthropic"] as Record<string, unknown>) ?? {};
      const betaHeaders = (opts["beta_headers"] as string[]) ?? [];

      const response = (await this.client.messages.create(params, {
        headers: betaHeaders.length
          ? { "anthropic-beta": betaHeaders.join(",") }
          : {},
      })) as Anthropic.Message;

      return mapResponseFromAnthropic(response, req.model);
    } catch (err) {
      throw mapError(err);
    }
  }

  async *stream(req: Request): AsyncGenerator<StreamEvent> {
    try {
      const params = mapRequestToAnthropic(req);
      const opts = (req.providerOptions?.["anthropic"] as Record<string, unknown>) ?? {};
      const betaHeaders = (opts["beta_headers"] as string[]) ?? [];

      const stream = this.client.messages.stream(
        { ...params, stream: true } as Anthropic.MessageStreamParams,
        {
          headers: betaHeaders.length
            ? { "anthropic-beta": betaHeaders.join(",") }
            : {},
        }
      );

      yield { type: "stream_start" };

      let currentToolCallId: string | undefined;
      let currentToolCallName: string | undefined;
      let currentToolCallArgs = "";

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            yield { type: "text_start", textId: String(event.index) };
          } else if (event.content_block.type === "tool_use") {
            currentToolCallId = event.content_block.id;
            currentToolCallName = event.content_block.name;
            currentToolCallArgs = "";
            yield {
              type: "tool_call_start",
              toolCall: {
                id: event.content_block.id,
                name: event.content_block.name,
              },
            };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield {
              type: "text_delta",
              delta: event.delta.text,
              textId: String(event.index),
            };
          } else if (event.delta.type === "input_json_delta") {
            currentToolCallArgs += event.delta.partial_json;
            yield {
              type: "tool_call_delta",
              delta: event.delta.partial_json,
            };
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolCallId) {
            yield {
              type: "tool_call_end",
              toolCall: {
                id: currentToolCallId,
                name: currentToolCallName,
                arguments: currentToolCallArgs
                  ? JSON.parse(currentToolCallArgs)
                  : {},
              },
            };
            currentToolCallId = undefined;
            currentToolCallName = undefined;
            currentToolCallArgs = "";
          }
        } else if (event.type === "message_stop") {
          // final message assembled by stream
        } else if (event.type === "message_delta") {
          // usage update
        }
      }

      const finalMsg = await stream.finalMessage();
      const response = mapResponseFromAnthropic(finalMsg, req.model);
      yield { type: "finish", finishReason: response.finishReason, usage: response.usage, response };
    } catch (err) {
      throw mapError(err);
    }
  }
}
