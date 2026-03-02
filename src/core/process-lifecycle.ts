// Process lifecycle helpers for resilient MCP stdio shutdown behavior handling
// FEATURE: Runtime process lifecycle and broken-pipe detection utilities

interface ErrorWithCode {
  code?: string;
}

const BROKEN_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET"]);

export interface CleanupOptions {
  stopTracker: () => void;
  closeServer: () => Promise<void> | void;
  closeTransport: () => Promise<void> | void;
}

export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code } = error as ErrorWithCode;
  return typeof code === "string" && BROKEN_PIPE_CODES.has(code);
}

export async function runCleanup(options: CleanupOptions): Promise<void> {
  options.stopTracker();
  await Promise.allSettled([
    Promise.resolve(options.closeServer()),
    Promise.resolve(options.closeTransport()),
  ]);
}
