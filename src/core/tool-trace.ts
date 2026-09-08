// Opt-in local benchmark evidence. Never add trace metadata to MCP responses.
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runtimeSessionId } from "./runtime-session.js";

interface TracePhases { handlerStarted(): void; handlerFinished(): void }
const disabled: TracePhases = { handlerStarted() {}, handlerFinished() {} };
let warned = false;

function boundedArguments(args: unknown): unknown {
  const text = JSON.stringify(args, (key, value) =>
    /password|secret|authorization|credential|api.?key|token$|new_content|content$/i.test(key) ? "[redacted]" : value) ?? "null";
  if (Buffer.byteLength(text) <= 8192) return JSON.parse(text);
  return { omitted: true, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

export async function withToolTrace<T>(tool: string, args: unknown, operation: (phases: TracePhases) => Promise<T>): Promise<T> {
  const path = process.env.CONTEXTPRO_TOOL_TRACE_PATH;
  if (!path) return operation(disabled);
  const startedAt = Date.now();
  const started = performance.now();
  let handlerStart: number | undefined, handlerEnd: number | undefined;
  let status: "ok" | "error" = "error";
  try {
    const result = await operation({
      handlerStarted: () => { handlerStart = performance.now(); },
      handlerFinished: () => { handlerEnd = performance.now(); },
    });
    status = result && typeof result === "object" && "isError" in result && result.isError ? "error" : "ok";
    return result;
  } finally {
    const ended = performance.now();
    let fd: number | undefined;
    try {
      if (!isAbsolute(path)) throw new Error("trace path must be absolute");
      const event = { version: 1, sessionId: runtimeSessionId, requestId: randomUUID(), tool, arguments: boundedArguments(args), status,
        startedAt, endedAt: startedAt + ended - started, durationMs: ended - started,
        preparationMs: (handlerStart ?? ended) - started,
        handlerMs: handlerStart === undefined ? null : (handlerEnd ?? ended) - handlerStart,
        postprocessingMs: handlerEnd === undefined ? null : ended - handlerEnd };
      const line = JSON.stringify(event) + "\n";
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("trace destination must be a private regular file");
      if (stat.size + Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("trace exceeded 64 MiB");
      writeSync(fd, line);
    } catch {
      if (!warned) { warned = true; process.stderr.write("[contextpro/trace] Cannot write benchmark trace; check the absolute path, private file permissions and 64 MiB limit.\n"); }
    } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Telemetry must not affect the result. */ } } }
  }
}
