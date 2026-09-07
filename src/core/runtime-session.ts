// One identity per MCP process; separate concurrently active agents in shared history.
import { randomUUID } from "node:crypto";

export const runtimeSessionId = randomUUID();
export const runtimeSessionStartedAt = Date.now();
let toolSchemaTokens = 0;
export function setToolSchemaTokens(tokens: number): void {
  toolSchemaTokens = Math.max(0, Math.ceil(tokens));
}
export function getToolSchemaTokens(): number { return toolSchemaTokens; }
