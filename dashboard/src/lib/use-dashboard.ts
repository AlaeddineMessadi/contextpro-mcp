"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createFeedClient, feedsForView, type Feed } from "./feed-client.mjs";
import type { DashboardFeeds, View } from "./dashboard-types";

type Snapshot = {
  root: string;
  data: Partial<DashboardFeeds>;
  errors: Partial<Record<Feed, string>>;
  updated: Partial<Record<Feed, number>>;
  readStarted: Partial<Record<Feed, number>>;
};
export function useDashboard(
  root: string,
  view: View,
  live: boolean,
  enabled: boolean,
  pollJob: boolean,
) {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    root: "",
    data: {},
    errors: {},
    updated: {},
    readStarted: {},
  });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const latest = useRef(snapshot);
  latest.current = snapshot;
  useEffect(() => {
    if (!root || !enabled) return;
    let active = true;
    const client = createFeedClient(fetch, (result) => {
      if (!active) return;
      setSnapshot((previous) => {
        const state =
          previous.root === root
            ? previous
            : { root, data: {}, errors: {}, updated: {}, readStarted: {} };
        const errors = { ...state.errors };
        if (result.error) errors[result.feed] = result.error;
        else delete errors[result.feed];
        return {
          root,
          errors,
          data: result.error
            ? state.data
            : { ...state.data, [result.feed]: result.data },
          updated: result.updatedAt
            ? { ...state.updated, [result.feed]: result.updatedAt }
            : state.updated,
          readStarted:
            result.startedAt !== undefined
              ? { ...state.readStarted, [result.feed]: result.startedAt }
              : state.readStarted,
        };
      });
    });
    client.setScope(root);
    const feeds = feedsForView(view);
    const refresh = () => client.refresh(feeds);
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => {
      const state = latest.current.root === root ? latest.current : null;
      if (!live && !pollJob && !state?.data.reindex?.state?.running) return;
      if (
        document.visibilityState === "hidden" &&
        !pollJob &&
        !state?.data.reindex?.state?.running
      )
        return;
      void client.refresh(
        feeds.filter(
          (feed) =>
            !["graph", "memory"].includes(feed) ||
            Date.now() - (state?.updated[feed] ?? 0) >= 30_000,
        ),
      );
    }, 5000);
    const onVisible = () => {
      if (live && document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      client.stop();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      refreshRef.current = async () => {};
    };
  }, [root, view, live, enabled, pollJob]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return {
    ...(snapshot.root === root && enabled
      ? snapshot
      : ({
          root,
          data: {},
          errors: {},
          updated: {},
          readStarted: {},
        } as Snapshot)),
    refresh,
  };
}
