import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyPatch, parsePatchText } from "../../../src/agent/tools/apply-patch.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "walnut-patch-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("applyPatch", () => {
  it("adds a new file", async () => {
    const patch = `*** Begin Patch
*** Add File: hello.txt
+hello world
+second line
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });
    const contents = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf8");

    expect(contents).toBe("hello world\nsecond line\n");
    expect(result.summary.added).toEqual(["hello.txt"]);
    expect(result.text).toContain("A hello.txt");
  });

  it("adds a file in a subdirectory", async () => {
    const patch = `*** Begin Patch
*** Add File: sub/dir/file.txt
+content
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });
    const contents = await fs.readFile(path.join(tmpDir, "sub", "dir", "file.txt"), "utf8");

    expect(contents).toBe("content\n");
    expect(result.summary.added).toEqual(["sub/dir/file.txt"]);
  });

  it("updates an existing file", async () => {
    await fs.writeFile(path.join(tmpDir, "existing.txt"), "line1\nline2\nline3\n", "utf8");

    const patch = `*** Begin Patch
*** Update File: existing.txt
 line1
-line2
+modified line
 line3
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });
    const contents = await fs.readFile(path.join(tmpDir, "existing.txt"), "utf8");

    expect(contents).toBe("line1\nmodified line\nline3\n");
    expect(result.summary.modified).toEqual(["existing.txt"]);
    expect(result.text).toContain("M existing.txt");
  });

  it("deletes a file", async () => {
    const filePath = path.join(tmpDir, "to-delete.txt");
    await fs.writeFile(filePath, "temporary content\n", "utf8");

    const patch = `*** Begin Patch
*** Delete File: to-delete.txt
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });
    await expect(fs.stat(filePath)).rejects.toBeDefined();
    expect(result.summary.deleted).toEqual(["to-delete.txt"]);
    expect(result.text).toContain("D to-delete.txt");
  });

  it("updates with @@ context markers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "context.txt"),
      "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
      "utf8",
    );

    const patch = `*** Begin Patch
*** Update File: context.txt
@@ function bar() {
-  return 2;
+  return 42;
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });
    const contents = await fs.readFile(path.join(tmpDir, "context.txt"), "utf8");

    expect(contents).toContain("return 42");
    expect(contents).toContain("return 1");
    expect(result.summary.modified).toEqual(["context.txt"]);
  });

  it("supports end-of-file inserts", async () => {
    await fs.writeFile(path.join(tmpDir, "end.txt"), "line1\n", "utf8");

    const patch = `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`;

    await applyPatch(patch, { cwd: tmpDir });
    const contents = await fs.readFile(path.join(tmpDir, "end.txt"), "utf8");
    expect(contents).toBe("line1\nline2\n");
  });

  it("updates and moves a file", async () => {
    const source = path.join(tmpDir, "source.txt");
    await fs.writeFile(source, "foo\nbar\n", "utf8");

    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });
    const dest = path.join(tmpDir, "dest.txt");
    const contents = await fs.readFile(dest, "utf8");

    expect(contents).toBe("foo\nbaz\n");
    await expect(fs.stat(source)).rejects.toBeDefined();
    expect(result.summary.modified).toEqual(["dest.txt"]);
  });

  it("handles multiple operations in one patch", async () => {
    await fs.writeFile(path.join(tmpDir, "modify.txt"), "original\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "remove.txt"), "bye\n", "utf8");

    const patch = `*** Begin Patch
*** Add File: new.txt
+brand new
*** Update File: modify.txt
-original
+changed
*** Delete File: remove.txt
*** End Patch`;

    const result = await applyPatch(patch, { cwd: tmpDir });

    expect(result.summary.added).toEqual(["new.txt"]);
    expect(result.summary.modified).toEqual(["modify.txt"]);
    expect(result.summary.deleted).toEqual(["remove.txt"]);

    const newContent = await fs.readFile(path.join(tmpDir, "new.txt"), "utf8");
    expect(newContent).toBe("brand new\n");

    const modContent = await fs.readFile(path.join(tmpDir, "modify.txt"), "utf8");
    expect(modContent).toBe("changed\n");
  });
});

describe("parsePatchText", () => {
  it("throws on empty input", () => {
    expect(() => parsePatchText("")).toThrow("input is empty");
  });

  it("throws on missing Begin Patch marker", () => {
    expect(() => parsePatchText("no markers here\n*** End Patch")).toThrow(
      "*** Begin Patch",
    );
  });

  it("throws on missing End Patch marker", () => {
    expect(() => parsePatchText("*** Begin Patch\nstuff")).toThrow(
      "*** End Patch",
    );
  });

  it("parses a valid add file hunk", () => {
    const result = parsePatchText(`*** Begin Patch
*** Add File: test.txt
+hello
*** End Patch`);

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toEqual({
      kind: "add",
      path: "test.txt",
      contents: "hello\n",
    });
  });

  it("parses a valid delete file hunk", () => {
    const result = parsePatchText(`*** Begin Patch
*** Delete File: old.txt
*** End Patch`);

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toEqual({
      kind: "delete",
      path: "old.txt",
    });
  });

  it("handles EOF heredoc wrapper", () => {
    const result = parsePatchText(`<<EOF
*** Begin Patch
*** Add File: test.txt
+hello
*** End Patch
EOF`);

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toEqual({
      kind: "add",
      path: "test.txt",
      contents: "hello\n",
    });
  });
});
