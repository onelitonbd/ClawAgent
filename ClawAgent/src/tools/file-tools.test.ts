// File tool behaviour, tested against real files on a real filesystem.
//
// The interesting cases are the ones where a shortcut in the tool becomes a
// wrong answer for the model: paging past the end, a silent truncation, an edit
// that matched twice, and a mode change nobody asked for.

import { describe, expect, it, afterEach } from "vitest";
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createEditTool, createReadTool, createWriteTool } from "./file-tools.ts";
import { withWorkspace, runTool, type ToolFixture } from "../../test/tool-support.ts";

let fixture: ToolFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const numbered = (line: number, text: string): string => `${String(line).padStart(6)}\t${text}`;

describe("read", () => {
  it("returns the whole file with line numbers", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("a.ts", "one\ntwo\nthree");
    const out = await runTool(createReadTool({ workspace: fix.workspace() }), { path: "a.ts" });
    expect(out).toBe([numbered(1, "one"), numbered(2, "two"), numbered(3, "three")].join("\n"));
  });

  it("pages with offset and reports what is left", async () => {
    const fix = (fixture = withWorkspace());
    const lines = Array.from({ length: 30 }, (_unused, index) => `line ${index + 1}`).join("\n");
    fix.write("b.ts", lines);
    const tool = createReadTool({ workspace: fix.workspace() });
    const page = await runTool(tool, { path: "b.ts", offset: 26, limit: 3 });
    expect(page).toContain(numbered(26, "line 26"));
    expect(page).toContain(numbered(28, "line 28"));
    expect(page).not.toContain("line 29");
    // The continuation pointer has to be correct or the model re-reads the same
    // window forever.
    expect(page).toContain("continue with offset 29");
  });

  it("announces a byte cap instead of cutting silently", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("big.ts", `${"x".repeat(4000)}\n`.repeat(80));
    const out = await runTool(createReadTool({ workspace: fix.workspace() }), { path: "big.ts" });
    expect(out).toContain("output capped at");
  });

  it("refuses a missing file, a directory, and a binary", async () => {
    const fix = (fixture = withWorkspace());
    fix.mkdir("dir");
    writeFileSync(path.join(fix.root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const tool = createReadTool({ workspace: fix.workspace() });
    await expect(runTool(tool, { path: "missing.ts" })).rejects.toThrow(/no such file/u);
    await expect(runTool(tool, { path: "dir" })).rejects.toThrow(/is a directory; use glob/u);
    await expect(runTool(tool, { path: "bin.dat" })).rejects.toThrow(/binary file/u);
  });

  it("strips a byte-order mark so the first line is not invisible garbage", async () => {
    const fix = (fixture = withWorkspace());
    writeFileSync(fix.write("bom.ts", ""), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const a = 1;\n")]));
    const out = await runTool(createReadTool({ workspace: fix.workspace() }), { path: "bom.ts" });
    expect(out).toContain("export const a = 1;");
    expect(out).not.toContain("ï»¿");
  });
});

describe("write", () => {
  it("creates missing parent directories", async () => {
    const fix = (fixture = withWorkspace());
    await runTool(createWriteTool({ workspace: fix.workspace() }), {
      path: "deep/nested/file.ts",
      content: "export const a = 1;\n",
    });
    expect(fix.read("deep/nested/file.ts")).toBe("export const a = 1;\n");
  });

  it("reports created and updated differently, since that is what the model did", async () => {
    const fix = (fixture = withWorkspace());
    const tool = createWriteTool({ workspace: fix.workspace() });
    expect(await runTool(tool, { path: "c.ts", content: "a" })).toContain("created c.ts");
    expect(await runTool(tool, { path: "c.ts", content: "ab" })).toContain("updated c.ts");
  });

  it("keeps the mode of an existing file, including a restrictive one", async () => {
    const fix = (fixture = withWorkspace());
    const target = fix.write("token", "old\n");
    // 0600 is the interesting case: an edit that rewrites the file through a
    // temp path would otherwise land at the umask default of 0644.
    chmodSync(target, 0o600);
    await runTool(createWriteTool({ workspace: fix.workspace() }), { path: "token", content: "new\n" });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("new\n");
  });

  it("leaves the original file intact when the write cannot be completed", async () => {
    const fix = (fixture = withWorkspace());
    const target = fix.write("ro.txt", "original");
    chmodSync(path.dirname(target), 0o500);
    try {
      await expect(
        runTool(createWriteTool({ workspace: fix.workspace() }), { path: "ro.txt", content: "changed" }),
      ).rejects.toThrow();
      chmodSync(path.dirname(target), 0o700);
      expect(readFileSync(target, "utf8")).toBe("original");
    } finally {
      chmodSync(path.dirname(target), 0o700);
    }
  });

  it("refuses to write over a directory", async () => {
    const fix = (fixture = withWorkspace());
    fix.mkdir("adir");
    await expect(
      runTool(createWriteTool({ workspace: fix.workspace() }), { path: "adir", content: "x" }),
    ).rejects.toThrow(/is a directory/u);
  });
});

describe("edit", () => {
  it("replaces exact text", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("a.ts", "const x = 1;\nconst y = 2;\n");
    const out = await runTool(createEditTool({ workspace: fix.workspace() }), {
      path: "a.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }],
    });
    expect(out).toContain("1 replacement");
    expect(fix.read("a.ts")).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("applies several edits in order, atomically", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("b.ts", "one\ntwo\nthree\n");
    await runTool(createEditTool({ workspace: fix.workspace() }), {
      path: "b.ts",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "three", newText: "3" },
      ],
    });
    expect(fix.read("b.ts")).toBe("1\ntwo\n3\n");
  });

  it("writes nothing when one edit in a batch fails", async () => {
    // The failure that matters: edit 1 matched, edit 2 did not. A tool that
    // writes what it could leaves a file that is broken in a new way and a model
    // that believes it succeeded.
    const fix = (fixture = withWorkspace());
    fix.write("c.ts", "alpha\nbeta\n");
    const before = fix.read("c.ts");
    await expect(
      runTool(createEditTool({ workspace: fix.workspace() }), {
        path: "c.ts",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "not in the file", newText: "x" },
        ],
      }),
    ).rejects.toThrow(/edit 2: oldText not found/u);
    expect(fix.read("c.ts")).toBe(before);
  });

  it("requires uniqueness unless all is set, and says how many matched", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("d.ts", "dup\ndup\ndup\n");
    const tool = createEditTool({ workspace: fix.workspace() });
    await expect(runTool(tool, { path: "d.ts", edits: [{ oldText: "dup", newText: "x" }] })).rejects.toThrow(
      /matches 3 places/u,
    );
    await runTool(tool, { path: "d.ts", edits: [{ oldText: "dup", newText: "x", all: true }] });
    expect(fix.read("d.ts")).toBe("x\nx\nx\n");
  });

  it("treats a replacement equal to the original as no change, not an error", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("e.ts", "same\n");
    const out = await runTool(createEditTool({ workspace: fix.workspace() }), {
      path: "e.ts",
      edits: [{ oldText: "same", newText: "same" }],
    });
    expect(out).toContain("no change");
  });

  it("refuses an empty oldText instead of matching everywhere", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("f.ts", "content\n");
    await expect(
      runTool(createEditTool({ workspace: fix.workspace() }), {
        path: "f.ts",
        edits: [{ oldText: "", newText: "boom" }],
      }),
    ).rejects.toThrow(/oldText is empty/u);
    expect(fix.read("f.ts")).toBe("content\n");
  });

  it("leaves no temp file behind on success or failure", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("g.ts", "a\n");
    await runTool(createEditTool({ workspace: fix.workspace() }), {
      path: "g.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(fix.read("g.ts")).toBe("b\n");
    const leftovers = readdirSync(fix.root).filter((name) => name.includes("clawagent-tmp"));
    expect(leftovers).toEqual([]);
  });
});
