// glob / grep. The behavior worth pinning is what a model does when the answer
// is "nothing": an empty result must read as "no matches", not as a broken tool,
// and a capped result must say it was capped.

import { describe, expect, it, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createGlobTool, createGrepTool, walkFiles } from "./search.ts";
import { withWorkspace, runTool, type ToolFixture } from "../../test/tool-support.ts";

let fixture: ToolFixture | undefined;

function setup(files: Record<string, string>): ToolFixture {
  fixture = withWorkspace();
  for (const [name, contents] of Object.entries(files)) {
    fixture.write(name, contents);
  }
  return fixture;
}

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("walkFiles", () => {
  it("skips .git and node_modules and sorts by path", () => {
    const fix = setup({
      "z.ts": "1",
      "a.ts": "2",
      "src/mid.ts": "3",
      "node_modules/pkg/i.ts": "4",
      ".git/hooks/x.ts": "5",
    });
    const walked = walkFiles({ root: fix.root });
    expect(walked.entries.map((entry) => entry.relative)).toEqual(["a.ts", "src/mid.ts", "z.ts"]);
    expect(walked.directoriesSkipped).toBeGreaterThanOrEqual(2);
  });

  it("hides dotfiles unless asked, then shows them", () => {
    const fix = setup({ ".envrc": "x", "plain.txt": "y" });
    expect(walkFiles({ root: fix.root }).entries.map((e) => e.relative)).toEqual(["plain.txt"]);
    expect(walkFiles({ root: fix.root, includeHidden: true }).entries.map((e) => e.relative)).toEqual([
      ".envrc",
      "plain.txt",
    ]);
  });

  it("does not follow a symlinked directory into a cycle", () => {
    const fix = setup({ "a.txt": "x" });
    // `loop -> ..` is one `ls` away from an infinite walk if it is followed.
    fix.symlink(fix.root, "loop");
    const walked = walkFiles({ root: fix.root });
    expect(walked.entries.map((entry) => entry.relative)).toEqual(["a.txt"]);
  });

  it("reports truncation instead of pretending the list is complete", () => {
    const fix = withWorkspace();
    for (let index = 0; index < 12; index += 1) {
      fix.write(`f${index}.txt`, "x");
    }
    const walked = walkFiles({ root: fix.root, maxEntries: 5 });
    expect(walked.truncated).toBe(true);
    expect(walked.entries).toHaveLength(5);
  });

  it("skips files over the size cap so grep never reads a 2 GiB download", () => {
    const fix = withWorkspace();
    fix.write("small.txt", "x");
    writeFileSync(path.join(fix.root, "huge.bin"), Buffer.alloc(4096, 1));
    const walked = walkFiles({ root: fix.root, maxFileBytes: 1024 });
    expect(walked.entries.map((entry) => entry.relative)).toEqual(["small.txt"]);
  });
});

describe("glob", () => {
  it("matches at any depth for a slash-free pattern and lists sizes", async () => {
    const fix = setup({ "a.ts": "1", "src/deep/b.ts": "22", "c.js": "333" });
    const out = await runTool(createGlobTool({ workspace: fix.workspace() }), { pattern: "*.ts" });
    expect(out).toContain("a.ts\t1");
    expect(out).toContain("src/deep/b.ts\t2"); // two bytes of content
    expect(out).not.toContain("c.js");
  });

  it("says no files matched rather than returning an empty string", async () => {
    const fix = setup({ "a.ts": "1" });
    const out = await runTool(createGlobTool({ workspace: fix.workspace() }), { pattern: "*.rs" });
    expect(out).toBe("no files matched");
  });

  it("honours a limit and reports how many it withheld", async () => {
    const fix = withWorkspace();
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      fix.write(name, "x");
    }
    const out = await runTool(createGlobTool({ workspace: fix.workspace() }), { pattern: "*.ts", limit: 2 });
    expect(out).toContain("1 more matches");
  });
});

describe("grep", () => {
  it("finds matches with file:line prefixes", async () => {
    const fix = setup({ "a.ts": "const target = 1;\nother\n", "b.ts": "nothing\n" });
    const out = await runTool(createGrepTool({ workspace: fix.workspace() }), { pattern: "target" });
    expect(out).toContain("1 matching line in 1 file");
    expect(out).toContain("a.ts:1:const target = 1;");
  });

  it("supports context lines around a hit", async () => {
    const fix = setup({ "c.ts": "one\ntwo\nTHREE\nfour\nfive\n" });
    const out = await runTool(createGrepTool({ workspace: fix.workspace() }), {
      pattern: "THREE",
      context: 1,
    });
    expect(out).toContain("c.ts:2-two");
    expect(out).toContain("c.ts:3:THREE");
    expect(out).toContain("c.ts:4-four");
    expect(out).not.toContain("c.ts:5");
  });

  it("treats the pattern as a regular expression, case-insensitively on request", async () => {
    const fix = setup({ "d.txt": "Alpha\nbeta\nALPHA\n" });
    const tool = createGrepTool({ workspace: fix.workspace() });
    expect(await runTool(tool, { pattern: "^alpha$", ignoreCase: true })).toContain("2 matching lines");
    expect(await runTool(tool, { pattern: "^alpha$" })).not.toContain("matching");
  });

  it("reports an invalid pattern as the user's error, not a crash", async () => {
    const fix = setup({ "e.txt": "x" });
    await expect(runTool(createGrepTool({ workspace: fix.workspace() }), { pattern: "([unclosed" })).rejects.toThrow(
      /invalid regular expression/u,
    );
  });

  it("filters by glob and skips binary files", async () => {
    const fix = setup({ "a.ts": "needle\n", "a.md": "needle\n" });
    writeFileSync(path.join(fix.root, "blob.bin"), Buffer.from([0, 1, 0x80, 0xff]));
    const out = await runTool(createGrepTool({ workspace: fix.workspace() }), { pattern: "needle", glob: "*.ts" });
    expect(out).toContain("1 matching line in 1 file");
    expect(out).toContain("a.ts:1");
  });

  it("searches one file when pointed at a file", async () => {
    const fix = setup({ "f.ts": "hit here\nmiss\n" });
    const out = await runTool(createGrepTool({ workspace: fix.workspace() }), { path: "f.ts", pattern: "hit" });
    expect(out).toContain("f.ts:1:hit here");
  });

  it("says no matches when there are none", async () => {
    const fix = setup({ "g.ts": "x\n" });
    expect(await runTool(createGrepTool({ workspace: fix.workspace() }), { pattern: "absent" })).toBe("no matches");
  });
});
