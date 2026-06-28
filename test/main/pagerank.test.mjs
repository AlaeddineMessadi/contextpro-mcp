// PageRank tests — graph-centrality importance for repo_map ranking
// FEATURE: Rank files by transitive importance over the import graph (Aider's
// repomap trick) instead of local degree counts, with an optional personalization
// vector biasing rank toward a target subtree.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePageRank } from "../../build/core/pagerank.js";

describe("computePageRank", () => {
  it("returns a uniform-ish distribution for an empty edge set", () => {
    const ranks = computePageRank(["a", "b", "c"], []);
    assert.equal(ranks.size, 3);
    const values = [...ranks.values()];
    const sum = values.reduce((acc, v) => acc + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `ranks should sum to ~1, got ${sum}`);
    // With no edges every node is symmetric → equal rank.
    for (const v of values) assert.ok(Math.abs(v - 1 / 3) < 1e-6);
  });

  it("ranks a heavily-imported hub above its importers", () => {
    // a, b, c all import hub. hub has no outgoing edges.
    const edges = [
      ["a", "hub"],
      ["b", "hub"],
      ["c", "hub"],
    ];
    const ranks = computePageRank(["a", "b", "c", "hub"], edges);
    assert.ok(ranks.get("hub") > ranks.get("a"), "hub should outrank its importers");
    assert.ok(ranks.get("hub") > ranks.get("b"));
    assert.ok(ranks.get("hub") > ranks.get("c"));
  });

  it("captures transitive importance (imported-by-important beats imported-by-many-leaves)", () => {
    // important <- a (and a is imported by many leaves, making a important)
    // popular <- many leaves directly, but those leaves are unimportant
    const edges = [
      // a is made important by leaf importers
      ["l1", "a"], ["l2", "a"], ["l3", "a"], ["l4", "a"],
      // a imports important → flows a's high rank into important
      ["a", "important"],
      // popular is imported by two leaves only
      ["l5", "popular"], ["l6", "popular"],
    ];
    const nodes = ["l1", "l2", "l3", "l4", "l5", "l6", "a", "important", "popular"];
    const ranks = computePageRank(nodes, edges);
    assert.ok(
      ranks.get("important") > ranks.get("popular"),
      `important(${ranks.get("important")}) should beat popular(${ranks.get("popular")})`,
    );
  });

  it("sums to ~1 and handles dangling nodes (no out-edges)", () => {
    const edges = [["a", "b"], ["b", "c"]]; // c is dangling
    const ranks = computePageRank(["a", "b", "c"], edges);
    const sum = [...ranks.values()].reduce((acc, v) => acc + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `ranks should sum to ~1 with dangling nodes, got ${sum}`);
  });

  it("biases rank toward the personalization set", () => {
    const nodes = ["a", "b", "x", "y"];
    const edges = [["a", "b"], ["x", "y"]];
    const plain = computePageRank(nodes, edges);
    const biased = computePageRank(nodes, edges, { personalization: new Set(["x", "y"]) });
    // The personalized subgraph (x,y) should gain rank relative to (a,b).
    assert.ok(
      biased.get("y") > plain.get("y"),
      `personalized y(${biased.get("y")}) should exceed unbiased y(${plain.get("y")})`,
    );
    assert.ok(biased.get("b") < plain.get("b"), "non-personalized node should lose relative rank");
  });

  it("ignores edges referencing unknown nodes without crashing", () => {
    const ranks = computePageRank(["a", "b"], [["a", "ghost"], ["a", "b"]]);
    assert.equal(ranks.size, 2);
    const sum = [...ranks.values()].reduce((acc, v) => acc + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
  });
});
