// Unified LLM Client - Data Model

export type Role = "system" | "user" | "assistant" | "tool" | "developer";

export type ContentKind =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "redacted_thinking"
  | string;

export interface ImageData {
  url?: string;
  data?: Uint8Array;
  mediaType?: string;
  detail?: "auto" | "low" | "high";
}

export interface AudioData {
  url?: string;
  data?: Uint8Array;
  mediaType?: string;
}

export interface DocumentData {
  url?: string;
  data?: Uint8Array;
  mediaType?: string;
  fileName?: string;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  type?: string;
}

export interface ToolResultData {
  toolCallId: string;
  content: string | Record<string, unknown> | unknown[];
  isError: boolean;
  imageData?: Uint8Array;
  imageMediaType?: string;
}

export interface ThinkingData {
  text: string;
  signature?: string;
  redacted: boolean;
}

export interface ContentPart {
  kind: ContentKind;
  text?: string;
  image?: ImageData;
  audio?: AudioData;
  document?: DocumentData;
  toolCall?: ToolCallData;
  toolResult?: ToolResultData;
  thinking?: ThinkingData;
}

export interface Message {
  role: Role;
  content: ContentPart[];
  name?: string;
  toolCallId?: string;
}

export namespace Message {
  export function system(text: string): Message {
    return { role: "system", content: [{ kind: "text", text }] };
  }
  export function user(text: string): Message {
    return { role: "user", content: [{ kind: "text", text }] };
  }
  export function assistant(text: string): Message {
    return { role: "assistant", content: [{ kind: "text", text }] };
  }
  export function toolResult(toolCallId: string, content: string, isError = false): Message {
    return {
      role: "tool",
      toolCallId,
      content: [{ kind: "tool_result", toolResult: { toolCallId, content, isError } }],
    };
  }
  export function getText(msg: Message): string {
    return msg.content
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolChoice {
  mode: "auto" | "none" | "required" | "named";
  toolName?: string;
}

export interface ResponseFormat {
  type: "text" | "json" | "json_schema";
  jsonSchema?: Record<string, unknown>;
  strict?: boolean;
}

export interface Request {
  model: string;
  messages: Message[];
  provider?: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  reasoningEffort?: "low" | "medium" | "high";
  metadata?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  raw?: Record<string, unknown>;
}

export namespace Usage {
  export function zero(): Usage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  export function add(a: Usage, b: Usage): Usage {
    return {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      totalTokens: a.totalTokens + b.totalTokens,
      reasoningTokens:
        a.reasoningTokens != null || b.reasoningTokens != null
          ? (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
          : undefined,
      cacheReadTokens:
        a.cacheReadTokens != null || b.cacheReadTokens != null
          ? (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
          : undefined,
      cacheWriteTokens:
        a.cacheWriteTokens != null || b.cacheWriteTokens != null
          ? (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
          : undefined,
    };
  }
}

export interface FinishReason {
  reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";
  raw?: string;
}

export interface Warning {
  message: string;
  code?: string;
}

export interface RateLimitInfo {
  requestsRemaining?: number;
  requestsLimit?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  resetAt?: Date;
}

export interface Response {
  id: string;
  model: string;
  provider: string;
  message: Message;
  finishReason: FinishReason;
  usage: Usage;
  raw?: Record<string, unknown>;
  warnings?: Warning[];
  rateLimit?: RateLimitInfo;
}

export namespace Response {
  export function getText(r: Response): string {
    return Message.getText(r.message);
  }
  export function getToolCalls(r: Response): ToolCall[] {
    return r.message.content
      .filter((p) => p.kind === "tool_call" && p.toolCall)
      .map((p) => {
        const tc = p.toolCall!;
        return {
          id: tc.id,
          name: tc.name,
          arguments:
            typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
          rawArguments: typeof tc.arguments === "string" ? tc.arguments : undefined,
        } as ToolCall;
      });
  }
  export function getReasoning(r: Response): string | undefined {
    const parts = r.message.content.filter((p) => p.kind === "thinking" && p.thinking);
    if (parts.length === 0) return undefined;
    return parts.map((p) => p.thinking!.text).join("\n");
  }
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string | Record<string, unknown> | unknown[];
  isError: boolean;
}

export type StreamEventType =
  | "stream_start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_end"
  | "finish"
  | "error"
  | "provider_event";

export interface StreamEvent {
  type: StreamEventType | string;
  delta?: string;
  textId?: string;
  reasoningDelta?: string;
  toolCall?: Partial<ToolCall>;
  finishReason?: FinishReason;
  usage?: Usage;
  response?: Response;
  error?: SDKError;
  raw?: Record<string, unknown>;
}

// Error hierarchy
export class SDKError extends Error {
  override cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "SDKError";
    this.cause = cause;
  }
}

export class ProviderError extends SDKError {
  provider: string;
  statusCode?: number;
  errorCode?: string;
  retryable: boolean;
  retryAfter?: number;
  raw?: Record<string, unknown>;

  constructor(
    message: string,
    provider: string,
    opts: {
      statusCode?: number;
      errorCode?: string;
      retryable?: boolean;
      retryAfter?: number;
      raw?: Record<string, unknown>;
      cause?: Error;
    } = {}
  ) {
    super(message, opts.cause);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = opts.statusCode;
    this.errorCode = opts.errorCode;
    this.retryable = opts.retryable ?? true;
    this.retryAfter = opts.retryAfter;
    this.raw = opts.raw;
  }
}

export class AuthenticationError extends ProviderError {
  constructor(message: string, provider: string) {
    super(message, provider, { statusCode: 401, retryable: false });
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends ProviderError {
  constructor(message: string, provider: string, retryAfter?: number) {
    super(message, provider, { statusCode: 429, retryable: true, retryAfter });
    this.name = "RateLimitError";
  }
}

export class ServerError extends ProviderError {
  constructor(message: string, provider: string, statusCode = 500) {
    super(message, provider, { statusCode, retryable: true });
    this.name = "ServerError";
  }
}

export class InvalidRequestError extends ProviderError {
  constructor(message: string, provider: string) {
    super(message, provider, { statusCode: 400, retryable: false });
    this.name = "InvalidRequestError";
  }
}

export class ContextLengthError extends ProviderError {
  constructor(message: string, provider: string) {
    super(message, provider, { statusCode: 413, retryable: false });
    this.name = "ContextLengthError";
  }
}

export class ConfigurationError extends SDKError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class NetworkError extends SDKError {
  retryable = true;
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "NetworkError";
  }
}

export class AbortError extends SDKError {
  constructor(message = "Request aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class NoObjectGeneratedError extends SDKError {
  constructor(message: string) {
    super(message);
    this.name = "NoObjectGeneratedError";
  }
}

// Retry policy
export interface RetryPolicy {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
  shouldRetry?: (error: SDKError) => boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelay: 1000,
  maxDelay: 60000,
  backoffMultiplier: 2,
  jitter: true,
};

export function calcRetryDelay(attempt: number, policy: RetryPolicy): number {
  const base = Math.min(
    policy.baseDelay * Math.pow(policy.backoffMultiplier, attempt),
    policy.maxDelay
  );
  if (!policy.jitter) return base;
  return base * (0.5 + Math.random());
}

// Model catalog
export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutput?: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  aliases?: string[];
}

export const MODEL_CATALOG: ModelInfo[] = [
  // Anthropic
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    displayName: "Claude Opus 4.6",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.6",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.5",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  // OpenAI
  {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o Mini",
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  {
    id: "o3",
    provider: "openai",
    displayName: "o3",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  // Gemini
  {
    id: "gemini-2.0-flash",
    provider: "gemini",
    displayName: "Gemini 2.0 Flash",
    contextWindow: 1048576,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  {
    id: "gemini-1.5-pro",
    provider: "gemini",
    displayName: "Gemini 1.5 Pro",
    contextWindow: 2097152,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
];

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_CATALOG.find(
    (m) => m.id === modelId || m.aliases?.includes(modelId)
  );
}

export function listModels(provider?: string): ModelInfo[] {
  if (!provider) return MODEL_CATALOG;
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}
