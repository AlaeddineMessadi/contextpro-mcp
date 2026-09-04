// Tests for the call-site noise filter and exact_references auto-locate
// FEATURE: Regression coverage for J + I from the post-reconnect sweep

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("extractCallSites filters", () => {
  it("skips method calls on objects (Math.max, console.log)", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const sites = extractCallSites([
      "const x = Math.max(1, 2);",
      "console.log('hi');",
      "myFn(42);",
    ].join("\n"));
    const callees = sites.map((s) => s.callee);
    assert.ok(!callees.includes("max"), "Math.max should not register as a call to 'max'");
    assert.ok(!callees.includes("log"), "console.log should not register as a call to 'log'");
    assert.ok(callees.includes("myFn"), "bare myFn() should still register");
  });

  it("skips JS keywords like if/for/while/return/new", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const sites = extractCallSites([
      "if (cond) {",
      "  while (x) {",
      "    return foo();",
      "  }",
      "}",
      "throw new Error('x');",
      "myFn();",
    ].join("\n"));
    const callees = sites.map((s) => s.callee);
    assert.ok(!callees.includes("if"));
    assert.ok(!callees.includes("for"));
    assert.ok(!callees.includes("while"));
    assert.ok(!callees.includes("return"));
    assert.ok(!callees.includes("Error"), "stdlib Error should be filtered");
    assert.ok(callees.includes("foo"));
    assert.ok(callees.includes("myFn"));
  });

  it("skips stdlib globals (JSON.parse, Array.from, Promise.all)", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const sites = extractCallSites([
      "const a = JSON.parse('{}');",
      "const b = Array.from([1, 2]);",
      "const c = Promise.all([p1, p2]);",
      "userFn();",
    ].join("\n"));
    const callees = sites.map((s) => s.callee);
    assert.ok(!callees.includes("parse"));
    assert.ok(!callees.includes("from"));
    assert.ok(!callees.includes("all"));
    assert.ok(callees.includes("userFn"));
  });

  it("skips occurrences inside comments and string literals", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const source = [
      "// fakeCall()",
      "const message = 'anotherFake()';",
      "/* blockFake() */",
      "realCall();",
      "# pythonFake()",
    ].join("\n");
    assert.deepEqual(extractCallSites(source, "fixture.py").map((site) => site.callee), ["realCall"]);
  });

  it("keeps executable template expressions while masking template text", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const source = [
      "function render() {",
      "  return `user: ${loadUser()}`;",
      "}",
      "const literal = `loadUser()`;",
    ].join("\n");
    assert.deepEqual(extractCallSites(source, "fixture.ts").map((site) => site.callee), ["loadUser"]);
  });

  it("keeps Rust lifetime and label syntax executable", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const source = [
      "fn wrapper<'a>(value: &'a str) -> &'a str {",
      "  'retry: loop {",
      "    return oldName(value);",
      "  }",
      "}",
    ].join("\n");
    assert.deepEqual(extractCallSites(source, "fixture.rs").map((site) => site.callee), ["oldName"]);
  });

  it("keeps Unicode Rust lifetime and label syntax executable", async () => {
    const { extractCallSites } = await import("../../build/core/parser.js");
    const source = [
      "fn wrapper<'α>(value: &'α str) -> &'α str {",
      "  'επανάληψη: loop {",
      "    return oldName(value);",
      "  }",
      "}",
    ].join("\n");
    assert.deepEqual(extractCallSites(source, "fixture.rs").map((site) => site.callee), ["oldName"]);
  });
});
