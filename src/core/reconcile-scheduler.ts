// Reconcile sweep scheduler — decides WHEN the self-healing reconcile runs.
//
// FEATURE: Separates the "when to sweep" policy from the "how to sweep" diff
// (index-reconcile.ts) so the policy is unit-testable without real timers, a real
// repo, or the FS watcher. Policy:
//   - Sweep when activity has been signalled since the last sweep (the watcher
//     saw file changes) — fresh edits get reconciled promptly.
//   - Skip the sweep while idle, keeping background cost near-zero between edits.
//   - Force a deep sweep every Nth idle tick anyway, to catch out-of-band changes
//     the watcher cannot see (git checkout/rebase, atomic renames, missed events).
//   - Keep sweeping promptly while a capped backlog is still draining.
//   - Never run two sweeps concurrently.

import type { ReconcileResult } from "./index-reconcile.js";

export interface ReconcileSchedulerOptions {
  rootDir: string;
  /** Force a deep sweep every Nth idle tick even with no signalled activity. */
  forceEverySweeps?: number;
  /** The actual reconcile pass; injectable for tests. */
  sweep: (rootDir: string) => Promise<ReconcileResult>;
  /** Max files to reconcile per sweep, forwarded into the default sweep. */
  maxFilesPerSweep?: number;
}

export interface ReconcileScheduler {
  /** Mark that the watcher observed file activity since the last sweep. */
  signalActivity: () => void;
  /** Run one scheduling tick; sweeps only when the policy says to. */
  tick: () => Promise<void>;
  /** True while a capped backlog is still draining (caller may tick sooner). */
  isDraining: () => boolean;
}

const DEFAULT_FORCE_EVERY_SWEEPS = 10;

export function createReconcileScheduler(options: ReconcileSchedulerOptions): ReconcileScheduler {
  const forceEverySweeps = Math.max(1, Math.floor(options.forceEverySweeps ?? DEFAULT_FORCE_EVERY_SWEEPS));

  let dirty = false;
  let draining = false;
  let running = false;
  let idleTicks = 0;

  const runSweep = async (): Promise<void> => {
    running = true;
    try {
      const result = await options.sweep(options.rootDir);
      // Keep hot while a capped backlog remains so it drains over the next ticks.
      draining = result.pending > 0;
    } catch (error) {
      // A failed sweep must not wedge the scheduler; the next tick retries.
      console.error("Reconcile sweep failed:", error);
      draining = false;
    } finally {
      running = false;
    }
  };

  return {
    signalActivity: (): void => {
      dirty = true;
    },

    tick: async (): Promise<void> => {
      if (running) return; // serialize — never overlap sweeps

      const shouldSweep = dirty || draining;
      if (!shouldSweep) {
        idleTicks += 1;
        if (idleTicks < forceEverySweeps) return;
        // Forced deep sweep: fall through and sweep this idle tick.
      }

      // Consume the activity signal and reset the idle counter for this sweep.
      dirty = false;
      idleTicks = 0;
      await runSweep();
    },

    isDraining: (): boolean => draining,
  };
}
