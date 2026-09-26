// A snapshot contains exactly what was delivered, not the unreturned candidate
// pool. Omitted repository evidence is explicit and is not a delivery truncation.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { persistArtifact, readArtifact, buildArtifactId } from "./artifacts.js";
import type { ContextOptions, SourceEvidence, Excerpt } from "../tools/context.js";

interface Snapshot { taskKey: string; packet: SourceEvidence; complete: boolean }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const rangeId = (part: Excerpt) => `${part.file}:${part.start}-${part.end}`;
const render = (part: Excerpt) => `${rangeId(part)}\n${part.text}`;

export async function finishSourceContext(options: ContextOptions, packet: SourceEvidence): Promise<string> {
  const root = resolve(options.rootDir), limit = (options.maxTokens ?? 4000) * 4;
  if (options.previousContextId && !/^source_context-[a-f0-9]{14}$/.test(options.previousContextId)) throw new Error("Invalid previous_context_id; use a source_context ID from a context response.");
  const taskKey = hash({ root, query: options.query?.trim(), settings: packet.settings, budget: options.maxTokens ?? 4000 });
  let key = hash({ root, taskKey, packet, complete: packet.complete });
  let id = buildArtifactId("source_context", key);
  const recovery = "Omit previous_context_id after context loss; artifact_read recovers this snapshot.";
  let header = `Context ID: ${id}\n${recovery}`;
  let text = `${header}\n\n${packet.text}`;
  let fallback = "";
  const previous = options.previousContextId ? await readArtifact<Snapshot>(root, options.previousContextId).catch(() => null) : null;
  if (options.previousContextId) {
    const priorPacket = previous?.payload?.packet;
    const valid = previous?.kind === "source_context" && previous.repoRoot === root && previous.payload?.taskKey === taskKey && previous.payload.complete === true
      && Array.isArray(priorPacket?.ranges) && !!priorPacket.hashes && typeof priorPacket.hashes === "object"
      && priorPacket.ranges.every(part => part && typeof part.file === "string" && typeof part.text === "string" && Number.isInteger(part.start) && Number.isInteger(part.end))
      && buildArtifactId("source_context", hash({ root, taskKey, packet: priorPacket, complete: previous.payload.complete })) === options.previousContextId;
    if (valid) {
      const before = new Map(previous.payload.packet.ranges.map(part => [rangeId(part), part]));
      const after = new Map(packet.ranges.map(part => [rangeId(part), part]));
      const added = packet.ranges.filter(part => !before.has(rangeId(part)));
      const changed = packet.ranges.filter(part => before.has(rangeId(part)) && (before.get(rangeId(part))!.text !== part.text || previous.payload.packet.hashes[part.file] !== packet.hashes[part.file]));
      const removed = [...before.keys()].filter(key => !after.has(key));
      const delta = [header, `Delta from: ${options.previousContextId}`,
        !added.length && !changed.length && !removed.length ? "Source ranges unchanged." : "",
        ...added.map(part => `Added: ${render(part)}`), ...changed.map(part => `Changed: ${render(part)}`),
        ...removed.map(key => `Removed: ${key}`), ...packet.notices].filter(Boolean).join("\n\n");
      if (bytes(delta) <= limit) text = delta;
      else fallback = "Delta over budget; returning full context.";
    } else fallback = "Baseline missing, incompatible or incomplete; returning full context.";
  }
  if (fallback) text = `${header}\n${fallback}\n\n${packet.text}`;
  // Never cut source or a context ID in the middle. A delivery that cannot fit
  // cannot become a trusted baseline, even if a transport later returns its ID.
  let complete = packet.complete;
  if (bytes(text) > limit) {
    complete = false;
    const ranges = [...packet.ranges];
    const output = () => [header, fallback, "Source evidence:", ...ranges.map(render), "Omitted: response budget; use narrower query/targets.", ...packet.notices.slice(0, 1)].filter(Boolean).join("\n\n");
    text = output();
    while (ranges.length && bytes(text) > limit) { ranges.pop(); text = output(); }
    if (bytes(text) > limit) text = `${header}\nOmitted: response budget; use narrower query/targets.`;
  }
  const deliveredKey = hash({ root, taskKey, packet, complete });
  if (deliveredKey !== key) {
    key = deliveredKey; id = buildArtifactId("source_context", key);
    const deliveredHeader = `Context ID: ${id}\n${recovery}`;
    text = text.replace(header, deliveredHeader); header = deliveredHeader;
  }
  try {
    const snapshot: Snapshot = { taskKey, packet, complete };
    const stored = await readArtifact<Snapshot>(root, id).catch(() => null);
    // Identical snapshots stay immutable. Repair a corrupt record under the same
    // content ID so artifact_read cannot return different evidence for that ID.
    const immutable = !stored || (stored.repoRoot === root && stored.kind === "source_context" && hash(stored.payload) === hash(snapshot));
    await persistArtifact({ rootDir: root, kind: "source_context", key, immutable, payload: snapshot });
  } catch {
    // Source retrieval remains useful when cache storage is unavailable. Do not
    // advertise an unrecoverable ID as if it had been persisted successfully.
    text = text.replace(header, "Context reuse unavailable; cache could not be persisted.");
  }
  return text;
}
