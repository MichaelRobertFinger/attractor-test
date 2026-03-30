// Agent-based CodergenBackend - bridges the Attractor pipeline with the coding agent loop

import type { CodergenBackend } from "../handlers/codergen.ts";
import type { Node, Outcome } from "../types.ts";
import type { Context } from "../context.ts";
import type { Session, ProviderProfile } from "../../agent/session.ts";
import { LocalExecutionEnvironment } from "../../agent/environment.ts";
import { Client, getDefaultClient } from "../../llm/client.ts";

export interface AgentBackendOptions {
  profile?: ProviderProfile;
  workingDir?: string;
  client?: Client;
  sessionFactory?: () => Session;
}

export class AgentCodergenBackend implements CodergenBackend {
  private opts: AgentBackendOptions;

  constructor(opts: AgentBackendOptions = {}) {
    this.opts = opts;
  }

  async run(node: Node, prompt: string, context: Context): Promise<string | Outcome> {
    const { Session } = await import("../../agent/session.ts");
    const { createAnthropicProfile } = await import("../../agent/profiles/anthropic.ts");

    const profile = this.opts.profile ?? createAnthropicProfile(
      node.attrs.llmModel as string | undefined ?? "claude-sonnet-4-6"
    );

    const env = new LocalExecutionEnvironment(this.opts.workingDir ?? process.cwd());
    const client = this.opts.client ?? getDefaultClient();

    const session = this.opts.sessionFactory?.() ?? new Session(
      profile,
      env,
      { maxToolRoundsPerInput: 50 },
      client
    );

    try {
      const response = await session.submit(prompt);
      return response;
    } finally {
      session.close();
    }
  }
}

// Simple LLM backend (direct API call, no tool loop)
export class SimpleLLMBackend implements CodergenBackend {
  private model: string;
  private client: Client;

  constructor(model?: string, client?: Client) {
    this.model = model ?? "claude-sonnet-4-6";
    this.client = client ?? getDefaultClient();
  }

  async run(node: Node, prompt: string, _context: Context): Promise<string> {
    const response = await this.client.complete({
      model: node.attrs.llmModel as string | undefined ?? this.model,
      messages: [
        { role: "user", content: [{ kind: "text", text: prompt }] },
      ],
      maxTokens: 8192,
      reasoningEffort: node.attrs.reasoningEffort,
    });

    const { Response } = await import("../../llm/types.ts");
    return Response.getText(response);
  }
}
