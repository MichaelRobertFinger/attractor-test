import {
  GoogleGenerativeAI,
  type GenerateContentRequest,
  type Content,
  type Part,
  type FunctionDeclaration,
} from "@google/generative-ai";
import type { Request, Response, Message, ContentPart, StreamEvent, Usage } from "../types.ts";
import {
  AuthenticationError,
  RateLimitError,
  ServerError,
  SDKError,
  NetworkError,
  ProviderError,
} from "../types.ts";

const PROVIDER = "gemini";

function mapMessagesToGemini(messages: Message[]): { system?: string; contents: Content[] } {
  const systemParts: string[] = [];
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemParts.push(
        msg.content
          .filter((p) => p.kind === "text")
          .map((p) => p.text ?? "")
          .join("")
      );
      continue;
    }

    const parts: Part[] = [];

    for (const part of msg.content) {
      if (part.kind === "text" && part.text) {
        parts.push({ text: part.text });
      } else if (part.kind === "tool_call" && part.toolCall) {
        parts.push({
          functionCall: {
            name: part.toolCall.name,
            args:
              typeof part.toolCall.arguments === "string"
                ? JSON.parse(part.toolCall.arguments)
                : part.toolCall.arguments,
          },
        });
      } else if (part.kind === "tool_result" && part.toolResult) {
        parts.push({
          functionResponse: {
            name: part.toolResult.toolCallId,
            response: {
              content:
                typeof part.toolResult.content === "string"
                  ? part.toolResult.content
                  : part.toolResult.content,
            },
          },
        });
      } else if (part.kind === "image" && part.image?.data) {
        parts.push({
          inlineData: {
            data: Buffer.from(part.image.data).toString("base64"),
            mimeType: part.image.mediaType ?? "image/png",
          },
        });
      }
    }

    if (parts.length > 0) {
      const role =
        msg.role === "user" || msg.role === "tool" ? "user" : "model";
      contents.push({ role, parts });
    }
  }

  return { system: systemParts.join("\n\n") || undefined, contents };
}

function mapError(err: unknown): SDKError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("API_KEY") || msg.includes("UNAUTHENTICATED")) {
    return new AuthenticationError(msg, PROVIDER);
  }
  if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
    return new RateLimitError(msg, PROVIDER);
  }
  if (msg.includes("UNAVAILABLE") || msg.includes("INTERNAL")) {
    return new ServerError(msg, PROVIDER);
  }
  if (err instanceof Error) return new NetworkError(msg, err);
  return new ProviderError(msg, PROVIDER);
}

export class GeminiAdapter {
  readonly name = PROVIDER;
  private genai: GoogleGenerativeAI;

  constructor(opts: { apiKey?: string } = {}) {
    this.genai = new GoogleGenerativeAI(
      opts.apiKey ?? process.env["GEMINI_API_KEY"] ?? ""
    );
  }

  async complete(req: Request): Promise<Response> {
    try {
      const { system, contents } = mapMessagesToGemini(req.messages);
      const model = this.genai.getGenerativeModel({
        model: req.model,
        ...(system ? { systemInstruction: system } : {}),
        ...(req.tools && req.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: req.tools.map(
                    (t) =>
                      ({
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                      }) as unknown as FunctionDeclaration
                  ),
                },
              ],
            }
          : {}),
      });

      const genReq: GenerateContentRequest = {
        contents,
        ...(req.maxTokens
          ? { generationConfig: { maxOutputTokens: req.maxTokens } }
          : {}),
      };

      const result = await model.generateContent(genReq);
      const resp = result.response;

      const content: ContentPart[] = [];
      for (const part of resp.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          content.push({ kind: "text", text: part.text });
        } else if (part.functionCall) {
          content.push({
            kind: "tool_call",
            toolCall: {
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              name: part.functionCall.name,
              arguments: part.functionCall.args as Record<string, unknown>,
            },
          });
        }
      }

      const hasToolCalls = content.some((p) => p.kind === "tool_call");
      const usage: Usage = {
        inputTokens: resp.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: resp.usageMetadata?.totalTokenCount ?? 0,
      };

      return {
        id: `gemini-${Date.now()}`,
        model: req.model,
        provider: PROVIDER,
        message: { role: "assistant", content },
        finishReason: {
          reason: hasToolCalls ? "tool_calls" : "stop",
          raw: resp.candidates?.[0]?.finishReason ?? undefined,
        },
        usage,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async *stream(req: Request): AsyncGenerator<StreamEvent> {
    try {
      const { system, contents } = mapMessagesToGemini(req.messages);
      const model = this.genai.getGenerativeModel({
        model: req.model,
        ...(system ? { systemInstruction: system } : {}),
      });

      yield { type: "stream_start" };

      const result = await model.generateContentStream({ contents });

      for await (const chunk of result.stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            yield { type: "text_delta", delta: part.text };
          }
        }
      }

      const final = await result.response;
      const usage: Usage = {
        inputTokens: final.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: final.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: final.usageMetadata?.totalTokenCount ?? 0,
      };

      yield { type: "finish", finishReason: { reason: "stop" }, usage };
    } catch (err) {
      throw mapError(err);
    }
  }
}
