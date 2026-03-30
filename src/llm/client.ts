import type { Request, Response, StreamEvent, SDKError, RetryPolicy } from "./types.ts";
import { DEFAULT_RETRY_POLICY, calcRetryDelay, ConfigurationError } from "./types.ts";
import { AnthropicAdapter } from "./adapters/anthropic.ts";
import { OpenAIAdapter } from "./adapters/openai.ts";
import { GeminiAdapter } from "./adapters/gemini.ts";

export interface ProviderAdapter {
  readonly name: string;
  complete(req: Request): Promise<Response>;
  stream(req: Request): AsyncGenerator<StreamEvent>;
}

export type Middleware = (
  req: Request,
  next: (req: Request) => Promise<Response>
) => Promise<Response>;

export interface ClientOptions {
  providers?: Record<string, ProviderAdapter>;
  defaultProvider?: string;
  middleware?: Middleware[];
  retryPolicy?: RetryPolicy;
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object" && "retryable" in err) {
    return (err as { retryable: boolean }).retryable;
  }
  return true; // unknown errors default to retryable
}

export class Client {
  private providers: Map<string, ProviderAdapter>;
  private defaultProvider: string | undefined;
  private middleware: Middleware[];
  private retryPolicy: RetryPolicy;

  constructor(opts: ClientOptions = {}) {
    this.providers = new Map(Object.entries(opts.providers ?? {}));
    this.defaultProvider = opts.defaultProvider;
    this.middleware = opts.middleware ?? [];
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  static fromEnv(opts: Partial<ClientOptions> = {}): Client {
    const providers: Record<string, ProviderAdapter> = {};
    let defaultProvider: string | undefined;

    if (process.env["ANTHROPIC_API_KEY"]) {
      providers["anthropic"] = new AnthropicAdapter();
      defaultProvider ??= "anthropic";
    }
    if (process.env["OPENAI_API_KEY"]) {
      providers["openai"] = new OpenAIAdapter();
      defaultProvider ??= "openai";
    }
    if (process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"]) {
      providers["gemini"] = new GeminiAdapter({
        apiKey: process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"],
      });
      defaultProvider ??= "gemini";
    }

    return new Client({
      providers,
      defaultProvider,
      ...opts,
    });
  }

  registerProvider(adapter: ProviderAdapter): void {
    this.providers.set(adapter.name, adapter);
    if (!this.defaultProvider) this.defaultProvider = adapter.name;
  }

  private resolveProvider(req: Request): ProviderAdapter {
    const providerName = req.provider ?? this.defaultProvider;
    if (!providerName) {
      throw new ConfigurationError("No provider specified and no default provider configured");
    }
    const adapter = this.providers.get(providerName);
    if (!adapter) {
      throw new ConfigurationError(`Provider "${providerName}" is not registered`);
    }
    return adapter;
  }

  async complete(req: Request): Promise<Response> {
    const adapter = this.resolveProvider(req);

    const base = async (r: Request): Promise<Response> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
        try {
          return await adapter.complete(r);
        } catch (err) {
          lastErr = err;
          if (!isRetryable(err) || attempt >= this.retryPolicy.maxRetries) break;
          const delay = calcRetryDelay(attempt, this.retryPolicy);
          await new Promise((res) => setTimeout(res, delay));
        }
      }
      throw lastErr;
    };

    // Apply middleware (in registration order for request, reverse for response)
    let handler = base;
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i]!;
      const next = handler;
      handler = (r: Request) => mw(r, next);
    }

    return handler(req);
  }

  async *stream(req: Request): AsyncGenerator<StreamEvent> {
    const adapter = this.resolveProvider(req);
    yield* adapter.stream(req);
  }

  addMiddleware(mw: Middleware): void {
    this.middleware.push(mw);
  }
}

// Module-level default client (lazy-initialized)
let _defaultClient: Client | null = null;

export function getDefaultClient(): Client {
  if (!_defaultClient) {
    _defaultClient = Client.fromEnv();
  }
  return _defaultClient;
}

export function setDefaultClient(client: Client): void {
  _defaultClient = client;
}
