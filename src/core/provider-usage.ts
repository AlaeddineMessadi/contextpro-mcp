// Provider-reported counts only. Missing fields remain null, never estimates.
import { AsyncLocalStorage } from "node:async_hooks";
import { openSync, closeSync, constants, fstatSync, lstatSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ProviderUsage {
  kind: "embedding" | "chat"; provider: string; model: string;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  durationMs: number; status: "ok" | "error"; startedAt: number;
}
const current = new AsyncLocalStorage<ProviderUsage[]>();
export async function withProviderUsage<T>(fn: () => Promise<T>): Promise<{ value: T; usage: ProviderUsage[] }> {
  const usage: ProviderUsage[] = [];
  return current.run(usage, async () => ({ value: await fn(), usage }));
}
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export async function observeProviderCall<T>(identity: Pick<ProviderUsage, "kind" | "provider" | "model">, run: () => Promise<T>, extract: (result: T) => { input?: unknown; output?: unknown; cached?: unknown }): Promise<T> {
  const startedAt = Date.now(), start = performance.now();
  let status: ProviderUsage["status"] = "error", counts: ReturnType<typeof extract> = {};
  try { const result = await run(); status = "ok"; counts = extract(result); return result; }
  finally {
    const event: ProviderUsage = { ...identity, inputTokens: count(counts.input), outputTokens: count(counts.output), cachedInputTokens: count(counts.cached), startedAt, durationMs: performance.now() - start, status };
    current.getStore()?.push(event);
    const path = process.env.CONTEXTPRO_PROVIDER_TRACE_PATH;
    if (path) {
      let fd: number | undefined;
      try {
        if (!isAbsolute(path)) throw new Error("absolute trace path required");
        const existing = lstatSync(path, { throwIfNoEntry: false });
        if (existing && !existing.isFile()) throw new Error("regular trace file required");
        // Recheck the descriptor below. Nonblocking open also closes the race
        // where a regular path becomes a FIFO after the preflight check.
        fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const stat = fstatSync(fd), line = JSON.stringify(event) + "\n";
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size + Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("invalid trace destination");
        writeSync(fd, line);
      } catch { /* diagnostics must not break retrieval */ }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
    }
  }
}
