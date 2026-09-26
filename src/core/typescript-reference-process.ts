import { fork, type ChildProcess } from "node:child_process";
import type { findTypeScriptReferences } from "./typescript-references.js";

type Input = Parameters<typeof findTypeScriptReferences>[0];
type Result = ReturnType<typeof findTypeScriptReferences>;
interface Pending { id: number; input: Input; resolve: (value: Result) => void; reject: (error: Error) => void }
// Full compiler graphs for ordinary monorepos exceed 512 MB even when projects
// are disposed sequentially. This is a ceiling, not an up-front allocation.
const DEFAULT_HEAP_MB = 1024;

/** Compiler work cannot block MCP heartbeats or take down the stdio process. */
export class TypeScriptReferenceProcess {
  private child: ChildProcess | undefined;
  private active: Pending | undefined;
  private queue: Pending[] = [];
  private deadline: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout | undefined;
  private sequence = 0;
  constructor(private options: { worker?: URL; timeoutMs?: number; idleMs?: number; heapMb?: number } = {}) {}

  query(input: Input): Promise<Result> {
    if (this.queue.length >= 16 || input.files.length > 20_000) return Promise.reject(new Error("Reference lookup exceeds queue or file capacity; narrow the workspace."));
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.sequence, input, resolve, reject }); this.dispatch(); });
  }

  close(): void { this.fail(new Error("Reference worker closed.")); }

  private fail(error: Error): void {
    clearTimeout(this.deadline); clearTimeout(this.idle);
    const child = this.child; this.child = undefined;
    child?.kill("SIGKILL");
    this.active?.reject(error); this.active = undefined;
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }

  private dispatch(): void {
    if (this.active || !this.queue.length) return;
    clearTimeout(this.idle);
    try {
      if (!this.child) {
        const configured = this.options.heapMb ?? Number(process.env.CONTEXTPRO_REFERENCE_HEAP_MB ?? DEFAULT_HEAP_MB);
        const heapMb = Number.isInteger(configured) && configured >= 256 && configured <= 4096 ? configured : DEFAULT_HEAP_MB;
        let stderrTail = "";
        let outOfMemory = false;
        const child = fork(this.options.worker ?? new URL("./typescript-reference-worker.js", import.meta.url), [], {
          execArgv: [`--max-old-space-size=${heapMb}`, "--expose-gc"], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
        });
        this.child = child;
        child.stderr?.on("data", chunk => {
          stderrTail = (stderrTail + String(chunk)).slice(-8192);
          outOfMemory ||= /heap out of memory|allocation failed|reached heap limit/i.test(stderrTail);
        });
        // Captured diagnostics must not keep an otherwise idle MCP/test process
        // alive. Active requests are held by the child and deadline timer.
        (child.stderr as typeof child.stderr & { unref?: () => void })?.unref?.();
        child.on("error", error => { if (this.child === child) this.fail(error); });
        // close follows stderr drain, so an OOM report cannot race the exit event.
        child.on("close", (code, signal) => {
          if (this.child !== child) return;
          this.fail(new Error(outOfMemory
            ? `Reference worker exhausted its ${heapMb} MB JavaScript heap; no reference result is available. Set CONTEXTPRO_REFERENCE_HEAP_MB (256–4096) to a larger limit and restart the MCP host, or use native references.`
            : `Reference worker exited (${signal ?? code}); retry or use native references.`));
        });
        child.on("message", (message: { id?: number; result?: Result; error?: string }) => {
          if (this.child !== child || !this.active || message?.id !== this.active.id) return;
          clearTimeout(this.deadline);
          const pending = this.active; this.active = undefined;
          if (message.error) pending.reject(new Error(message.error));
          else if (message.result) pending.resolve(message.result);
          else pending.reject(new Error("Reference worker returned no result."));
          if (this.queue.length) this.dispatch();
          else {
            child.unref(); child.channel?.unref();
            this.idle = setTimeout(() => { if (this.child === child && !this.active) this.close(); }, this.options.idleMs ?? 60_000);
            this.idle.unref();
          }
        });
      }
      const pending = this.queue.shift()!; this.active = pending;
      const child = this.child;
      child.ref(); child.channel?.ref();
      this.deadline = setTimeout(() => this.fail(new Error("Reference analysis exceeded its time limit; narrow the workspace or retry.")), this.options.timeoutMs ?? 30_000);
      child.send({ id: pending.id, input: pending.input }, error => { if (error && this.child === child) this.fail(error); });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
}

const referenceProcess = new TypeScriptReferenceProcess();
export const queryTypeScriptReferences = (input: Input): Promise<Result> => referenceProcess.query(input);
export const closeTypeScriptReferenceProcess = (): void => referenceProcess.close();
