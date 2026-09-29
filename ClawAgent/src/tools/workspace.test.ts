// The containment boundary. These are the tests that decide whether the tool
// layer is safe to put in front of a model, so they aim at the two ways a path
// escapes: the lexical `..`, and a symlink that points out.

import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createWorkspace, isInsideRoot, resolveToolPath, WorkspacePathError } from "./workspace.ts";
import { outsideTree, withWorkspace, type ToolFixture } from "../../test/tool-support.ts";

let fixture: ToolFixture | undefined;

function setup(): ToolFixture {
  fixture = withWorkspace();
  return fixture;
}

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("isInsideRoot", () => {
  it("treats the root as inside itself", () => {
    expect(isInsideRoot("/w", "/w")).toBe(true);
  });

  it("accepts a nested path and rejects a sibling with a shared prefix", () => {
    expect(isInsideRoot("/w", "/w/src/a.ts")).toBe(true);
    // The classic bug: string-prefix checks allow `/w-evil`.
    expect(isInsideRoot("/w", "/w-evil/a.ts")).toBe(false);
  });
});

describe("resolveToolPath", () => {
  it("resolves a relative path against the workspace root", () => {
    const workspace = setup().workspace();
    expect(resolveToolPath(workspace, "src/a.ts")).toBe(path.join(workspace.root, "src/a.ts"));
  });

  it("keeps a nested path inside", () => {
    const workspace = setup().workspace();
    expect(resolveToolPath(workspace, "src/../src/b.ts")).toBe(path.join(workspace.root, "src/b.ts"));
  });

  it("refuses a lexical escape under strict policy", () => {
    const fix = setup();
    fix.write("a.ts", "x");
    expect(() => resolveToolPath(fix.workspace(), "../../etc/passwd")).toThrow(WorkspacePathError);
    try {
      resolveToolPath(fix.workspace(), "../outside");
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("outside the workspace");
      // The error has to name the root, or the model cannot correct itself.
      expect(message).toContain(fix.root);
    }
  });

  it("refuses an absolute path outside the workspace", () => {
    const workspace = setup().workspace();
    expect(() => resolveToolPath(workspace, "/etc/passwd")).toThrow(/outside the workspace/u);
  });

  it("refuses a symlinked directory that points out of the workspace", () => {
    // The leaf does not exist, which is the case a leaf-only canonicalisation
    // would wave through: `vendor/new-file.txt` is writable the moment `vendor`
    // is a symlink out of the tree.
    const fix = setup();
    const elsewhere = outsideTree();
    try {
      fix.symlink(elsewhere.root, "vendor");
      expect(() => resolveToolPath(fix.workspace(), path.join("vendor", "new-file.txt"))).toThrow(
        /reaches outside the workspace through/u,
      );
      // The message names the component that escaped, so the model can stop
      // trying to fix the filename.
      try {
        resolveToolPath(fix.workspace(), path.join("vendor", "new-file.txt"));
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain("reaches outside the workspace through");
        expect((error as Error).message).toContain("resolves to");
      }
      // `open` policy is the documented way to allow this, and it reaches the
      // real target rather than the link path.
      expect(resolveToolPath(fix.workspace({ policy: "open" }), path.join("vendor", "a.txt"))).toBe(
        path.join(elsewhere.root, "a.txt"),
      );
    } finally {
      elsewhere.cleanup();
    }
  });

  it("refuses a path whose parent is a file instead of building a nonsense path", () => {
    // Without this check the tool would try to open
    // `<root>/not-a-dir/x.ts` after canonicalising and report a path the model
    // never asked for.
    const fix = setup();
    fix.write("not-a-dir", "i am a file");
    try {
      resolveToolPath(fix.workspace(), path.join("not-a-dir", "x.ts"));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("not a directory");
    }
  });

  it("refuses a symlinked workspace root that escapes itself", () => {
    // createWorkspace canonicalises the root, so a root that is a symlink does
    // not silently redefine "inside".
    const fix = setup();
    const elsewhere = outsideTree();
    try {
      mkdirSync(path.join(elsewhere.root, "project"));
      fix.symlink(path.join(elsewhere.root, "project"), "alias");
      const workspace = createWorkspace({ root: path.join(fix.root, "alias") });
      expect(workspace.root).toBe(path.join(elsewhere.root, "project"));
    } finally {
      elsewhere.cleanup();
    }
  });

  it("allows an absolute path that is inside the workspace", () => {
    const fix = setup();
    const file = fix.write("src/a.ts", "x");
    expect(resolveToolPath(fix.workspace(), file)).toBe(file);
  });

  it("lets an open workspace reach outside, which is what --workspace is for", () => {
    const fix = setup();
    const outside = path.join(path.dirname(fix.root), "elsewhere");
    const workspace = fix.workspace({ policy: "open" });
    expect(resolveToolPath(workspace, outside)).toBe(outside);
  });

  it("refuses an empty path with an actionable message", () => {
    const workspace = setup().workspace();
    expect(() => resolveToolPath(workspace, "   ", "read path")).toThrow(/read path is empty/u);
  });

  it("normalises separators so a trailing slash is not a second root", () => {
    const fix = setup();
    const workspace = fix.workspace();
    expect(resolveToolPath(workspace, "src/")).toBe(path.join(workspace.root, "src"));
    expect(resolveToolPath(workspace, "./src/a.ts")).toBe(path.join(workspace.root, "src/a.ts"));
  });
});
