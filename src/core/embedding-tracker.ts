// File-system index tracker for realtime refresh on source changes
// FEATURE: Incremental structural + embedding updates for changed files so the
// symbol/import/call-site graph and semantic vectors stay current as agents edit.

import { watch, type FSWatcher } from "fs";
import { refreshFilesStructural } from "../tools/reindex.js";

export interface EmbeddingTrackerOptions {
  rootDir: string;
  debounceMs?: number;
  maxFilesPerTick?: number;
}

export interface EmbeddingTrackerController {
  ensureStarted: () => void;
  stop: () => void;
  isRunning: () => boolean;
}

export interface EmbeddingTrackerControllerOptions extends EmbeddingTrackerOptions {
  mode?: string;
  starter?: (options: EmbeddingTrackerOptions) => () => void;
}

const MIN_FILES_PER_TICK = 5;
const MAX_FILES_PER_TICK = 10;
const DEFAULT_FILES_PER_TICK = 8;
const DEFAULT_DEBOUNCE_MS = 1500;
const MAX_PENDING_FILES = 50;

const IGNORE_PREFIXES = [
  ".contextpro/",
  ".contextplus/",
  ".git/",
  "node_modules/",
  "build/",
  "dist/",
  "landing/.next/",
];

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldTrack(path: string): boolean {
  if (!path) return false;
  return !IGNORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function clampFilesPerTick(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_FILES_PER_TICK;
  return Math.max(MIN_FILES_PER_TICK, Math.min(MAX_FILES_PER_TICK, Math.floor(value ?? DEFAULT_FILES_PER_TICK)));
}

function clampDebounceMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DEBOUNCE_MS;
  return Math.max(500, Math.floor(value ?? DEFAULT_DEBOUNCE_MS));
}

export function parseEmbeddingTrackerMode(value: string | undefined): "off" | "lazy" | "eager" {
  if (!value) return "lazy";
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no", "off", "disabled", "none"].includes(normalized)) return "off";
  if (["eager", "startup", "boot"].includes(normalized)) return "eager";
  return "lazy";
}

export function startEmbeddingTracker(options: EmbeddingTrackerOptions): () => void {
  const pendingFiles = new Set<string>();
  const debounceMs = clampDebounceMs(options.debounceMs);
  const maxFilesPerTick = clampFilesPerTick(options.maxFilesPerTick);

  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let isProcessing = false;
  let closed = false;

  const schedule = (delay: number = debounceMs): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flushPending();
    }, delay);
    timer.unref();
  };

  const flushPending = async (): Promise<void> => {
    if (closed || isProcessing) return;
    if (pendingFiles.size === 0) return;

    isProcessing = true;
    const batch = Array.from(pendingFiles).slice(0, maxFilesPerTick);
    for (const file of batch) pendingFiles.delete(file);

    try {
      // Structural refresh keeps the symbol/import/call-site graph current — not
      // just embeddings — so related, blast_radius, and test_map reflect edits as
      // they happen. It re-indexes only this batch of changed files (no directory
      // walk) and refreshes their embeddings as part of the same pass.
      const result = await refreshFilesStructural(options.rootDir, batch);
      if (result.indexed > 0) {
        console.error(
          `Index tracker refreshed ${result.indexed} file(s) | symbols/imports/call-sites + embeddings`
          + (result.changedSymbols.length > 0 ? ` | ${result.changedSymbols.length} symbol change(s)` : ""),
        );
      }
    } catch (error) {
      console.error("Index tracker refresh failed:", error);
    } finally {
      isProcessing = false;
      if (pendingFiles.size > 0) schedule(100);
    }
  };

  try {
    watcher = watch(options.rootDir, { recursive: true }, (_eventType, fileName) => {
      if (closed || !fileName) return;
      const relativePath = normalizeRelativePath(String(fileName));
      if (!shouldTrack(relativePath)) return;
      if (pendingFiles.size >= MAX_PENDING_FILES) return;
      pendingFiles.add(relativePath);
      schedule();
    });
  } catch (error) {
    console.error("Embedding tracker disabled: file watching is unavailable.", error);
    return () => { };
  }

  watcher.on("error", (error) => {
    console.error("Embedding tracker watcher error:", error);
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    watcher = null;
  };
}

export function createEmbeddingTrackerController(options: EmbeddingTrackerControllerOptions): EmbeddingTrackerController {
  const { mode: rawMode, starter = startEmbeddingTracker, ...trackerOptions } = options;
  const mode = parseEmbeddingTrackerMode(rawMode);

  let running = false;
  let stopTracker = () => { };

  const ensureStarted = (): void => {
    if (running || mode === "off") return;
    stopTracker = starter(trackerOptions);
    running = true;
  };

  if (mode === "eager") ensureStarted();

  return {
    ensureStarted,
    stop: () => {
      if (!running) return;
      running = false;
      const stop = stopTracker;
      stopTracker = () => { };
      stop();
    },
    isRunning: () => running,
  };
}
