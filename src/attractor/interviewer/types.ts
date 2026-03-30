// Human-in-the-Loop: Interviewer types - Section 6

export type QuestionType = "YES_NO" | "MULTIPLE_CHOICE" | "FREEFORM" | "CONFIRMATION";

export interface Option {
  key: string;
  label: string;
}

export interface Question {
  text: string;
  type: QuestionType;
  options?: Option[];
  default?: Answer;
  timeoutSeconds?: number;
  stage?: string;
  metadata?: Record<string, unknown>;
}

export type AnswerValue = "YES" | "NO" | "SKIPPED" | "TIMEOUT";

export interface Answer {
  value: AnswerValue | string;
  selectedOption?: Option;
  text?: string;
}

export namespace Answer {
  export function yes(): Answer {
    return { value: "YES" };
  }
  export function no(): Answer {
    return { value: "NO" };
  }
  export function skipped(): Answer {
    return { value: "SKIPPED" };
  }
  export function timeout(): Answer {
    return { value: "TIMEOUT" };
  }
  export function option(opt: Option): Answer {
    return { value: opt.key, selectedOption: opt };
  }
  export function text(t: string): Answer {
    return { value: t, text: t };
  }
}

export interface Interviewer {
  ask(question: Question): Promise<Answer>;
  askMultiple?(questions: Question[]): Promise<Answer[]>;
  inform?(message: string, stage?: string): Promise<void>;
}

// Accelerator key parsing from edge labels
// Patterns: [K] Label, K) Label, K - Label, first char
export function parseAcceleratorKey(label: string): string {
  // [K] Label
  const bracketMatch = label.match(/^\[([A-Za-z0-9])\]\s*/);
  if (bracketMatch) return bracketMatch[1]!.toUpperCase();

  // K) Label
  const parenMatch = label.match(/^([A-Za-z0-9])\)\s+/);
  if (parenMatch) return parenMatch[1]!.toUpperCase();

  // K - Label
  const dashMatch = label.match(/^([A-Za-z0-9])\s*-\s+/);
  if (dashMatch) return dashMatch[1]!.toUpperCase();

  // First character
  return label.charAt(0).toUpperCase();
}

// Normalize label for matching
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/^\[[a-z0-9]\]\s*/i, "")
    .replace(/^[a-z0-9]\)\s+/i, "")
    .replace(/^[a-z0-9]\s*-\s+/i, "");
}
