import OpenAI from "openai";
import type {
  Request,
  Response,
  Message,
  ContentPart,
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

const PROVIDER = "openai";

function mapMessagesToOpenAI(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      result.push({
        role: "system",
        content: msg.content
          .filter((p) => p.kind === "text")
          .map((p) => p.text ?? "")
          .join(""),
      });
    } else if (msg.role === "user") {
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const part of msg.content) {
        if (part.kind === "text" && part.text) {
          parts.push({ type: "text", text: part.text });
        } else if (part.kind === "image" && part.image) {
          if (part.image.url) {
            parts.push({
              type: "image_url",
              image_url: {
                url: part.image.url,
                detail: part.image.detail,
              },
            });
          } else if (part.image.data) {
            const b64 = Buffer.from(part.image.data).toString("base64");
            const mime = part.image.mediaType ?? "image/png";
            parts.push({
              type: "image_url",
              image_url: { url: `data:${mime};base64,${b64}` },
            });
          }
        }
      }
      result.push({ role: "user", content: parts.length === 1 && parts[0]?.type === "text" ? (parts[0] as OpenAI.Chat.ChatCompletionContentPartText).text : parts });
    } else if (msg.role === "assistant") {
      const textParts = msg.content.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
      const toolCalls = msg.content
        .filter((p) => p.kind === "tool_call" && p.toolCall)
        .map((p) => ({
          id: p.toolCall!.id,
          type: "function" as const,
          function: {
            name: p.toolCall!.name,
            arguments:
              typeof p.toolCall!.arguments === "string"
                ? p.toolCall!.arguments
                : JSON.stringify(p.toolCall!.arguments),
          },
        }));

      result.push({
        role: "assistant",
        content: textParts || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam);
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part.kind === "tool_result" && part.toolResult) {
          result.push({
            role: "tool",
            tool_call_id: part.toolResult.toolCallId,
            content:
              typeof part.toolResult.content === "string"
                ? part.toolResult.content
                : JSON.stringify(part.toolResult.content),
          });
        }
      }
    }
  }

  return result;
}

function mapResponseFromOpenAI(
  resp: OpenAI.Chat.ChatCompletion,
  model: string
): Response {
  const choice = resp.choices[0];
  if (!choice) throw new SDKError("No choices in OpenAI response");

  const content: ContentPart[] = [];

  if (choice.message.content) {
    content.push({ kind: "text", text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type === "function") {
        content.push({
          kind: "tool_call",
          toolCall: {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        });
      }
    }
  }

  const usage: Usage = {
    inputTokens: resp.usage?.prompt_tokens ?? 0,
    outputTokens: resp.usage?.completion_tokens ?? 0,
    totalTokens: resp.usage?.total_tokens ?? 0,
    reasoningTokens: (resp.usage as unknown as Record<string, unknown>)?.["completion_tokens_details"]
      ? (
          (resp.usage as unknown as Record<string, unknown>)["completion_tokens_details"] as Record<
            string,
            unknown
          >
        )["reasoning_tokens"] as number | undefined
      : undefined,
  };

  let finishReason: Response["finishReason"];
  switch (choice.finish_reason) {
    case "stop":
      finishReason = { reason: "stop", raw: "stop" };
      break;
    case "length":
      finishReason = { reason: "length", raw: "length" };
      break;
    case "tool_calls":
      finishReason = { reason: "tool_calls", raw: "tool_calls" };
      break;
    case "content_filter":
      finishReason = { reason: "content_filter", raw: "content_filter" };
      break;
    default:
      finishReason = { reason: "other", raw: choice.finish_reason ?? undefined };
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

function mapError(err: unknown): SDKError {
  if (err instanceof OpenAI.APIError) {
    const msg = err.message;
    const status = err.status;
    if (status === 401) return new AuthenticationError(msg, PROVIDER);
    if (status === 429) {
      const retryAfter = err.headers?.["retry-after"]
        ? parseFloat(String(err.headers["retry-after"]))
        : undefined;
      return new RateLimitError(msg, PROVIDER, retryAfter);
    }
    if (status === 413 || msg.toLowerCase().includes("context length")) {
      return new ContextLengthError(msg, PROVIDER);
    }
    if (status === 400 || status === 422) {
      return new InvalidRequestError(msg, PROVIDER);
    }
    if (status && status >= 500) return new ServerError(msg, PROVIDER, status);
    return new ProviderError(msg, PROVIDER, { statusCode: status, retryable: false });
  }
  if (err instanceof Error) return new NetworkError(err.message, err);
  return new SDKError(String(err));
}

export class OpenAIAdapter {
  readonly name = PROVIDER;
  private client: OpenAI;

  constructor(opts: { apiKey?: string; baseURL?: string; orgId?: string } = {}) {
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"],
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.orgId ? { organization: opts.orgId } : {}),
    });
  }

  async complete(req: Request): Promise<Response> {
    try {
      const messages = mapMessagesToOpenAI(req.messages);
      const tools: OpenAI.Chat.ChatCompletionTool[] | undefined =
        req.tools && req.tools.length > 0
          ? req.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined;

      let toolChoice: OpenAI.Chat.ChatCompletionToolChoiceOption | undefined;
      if (req.toolChoice && tools) {
        if (req.toolChoice.mode === "none") toolChoice = "none";
        else if (req.toolChoice.mode === "required") toolChoice = "required";
        else if (req.toolChoice.mode === "auto") toolChoice = "auto";
        else if (req.toolChoice.mode === "named" && req.toolChoice.toolName) {
          toolChoice = { type: "function", function: { name: req.toolChoice.toolName } };
        }
      }

      const resp = await this.client.chat.completions.create({
        model: req.model,
        messages,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(req.stopSequences ? { stop: req.stopSequences } : {}),
      });

      return mapResponseFromOpenAI(resp, req.model);
    } catch (err) {
      throw mapError(err);
    }
  }

  async *stream(req: Request): AsyncGenerator<StreamEvent> {
    try {
      const messages = mapMessagesToOpenAI(req.messages);
      const tools: OpenAI.Chat.ChatCompletionTool[] | undefined =
        req.tools && req.tools.length > 0
          ? req.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined;

      yield { type: "stream_start" };

      const stream = await this.client.chat.completions.create({
        model: req.model,
        messages,
        ...(tools ? { tools } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: true,
        stream_options: { include_usage: true },
      });

      let textBuffer = "";
      const toolCallBuffers: Record<string, { name: string; args: string }> = {};

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          textBuffer += delta.content;
          yield { type: "text_delta", delta: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = String(tc.index);
            if (tc.id) {
              toolCallBuffers[idx] = { name: tc.function?.name ?? "", args: "" };
              yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function?.name } };
            }
            if (tc.function?.arguments && toolCallBuffers[idx]) {
              toolCallBuffers[idx]!.args += tc.function.arguments;
              yield { type: "tool_call_delta", delta: tc.function.arguments };
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          for (const [, buf] of Object.entries(toolCallBuffers)) {
            yield {
              type: "tool_call_end",
              toolCall: {
                name: buf.name,
                arguments: buf.args ? JSON.parse(buf.args) : {},
              },
            };
          }

          const usage: Usage = {
            inputTokens: chunk.usage?.prompt_tokens ?? 0,
            outputTokens: chunk.usage?.completion_tokens ?? 0,
            totalTokens: chunk.usage?.total_tokens ?? 0,
          };

          yield { type: "finish", finishReason: { reason: "stop" }, usage };
        }
      }
    } catch (err) {
      throw mapError(err);
    }
  }
}
