import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["README.md", "INSTALL.md", "INSTRUCTIONS.md", "STATUS.md", "TODO.md", "agent-guide.md", "AGENTS.md", "CLAUDE.md", "landing/README.md", "dashboard/README.md"];
async function collect(dir) {
  for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && path !== "docs/archive") await collect(path);
    else if (entry.isFile() && path.endsWith(".md")) files.push(path);
  }
}
await collect("docs");
// Archived prose preserves original relative paths; validate its maintained index.
files.push("docs/archive/README.md");
const failures = [];
const cache = new Map();
async function read(path) {
  if (!cache.has(path)) cache.set(path, await readFile(path, "utf8"));
  return cache.get(path);
}
function withoutCode(text) { return text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, ""); }
function anchors(text) {
  const used = new Map();
  return [...withoutCode(text).matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => {
    const base = heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  });
}
for (const file of files) {
  const absolute = resolve(root, file);
  const text = withoutCode(await read(absolute));
  for (const [, raw] of text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = raw.replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("//")) continue;
    const [path, fragment] = link.split("#");
    const target = path ? resolve(dirname(absolute), decodeURIComponent(path.split("?")[0])) : absolute;
    try {
      await stat(target);
      if (fragment && extname(target) === ".md" && !anchors(await read(target)).includes(decodeURIComponent(fragment))) {
        failures.push(`${file}: missing anchor ${link}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      failures.push(`${file}: missing target ${link} (${relative(root, target)})`);
    }
  }
}
try {
  execFileSync(process.execPath, [resolve(root, "scripts/sync-agent-instructions.mjs"), "--check"], { stdio: "inherit" });
} catch { failures.push("Generated website instructions do not match INSTRUCTIONS.md."); }
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} current documentation files and generated website instructions.`);
