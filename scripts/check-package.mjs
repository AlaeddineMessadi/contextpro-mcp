import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function checkPackageFiles(files) {
  const names = files.map((file) => file.path);
  for (const required of ["package.json", "build/index.js", "LICENSE", "NOTICE", "README.md", "INSTALL.md", "SECURITY.md", "agent-instructions.md", "agent-guide.md"]) {
    if (!names.includes(required)) throw new Error(`Missing package file: ${required}`);
  }
  const forbidden = /(^|\/)(?:node_modules|\.contextpro|\.git|\.github|\.env(?:\..*)?|landing|dashboard|test|archive|benchmarks)(\/|$)|\.(?:db|sqlite|jsonl|log)$/;
  for (const name of names) {
    if (forbidden.test(name)) throw new Error(`Private, generated or development data in package: ${name}`);
  }
  return names.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const supplied = process.argv[2];
  const records = supplied
    ? JSON.parse(readFileSync(supplied, "utf8"))
    : JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" }));
  if (records.length !== 1 || records[0].name !== "contextpro-mcp") throw new Error("Expected one ContextPro package.");
  console.log(`Package contents OK: ${checkPackageFiles(records[0].files)} files, ${records[0].size} packed bytes.`);
}
