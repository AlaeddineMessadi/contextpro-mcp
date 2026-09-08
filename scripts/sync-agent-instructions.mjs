import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../INSTRUCTIONS.md", import.meta.url);
const target = new URL("../landing/src/generated/agent-instructions.json", import.meta.url);
const expected = JSON.stringify(await readFile(source, "utf8"), null, 2) + "\n";
let current;
try { current = await readFile(target, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }

if (process.argv.includes("--check")) {
  if (current !== expected) {
    console.error("Website instructions are stale. Run npm run docs:sync.");
    process.exitCode = 1;
  }
} else if (current !== expected) {
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, expected);
  console.log(`Updated ${fileURLToPath(target)}`);
}
