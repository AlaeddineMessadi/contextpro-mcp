import { parseWithTreeSitter, validateSyntax } from "./tree-sitter-runtime.js";

process.on("disconnect", () => process.exit(0));
process.on("message", async (message: { id: number; operation: string; content: string; ext: string }) => {
  try {
    const result = message.operation === "parse"
      ? await parseWithTreeSitter(message.content, message.ext)
      : message.operation === "validate" ? await validateSyntax(message.content, message.ext)
      : null;
    if (process.connected) process.send?.({ id: message.id, result });
  } catch (error) {
    if (process.connected) process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
