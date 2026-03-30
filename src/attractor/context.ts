// Context, Checkpoint, and ArtifactStore - Section 5

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const FILE_BACKING_THRESHOLD = 100 * 1024; // 100KB

export class Context {
  private values: Map<string, unknown> = new Map();
  private logs: string[] = [];

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  get(key: string, defaultValue?: unknown): unknown {
    const val = this.values.get(key);
    if (val === undefined) return defaultValue;
    return val;
  }

  getString(key: string, defaultValue = ""): string {
    const val = this.values.get(key);
    if (val == null) return defaultValue;
    return String(val);
  }

  getNumber(key: string, defaultValue = 0): number {
    const val = this.values.get(key);
    if (val == null) return defaultValue;
    return Number(val);
  }

  appendLog(entry: string): void {
    this.logs.push(entry);
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.values) {
      result[k] = v;
    }
    return result;
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  clone(): Context {
    const c = new Context();
    for (const [k, v] of this.values) {
      c.values.set(k, v);
    }
    c.logs.push(...this.logs);
    return c;
  }

  applyUpdates(updates: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(updates)) {
      this.values.set(k, v);
    }
  }

  keys(): string[] {
    return Array.from(this.values.keys());
  }
}

export interface CheckpointData {
  timestamp: string;
  currentNode: string;
  completedNodes: string[];
  nodeRetries: Record<string, number>;
  context: Record<string, unknown>;
  logs: string[];
}

export class Checkpoint {
  timestamp: Date;
  currentNode: string;
  completedNodes: string[];
  nodeRetries: Map<string, number>;
  context: Context;

  constructor(opts: {
    currentNode?: string;
    completedNodes?: string[];
    nodeRetries?: Map<string, number>;
    context?: Context;
  } = {}) {
    this.timestamp = new Date();
    this.currentNode = opts.currentNode ?? "";
    this.completedNodes = opts.completedNodes ? [...opts.completedNodes] : [];
    this.nodeRetries = opts.nodeRetries ? new Map(opts.nodeRetries) : new Map();
    this.context = opts.context ?? new Context();
  }

  async save(logsRoot: string): Promise<void> {
    const data: CheckpointData = {
      timestamp: this.timestamp.toISOString(),
      currentNode: this.currentNode,
      completedNodes: this.completedNodes,
      nodeRetries: Object.fromEntries(this.nodeRetries),
      context: this.context.snapshot(),
      logs: this.context.getLogs(),
    };
    await mkdir(logsRoot, { recursive: true });
    await writeFile(
      join(logsRoot, "checkpoint.json"),
      JSON.stringify(data, null, 2)
    );
  }

  static async load(logsRoot: string): Promise<Checkpoint | null> {
    const path = join(logsRoot, "checkpoint.json");
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, "utf-8");
      const data: CheckpointData = JSON.parse(raw);
      const ctx = new Context();
      ctx.applyUpdates(data.context);
      for (const log of data.logs ?? []) {
        ctx.appendLog(log);
      }
      const cp = new Checkpoint({
        currentNode: data.currentNode,
        completedNodes: data.completedNodes,
        nodeRetries: new Map(Object.entries(data.nodeRetries).map(([k, v]) => [k, v])),
        context: ctx,
      });
      cp.timestamp = new Date(data.timestamp);
      return cp;
    } catch {
      return null;
    }
  }
}

export interface ArtifactInfo {
  id: string;
  name: string;
  sizeBytes: number;
  storedAt: Date;
  isFileBacked: boolean;
}

export class ArtifactStore {
  private artifacts: Map<string, { info: ArtifactInfo; data: unknown }> = new Map();
  private baseDir?: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir;
  }

  async store(artifactId: string, name: string, data: unknown): Promise<ArtifactInfo> {
    const serialized = JSON.stringify(data);
    const size = Buffer.byteLength(serialized);
    const isFileBacked = size > FILE_BACKING_THRESHOLD && !!this.baseDir;

    let storedData: unknown = data;
    if (isFileBacked && this.baseDir) {
      const artifactsDir = join(this.baseDir, "artifacts");
      await mkdir(artifactsDir, { recursive: true });
      const filePath = join(artifactsDir, `${artifactId}.json`);
      await writeFile(filePath, serialized);
      storedData = filePath;
    }

    const info: ArtifactInfo = {
      id: artifactId,
      name,
      sizeBytes: size,
      storedAt: new Date(),
      isFileBacked,
    };

    this.artifacts.set(artifactId, { info, data: storedData });
    return info;
  }

  async retrieve(artifactId: string): Promise<unknown> {
    const entry = this.artifacts.get(artifactId);
    if (!entry) throw new Error(`Artifact not found: ${artifactId}`);
    if (entry.info.isFileBacked && typeof entry.data === "string") {
      const raw = await readFile(entry.data, "utf-8");
      return JSON.parse(raw);
    }
    return entry.data;
  }

  has(artifactId: string): boolean {
    return this.artifacts.has(artifactId);
  }

  list(): ArtifactInfo[] {
    return Array.from(this.artifacts.values()).map((e) => e.info);
  }

  remove(artifactId: string): void {
    this.artifacts.delete(artifactId);
  }

  clear(): void {
    this.artifacts.clear();
  }
}
