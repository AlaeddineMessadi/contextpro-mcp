import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { getFileSkeleton } from "../../build/tools/file-skeleton.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

const FIXTURE_DIR = join(process.cwd(), "test", "_skel_fixtures");

async function setup() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
}

describe("file-skeleton", async () => {
  await setup();

  describe("getFileSkeleton", () => {
    it("labels multiline signatures and array summaries as unsuitable for exact edit anchors", async () => {
      await writeFile(join(FIXTURE_DIR, "multiline.ts"), "export function run({\n  first,\n  second,\n}: { first: string; second: string }) { return first; }\nexport const values = [\n  'first',\n  'second',\n];\n");
      const result = await getFileSkeleton({ rootDir: FIXTURE_DIR, filePath: "multiline.ts" });
      assert.match(result, /API summary \(normalized\/truncated\)/);
      assert.match(result, /for exact edit text use context/);
      assert.match(result, /run/);
      assert.match(result, /values/);
      assert.doesNotMatch(result, /return first/);
    });
    it("preserves multiline imports and never renders import fragments as header comments", async () => {
      const source = `import {
  cleanText,
  cookie,
  type Claims,
  verify as check,
} from './security';
import * as namespace from './other';
export function run() { return check(cookie()); }
`;
      await writeFile(join(FIXTURE_DIR, "imports.ts"), source);
      const result = await getFileSkeleton({ rootDir: FIXTURE_DIR, filePath: "imports.ts" });
      assert.match(result, /\.\/security: cleanText, cookie, Claims, verify/);
      assert.match(result, /\.\/other: namespace/);
      assert.doesNotMatch(result, /\/\/ cleanText|cookie, \|/);
    });
    it("returns skeleton for a TypeScript file", async () => {
      await writeFile(
        join(FIXTURE_DIR, "app.ts"),
        "// App module\n// Main entry\n\nfunction start() {}\nfunction stop() {}\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "app.ts",
      });
      assert.ok(result.includes("app.ts"));
      assert.ok(result.includes("start") || result.includes("stop"));
    });

    it("includes line count", async () => {
      await writeFile(
        join(FIXTURE_DIR, "small.ts"),
        "// H1\n// H2\n\nfunction x() {}\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "small.ts",
      });
      assert.ok(result.includes("lines"));
    });

    it("includes line metadata for symbols", async () => {
      await writeFile(
        join(FIXTURE_DIR, "lines.ts"),
        "// H1\n// H2\n\nfunction alpha() {\n  return 1;\n}\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "lines.ts",
      });
      assert.ok(result.includes("L"));
    });

    it("includes symbol count", async () => {
      await writeFile(
        join(FIXTURE_DIR, "multi.ts"),
        "// H1\n// H2\n\nfunction a() {}\nfunction b() {}\nfunction c() {}\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "multi.ts",
      });
      assert.ok(result.includes("definition"));
    });

    it("shows header in skeleton", async () => {
      await writeFile(
        join(FIXTURE_DIR, "header.ts"),
        "// MyModule description here\n// Second header line\n\nfunction run() {}\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "header.ts",
      });
      assert.ok(result.includes("MyModule"));
    });

    it("shows file preview for unsupported files", async () => {
      await writeFile(
        join(FIXTURE_DIR, "readme.md"),
        "# Hello\n\nSome markdown content\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "readme.md",
      });
      assert.ok(result.includes("Unsupported") || result.includes("Hello"));
    });

    it("shows first 30 lines when no symbols detected", async () => {
      await writeFile(join(FIXTURE_DIR, "empty.ts"), "\n\n\nconst x = 1;\n");
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "empty.ts",
      });
      assert.ok(typeof result === "string");
    });

    it("includes method signatures for classes", async () => {
      await writeFile(
        join(FIXTURE_DIR, "cls.ts"),
        "// Class test\n// Description\n\nclass Dog {\n  bark(): string {\n    return 'woof';\n  }\n}\n",
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "cls.ts",
      });
      assert.ok(result.includes("Dog") || result.includes("bark"));
    });

    it("detects React memo wrapper components in TSX files", async () => {
      await writeFile(
        join(FIXTURE_DIR, "component.tsx"),
        [
          "import React from 'react';",
          "type ImageSelectionAreaProps = { value: string };",
          "const ImageSelectionArea = React.memo(function ImageSelectionArea(props: ImageSelectionAreaProps) {",
          "  return <div>{props.value}</div>;",
          "});",
          "export default ImageSelectionArea;",
          "",
        ].join("\n"),
      );
      const result = await getFileSkeleton({
        rootDir: FIXTURE_DIR,
        filePath: "component.tsx",
      });
      assert.match(result, /ImageSelectionArea/);
      assert.match(result, /React\.memo|function ImageSelectionArea/);
    });

    it("rejects reads outside the project root", async () => {
      await assert.rejects(
        () => getFileSkeleton({ rootDir: FIXTURE_DIR, filePath: "../outside.ts" }),
        /Path escapes project root/,
      );
    });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});
