import test from "node:test";
import assert from "node:assert/strict";
import { createFeedClient } from "../src/lib/feed-client.mjs";
import {
  pendingJobsReducer,
  pendingJobOutcome,
} from "../src/lib/pending-jobs.mjs";

test("a pre-acceptance null read arriving late cannot declare the new job missing", async () => {
  let releaseOld;
  const oldResponse = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let calls = 0;
  let state = { running: true, startedAt: 100 };
  const results = [];
  const response = (state) => ({ ok: true, json: async () => ({ state }) });
  const client = createFeedClient(
    () => (++calls === 1 ? oldResponse : Promise.resolve(response(state))),
    (result) => results.push(result),
  );
  try {
    client.setScope("/a");
    const oldRead = client.refresh(["reindex"]);
    const jobs = pendingJobsReducer(
      {},
      {
        type: "accepted",
        root: "/a",
        requestedAt: 100,
        acceptedAt: performance.now(),
      },
    );
    await client.refresh(["reindex"]);
    assert.equal(calls, 1, "An existing read prevents the immediate refresh");
    releaseOld(response(null));
    await oldRead;
    const late = results.at(-1);
    assert.ok(late.startedAt < jobs["/a"].acceptedAt);
    assert.equal(
      pendingJobOutcome(jobs["/a"], late.data.state, late.startedAt),
      null,
    );
    await client.refresh(["reindex"]);
    const running = results.at(-1);
    assert.equal(
      pendingJobOutcome(jobs["/a"], running.data.state, running.startedAt),
      null,
    );
    state = { running: false, startedAt: 100, finishedAt: 200 };
    await client.refresh(["reindex"]);
    const finished = results.at(-1);
    assert.equal(
      pendingJobOutcome(jobs["/a"], finished.data.state, finished.startedAt),
      "complete",
    );
  } finally {
    client.stop();
  }
});

test("first indexing stays recoverable after switching away and completing another workspace", () => {
  // A's POST may resolve while B is selected; acceptance still belongs to A.
  let jobs = pendingJobsReducer(
    {},
    { type: "accepted", root: "/a", requestedAt: 10, acceptedAt: 20 },
  );
  jobs = pendingJobsReducer(jobs, {
    type: "accepted",
    root: "/b",
    requestedAt: 30,
    acceptedAt: 40,
  });
  assert.equal(
    pendingJobOutcome(jobs["/a"], { running: true, startedAt: 11 }, 50),
    null,
  );
  assert.equal(
    pendingJobOutcome(
      jobs["/b"],
      { running: false, startedAt: 31, finishedAt: 51 },
      52,
    ),
    "complete",
  );
  jobs = pendingJobsReducer(jobs, {
    type: "settled",
    root: "/b",
    acceptedAt: 40,
  });
  assert.ok(jobs["/a"], "Returning to unindexed A still enables its job feeds");
  assert.equal(
    pendingJobOutcome(
      jobs["/a"],
      { running: false, startedAt: 11, finishedAt: 60 },
      61,
    ),
    "complete",
  );
  jobs = pendingJobsReducer(jobs, {
    type: "settled",
    root: "/a",
    acceptedAt: 20,
  });
  assert.deepEqual(jobs, {});
});

test("stale completions and missing-state reads cannot erase a newly accepted job", () => {
  let jobs = pendingJobsReducer(
    {},
    { type: "accepted", root: "/a", requestedAt: 100, acceptedAt: 110 },
  );
  assert.equal(
    pendingJobOutcome(
      jobs["/a"],
      { running: false, startedAt: 1, finishedAt: 2 },
      120,
    ),
    null,
  );
  assert.equal(pendingJobOutcome(jobs["/a"], null, 109), null);
  assert.equal(pendingJobOutcome(jobs["/a"], null, 111), "missing");
  assert.equal(
    pendingJobsReducer(jobs, { type: "settled", root: "/a", acceptedAt: 20 }),
    jobs,
  );
  jobs = pendingJobsReducer(jobs, {
    type: "accepted",
    root: "/a",
    requestedAt: 150,
    acceptedAt: 160,
    alreadyRunning: true,
  });
  assert.equal(
    pendingJobOutcome(
      jobs["/a"],
      { running: false, startedAt: 1, finishedAt: 2 },
      150,
    ),
    null,
    "Cached completion must not settle a server job that is already running",
  );
  assert.equal(
    pendingJobOutcome(
      jobs["/a"],
      {
        running: false,
        startedAt: 100,
        finishedAt: 170,
        error: "Index failed",
      },
      180,
    ),
    "failed",
  );
});
