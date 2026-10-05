export type Feed =
  | "status"
  | "tools"
  | "reindex"
  | "stats"
  | "graph"
  | "memory"
  | "perf";
export interface FeedResult {
  feed: Feed;
  data?: unknown;
  error?: string;
  updatedAt?: number;
  /** Monotonic time at request start, for indexing acceptance comparisons. */
  startedAt?: number;
}
export function createFeedClient(
  fetcher: typeof fetch,
  publish: (result: FeedResult) => void,
  timeoutMs?: number,
): {
  setScope(root: string): void;
  refresh(feeds: Feed[]): Promise<void>;
  stop(): void;
};
export function feedsForView(view: string): Feed[];
export function visibleProjects<
  T extends { projectId: string | null; root: string; hasIndex: boolean },
>(projects: T[], query: string, includeUnavailable: boolean): T[];
