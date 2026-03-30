// Event system - Section 9.6

import type { Outcome } from "./types.ts";

export type PipelineEventKind =
  | "pipeline_started"
  | "pipeline_completed"
  | "pipeline_failed"
  | "stage_started"
  | "stage_completed"
  | "stage_failed"
  | "stage_retrying"
  | "parallel_started"
  | "parallel_branch_started"
  | "parallel_branch_completed"
  | "parallel_completed"
  | "interview_started"
  | "interview_completed"
  | "interview_timeout"
  | "checkpoint_saved"
  | "loop_restart";

export interface PipelineEvent {
  kind: PipelineEventKind;
  timestamp: Date;
  [key: string]: unknown;
}

export type EventHandler = (event: PipelineEvent) => void;

export class EventEmitter {
  private handlers: EventHandler[] = [];

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(kind: PipelineEventKind, data: Record<string, unknown> = {}): void {
    const event: PipelineEvent = { kind, timestamp: new Date(), ...data };
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Don't let event handlers crash the pipeline
      }
    }
  }
}
