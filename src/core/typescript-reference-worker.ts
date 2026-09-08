import { findTypeScriptReferences } from "./typescript-references.js";

process.on("disconnect", () => process.exit(0));
process.on("message", (message: { id: number; input: Parameters<typeof findTypeScriptReferences>[0] }) => {
  try {
    const result = findTypeScriptReferences(message.input);
    if (process.connected) process.send?.({ id: message.id, result });
  } catch (error) {
    if (process.connected) process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
