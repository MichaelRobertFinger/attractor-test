// Interviewer implementations - Section 6.4

import type { Interviewer, Question, Answer } from "./types.ts";
import { Answer as AnswerNS } from "./types.ts";
import * as readline from "node:readline";

// AutoApproveInterviewer: always selects YES / first option
export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.type === "YES_NO" || question.type === "CONFIRMATION") {
      return AnswerNS.yes();
    }
    if (question.type === "MULTIPLE_CHOICE" && question.options?.length) {
      const opt = question.options[0]!;
      return AnswerNS.option(opt);
    }
    return { value: "auto-approved", text: "auto-approved" };
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  async inform(_message: string, _stage?: string): Promise<void> {
    // no-op
  }
}

// ConsoleInterviewer: reads from stdin
export class ConsoleInterviewer implements Interviewer {
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  private prompt(text: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(text, (answer) => {
        resolve(answer);
      });
    });
  }

  async ask(question: Question): Promise<Answer> {
    console.log(`\n[?] ${question.text}`);

    if (question.type === "MULTIPLE_CHOICE" && question.options) {
      for (const opt of question.options) {
        console.log(`  [${opt.key}] ${opt.label}`);
      }
      const response = await this.prompt("Select: ");
      const key = response.trim().toUpperCase();
      const selected = question.options.find(
        (o) => o.key.toUpperCase() === key || o.label.toLowerCase() === response.trim().toLowerCase()
      );
      if (selected) {
        return AnswerNS.option(selected);
      }
      // Fallback to first
      return AnswerNS.option(question.options[0]!);
    }

    if (question.type === "YES_NO" || question.type === "CONFIRMATION") {
      const response = await this.prompt("[Y/N]: ");
      return response.trim().toLowerCase().startsWith("y")
        ? AnswerNS.yes()
        : AnswerNS.no();
    }

    if (question.type === "FREEFORM") {
      const response = await this.prompt("> ");
      return AnswerNS.text(response.trim());
    }

    return AnswerNS.skipped();
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const q of questions) {
      answers.push(await this.ask(q));
    }
    return answers;
  }

  async inform(message: string, stage?: string): Promise<void> {
    const prefix = stage ? `[${stage}] ` : "";
    console.log(`${prefix}${message}`);
  }

  close(): void {
    this.rl.close();
  }
}

// CallbackInterviewer: delegates to a provided function
export class CallbackInterviewer implements Interviewer {
  constructor(private callback: (question: Question) => Promise<Answer> | Answer) {}

  async ask(question: Question): Promise<Answer> {
    return this.callback(question);
  }

  async inform(_message: string, _stage?: string): Promise<void> {}
}

// QueueInterviewer: reads from a pre-filled answer queue
export class QueueInterviewer implements Interviewer {
  private queue: Answer[];

  constructor(answers: Answer[] = []) {
    this.queue = [...answers];
  }

  async ask(_question: Question): Promise<Answer> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return AnswerNS.skipped();
  }

  enqueue(answer: Answer): void {
    this.queue.push(answer);
  }

  async inform(_message: string, _stage?: string): Promise<void> {}
}

// RecordingInterviewer: wraps another and records Q&A pairs
export class RecordingInterviewer implements Interviewer {
  recordings: Array<{ question: Question; answer: Answer }> = [];

  constructor(private inner: Interviewer) {}

  async ask(question: Question): Promise<Answer> {
    const answer = await this.inner.ask(question);
    this.recordings.push({ question, answer });
    return answer;
  }

  async inform(message: string, stage?: string): Promise<void> {
    await this.inner.inform?.(message, stage);
  }
}
