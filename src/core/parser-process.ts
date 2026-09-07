import { fork, type ChildProcess } from "node:child_process";

interface Request {
  id: number;
  operation: "parse" | "validate";
  content: string;
  ext: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One bounded, reusable parser process per server. No source is written to disk. */
export class IsolatedParser {
  private child: ChildProcess | null = null;
  private active: Request | null = null;
  private queue: Request[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextId = 0;
  private retryAfter = 0;
  private closed = false;

  constructor(private options: { worker?: URL; timeoutMs?: number; cooldownMs?: number } = {}) {}

  request(operation: "parse" | "validate", content: string, ext: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Parser process is closed."));
    if (Date.now() < this.retryAfter) return Promise.reject(new Error("Parser is recovering; structural fallback is available. Retry syntax validation shortly."));
    if (Buffer.byteLength(content) > 8_000_000 || this.queue.length >= 128) return Promise.reject(new Error("Parser request exceeds source or queue capacity."));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, operation, content, ext, resolve, reject });
      this.dispatch();
    });
  }

  close(): void {
    this.closed = true;
    this.fail(new Error("Parser process closed."), false);
  }

  private fail(error: Error, warn = true): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
    this.active?.reject(error);
    this.active = null;
    for (const request of this.queue.splice(0)) request.reject(error);
    this.retryAfter = Date.now() + (this.options.cooldownMs ?? 5000);
    if (warn) process.stderr.write(`[contextpro/parser] ${error.message}; MCP remains available; structural reads can fall back.\n`);
  }

  private dispatch(): void {
    if (this.active || !this.queue.length || this.closed) return;
    try {
      if (!this.child) {
        // Configure before V8 starts. Liftoff avoids the optimizing WASM compiler
        // implicated in the crash; isolation contains fatal failures regardless.
        const child = fork(this.options.worker ?? new URL("./parser-worker.js", import.meta.url), [], {
          execArgv: ["--liftoff-only", "--no-wasm-tier-up", "--max-old-space-size=512"],
          stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "advanced",
        });
        this.child = child;
        child.on("error", error => { if (this.child === child) this.fail(error); });
        child.on("exit", (code, signal) => {
          if (this.child === child) this.fail(new Error(`Parser worker exited (${signal ?? code})`));
        });
        child.on("message", (message: unknown) => {
          if (this.child !== child || !message || typeof message !== "object") return;
          const value = message as { id?: number; result?: unknown; error?: string };
          if (!this.active || value.id !== this.active.id) return;
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          const request = this.active!;
          this.active = null;
          if (value.error) request.reject(new Error(value.error));
          else request.resolve(value.result);
          if (this.queue.length) this.dispatch();
          else { child.unref(); child.channel?.unref(); }
        });
      }
      const request = this.queue.shift()!;
      this.active = request;
      const child = this.child;
      child.ref(); child.channel?.ref();
      this.timer = setTimeout(() => this.fail(new Error("Parser request timed out")), this.options.timeoutMs ?? 15000);
      child.send({ id: request.id, operation: request.operation, content: request.content, ext: request.ext }, error => {
        if (error && this.child === child) this.fail(error);
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
}
