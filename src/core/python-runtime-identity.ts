// Configured Pyright installation identity, shared without starting a server.
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, delimiter, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const executableHashes = new Map<string, { stamp: string; hash: string }>();
/** Content/version identity also used in shared-service compatibility checks. */
export async function pythonRuntimeIdentity(): Promise<string> {
  const command = process.env.CONTEXTPRO_PYRIGHT_COMMAND;
  if (!command) return "unconfigured";
  let executable: string | undefined;
  for (const candidate of isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).map(path => join(path, command))) {
    try { executable = await realpath(candidate); break; } catch { /* Try the next executable directory. */ }
  }
  if (!executable) throw new Error("Configured Pyright executable is unavailable.");
  const hash = createHash("sha256").update(executable);
  const include = async (path: string) => {
    const info = await stat(path);
    const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    let entry = executableHashes.get(path);
    if (entry?.stamp !== stamp) {
      entry = { stamp, hash: createHash("sha256").update(await readFile(path)).digest("hex") };
      if (executableHashes.size >= 16) executableHashes.clear();
      executableHashes.set(path, entry);
    }
    hash.update(path).update(entry.hash);
  };
  await include(executable);
  // npm/pnpm launchers resolve into Pyright's package. Hash its version and
  // bundled server, so an in-place upgrade cannot reuse the old process.
  for (let folder = dirname(executable), depth = 0; depth < 6; depth++) {
    const manifest = join(folder, "package.json");
    const metadata = await readFile(manifest, "utf8").then(text => JSON.parse(text), () => null);
    if (metadata?.name === "pyright") {
      await include(manifest);
      await include(join(folder, "dist", "pyright-langserver.js"));
      await include(join(folder, "dist", "pyright-internal.js"));
      break;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return hash.digest("hex");
}
