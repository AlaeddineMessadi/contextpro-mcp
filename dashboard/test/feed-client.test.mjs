import test from "node:test";
import assert from "node:assert/strict";
import {
  createFeedClient,
  feedsForView,
  visibleProjects,
} from "../src/lib/feed-client.mjs";
const response = (data, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => data,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("late responses cannot cross project scopes even when fetch ignores abort", async () => {
  const old = deferred();
  const published = [];
  const client = createFeedClient(
    (url) =>
      url.includes("old")
        ? old.promise
        : Promise.resolve(response({ root: "new" })),
    (item) => published.push(item),
  );
  client.setScope("/old");
  const oldRead = client.refresh(["status"]);
  client.setScope("/new");
  await client.refresh(["status"]);
  old.resolve(response({ root: "old" }));
  await oldRead;
  assert.deepEqual(
    published.map((p) => p.data.root),
    ["new"],
  );
  client.stop();
});
test("a failed graph never blocks status, activity, or subsequent recovery", async () => {
  let failing = true;
  const published = [];
  const client = createFeedClient(
    async (url) =>
      response(
        url.startsWith("/api/graph") && failing
          ? { error: "Graph unavailable" }
          : { ready: true },
        !(url.startsWith("/api/graph") && failing),
      ),
    (item) => published.push(item),
  );
  client.setScope("/workspace with spaces");
  await client.refresh(["status", "tools", "graph"]);
  assert.equal(published.filter((p) => p.data?.ready).length, 2);
  assert.match(
    published.find((p) => p.feed === "graph").error,
    /Graph unavailable/,
  );
  failing = false;
  await client.refresh(["graph"]);
  assert.equal(published.at(-1).data.ready, true);
  client.stop();
});
test("polling skips overlapping reads of the same feed", async () => {
  const read = deferred();
  let calls = 0;
  const client = createFeedClient(
    () => {
      calls++;
      return read.promise;
    },
    () => {},
  );
  client.setScope("/workspace");
  const first = client.refresh(["status"]);
  await client.refresh(["status"]);
  assert.equal(calls, 1);
  read.resolve(response({}));
  await first;
  await client.refresh(["status"]);
  assert.equal(calls, 2);
  client.stop();
});
test("a hung feed becomes a visible timeout and can be retried", async () => {
  const published = [];
  const client = createFeedClient(
    (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Aborted"))),
      ),
    (r) => published.push(r),
    5,
  );
  client.setScope("/workspace");
  await client.refresh(["reindex"]);
  assert.match(published[0].error, /timed out/);
  client.stop();
});
test("disposed view suppresses both data and errors", async () => {
  const read = deferred();
  const published = [];
  const client = createFeedClient(
    () => read.promise,
    (r) => published.push(r),
  );
  client.setScope("/workspace");
  const pending = client.refresh(["status"]);
  client.stop();
  read.resolve(response({ error: "Late error" }, false));
  await pending;
  assert.equal(published.length, 0);
});
test("overview is light; active details receive their own refresh feeds", () => {
  assert.deepEqual(feedsForView("overview"), ["status", "tools", "reindex"]);
  assert.ok(feedsForView("index").includes("stats"));
  assert.ok(feedsForView("graph").includes("graph"));
  assert.ok(feedsForView("graph").includes("memory"));
  assert.ok(feedsForView("resources").includes("perf"));
});
test("project search defaults to existing indexes and preserves distinct worktrees", () => {
  const projects = [
    { projectId: "app", root: "/main/app", hasIndex: true },
    { projectId: "app", root: "/worktree/app", hasIndex: true },
    { projectId: "fixture", root: "/deleted/fixture", hasIndex: false },
  ];
  assert.equal(visibleProjects(projects, "", false).length, 2);
  assert.equal(
    visibleProjects(projects, "WORKTREE", false)[0].root,
    "/worktree/app",
  );
  assert.equal(visibleProjects(projects, "fixture", true).length, 1);
  assert.equal(projects.length, 3);
});
