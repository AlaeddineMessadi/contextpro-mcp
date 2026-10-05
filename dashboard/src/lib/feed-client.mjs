/** Independent, scope-safe reads shared by the UI and regression checks. */
export function createFeedClient(fetcher, publish, timeoutMs = 20_000) {
  let root = "";
  let generation = 0;
  const pending = new Map();
  function setScope(nextRoot) {
    generation++;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    root = nextRoot;
  }
  async function refresh(feeds) {
    const current = generation;
    await Promise.all(
      feeds.map(async (feed) => {
        if (pending.has(feed)) return;
        const controller = new AbortController();
        const startedAt = performance.now();
        pending.set(feed, controller);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        try {
          const response = await fetcher(
            `/api/${feed}?root=${encodeURIComponent(root)}`,
            { cache: "no-store", signal: controller.signal },
          );
          const data = await response.json();
          if (!response.ok)
            throw new Error(
              data.error || `Request failed (${response.status})`,
            );
          if (current === generation && !controller.signal.aborted)
            publish({ feed, data, startedAt, updatedAt: Date.now() });
        } catch (error) {
          if (
            current === generation &&
            (!controller.signal.aborted || timedOut)
          ) {
            publish({
              feed,
              error: timedOut
                ? "Request timed out. Refresh to retry."
                : String(error),
            });
          }
        } finally {
          clearTimeout(timer);
          if (pending.get(feed) === controller) pending.delete(feed);
        }
      }),
    );
  }
  return { setScope, refresh, stop: () => setScope("") };
}

export function feedsForView(view) {
  const core = ["status", "tools", "reindex"];
  return [
    ...core,
    ...({ index: ["stats"], graph: ["graph", "memory"], resources: ["perf"] }[
      view
    ] ?? []),
  ];
}

export function visibleProjects(projects, query, includeUnavailable) {
  const needle = query.trim().toLowerCase();
  return projects.filter(
    (p) =>
      (includeUnavailable || p.hasIndex) &&
      `${p.projectId ?? ""} ${p.root}`.toLowerCase().includes(needle),
  );
}
