import type { ReindexState } from "./mcp";
export interface PendingJob {
  requestedAt: number;
  acceptedAt: number;
}
export type PendingJobs = Record<string, PendingJob>;
export type PendingAction =
  | {
      type: "accepted";
      root: string;
      requestedAt: number;
      acceptedAt: number;
      alreadyRunning?: boolean;
    }
  | { type: "settled"; root: string; acceptedAt: number };
export function pendingJobsReducer(
  jobs: PendingJobs,
  action: PendingAction,
): PendingJobs;
export function pendingJobOutcome(
  pending: PendingJob | undefined,
  job: ReindexState | null | undefined,
  readStartedAt: number,
): "complete" | "failed" | "missing" | null;
