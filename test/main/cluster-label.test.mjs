import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveHeuristicLabel } from "../../build/tools/semantic-navigate.js";

// Reproduce the Round-4 audit's cluster-labeling complaint:
//  - import vocabulary ("invalidoperation" from `from decimal import InvalidOperation`) leaked into labels
//  - bare repo name ("tradebot" x6) and raw path globs were emitted
//  - feature dirs (fees/, esports/, venues/) were NOT recovered as labels
// The clustering geometry co-locates a feature's files correctly, so the label SHOULD be the dir name.

function file(relativePath, header = "", content = "") {
  return { relativePath, header, content, symbolPreview: [] };
}

describe("cluster-label heuristic", () => {
  it("recovers the feature directory name when ≥60% of files share it", () => {
    const cluster = {
      pathPattern: null,
      files: [
        file("tradebot/fees/flat.py", "Flat fee model"),
        file("tradebot/fees/venue_a.py", "VenueA fee schedule"),
        file("tradebot/fees/base.py", "Fee model protocol base"),
        file("tradebot/fees/percentage.py", "Percentage fee model"),
      ],
    };
    const label = deriveHeuristicLabel(cluster, 0);
    assert.match(label, /fees/, `expected a fees label, got "${label}"`);
  });

  it("does NOT leak import vocabulary (invalidoperation) into the label", () => {
    // Every file's header restates a decimal import — the classic leak source.
    const allFiles = [];
    const clusterFiles = [];
    for (let i = 0; i < 5; i++) {
      const f = file(
        `tradebot/venues/venue_${i}.py`,
        "from decimal import Decimal, InvalidOperation, getcontext",
        "",
      );
      clusterFiles.push(f);
      allFiles.push(f);
    }
    // add corpus noise from other dirs, also importing decimal
    for (let i = 0; i < 5; i++) {
      allFiles.push(file(`tradebot/fees/fee_${i}.py`, "from decimal import Decimal, InvalidOperation", ""));
    }
    const label = deriveHeuristicLabel({ pathPattern: null, files: clusterFiles }, 0, allFiles);
    assert.doesNotMatch(label.toLowerCase(), /invalidoperation|decimal|getcontext/, `import vocab leaked: "${label}"`);
    assert.match(label, /venue/, `expected a venues label, got "${label}"`);
  });

  it("never emits the bare repo-root name as a label", () => {
    // A cluster that spans several feature dirs but all under the same repo root.
    // The shared root ("tradebot") must NOT become the label.
    const cluster = {
      pathPattern: null,
      files: [
        file("tradebot/maker/quote.py", "Maker quoting"),
        file("tradebot/telegram/bot.py", "Telegram bot"),
        file("tradebot/esports/scanner.py", "Esports scanner"),
      ],
    };
    const label = deriveHeuristicLabel(cluster, 2);
    assert.notEqual(label.toLowerCase(), "tradebot", "bare repo name leaked as label");
    assert.doesNotMatch(label, /^tradebot$/i);
  });

  it("does not emit raw path globs (slashes / wildcards)", () => {
    const cluster = {
      pathPattern: null,
      files: [
        file("tradebot/esports/a.py", "from __future__ import annotations"),
        file("tradebot/esports/b.py", "from __future__ import annotations"),
        file("tradebot/esports/c.py", "from __future__ import annotations"),
      ],
    };
    const label = deriveHeuristicLabel(cluster, 0);
    assert.doesNotMatch(label, /[/*]/, `raw path glob leaked: "${label}"`);
    assert.match(label, /esports/, `expected esports, got "${label}"`);
  });

  it("honors an explicit pathPattern when the clusterer provides one", () => {
    const label = deriveHeuristicLabel(
      { pathPattern: "src/fees", files: [file("src/fees/a.py")] },
      0,
    );
    assert.equal(label, "src/fees");
  });

  it("falls back to a stable label, never empty, when no signal exists", () => {
    const cluster = {
      pathPattern: null,
      files: [file("a.py", ""), file("b.py", "")],
    };
    const label = deriveHeuristicLabel(cluster, 3);
    assert.ok(label.length > 0, "label must never be empty");
  });
});
