// Resolver tests against throwaway checkouts.
//
// The rules here are derived from how this repository's packages actually declare
// their entry points, and that varies per package: some map a subpath to a nested
// `dist/utils/*.mjs`, some export `./src/*.ts` directly, and some declare nothing.
// A resolver that only handled one shape made `@openclaw/ai/providers` unloadable
// on a device, so each shape gets its own case.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isBareSpecifier,
  resolveRuntimeDependency,
  resolveOpenClawSource,
  resolveTypeScriptSibling,
  resetSourceResolutionCache,
} from "./source-resolution.ts";
import { pathToFileURL } from "node:url";

const created: string[] = [];

function checkout(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clawagent-packages-"));
  created.push(dir);
  return dir;
}

/** Writes `packages/<name>/package.json` plus source files under `src/`. */
function fakePackage(
  packagesDir: string,
  name: string,
  options: { exports?: Record<string, unknown>; files?: string[] } = {},
): string {
  const packageDir = path.join(packagesDir, name);
  mkdirSync(path.join(packageDir, "src"), { recursive: true });
  if (options.exports) {
    writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: `@openclaw/${name}`, exports: options.exports }, null, 2)}\n`,
    );
  }
  for (const file of options.files ?? []) {
    const full = path.join(packageDir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `export const marker = ${JSON.stringify(file)};\n`);
  }
  return packageDir;
}

afterEach(() => {
  resetSourceResolutionCache();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveOpenClawSource via exports map", () => {
  it("maps a nested dist target to its nested source file", () => {
    // This is the shape that broke `@openclaw/llm-core/event-stream`: the
    // subpath name and the source path differ, so only the manifest knows.
    const dir = checkout();
    fakePackage(dir, "llm-core", {
      exports: { "./event-stream": { import: "./dist/utils/event-stream.mjs" } },
      files: ["src/utils/event-stream.ts"],
    });
    const resolved = resolveOpenClawSource("@openclaw/llm-core/event-stream", dir);
    expect(resolved?.via).toBe("exports");
    expect(resolved?.file).toBe(path.join(dir, "llm-core/src/utils/event-stream.ts"));
  });

  it("maps the root export to src/index.ts", () => {
    const dir = checkout();
    fakePackage(dir, "ai", {
      exports: { ".": { import: "./dist/index.mjs" } },
      files: ["src/index.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/ai", dir)?.file).toBe(
      path.join(dir, "ai/src/index.ts"),
    );
  });

  it("accepts a package that exports src directly", () => {
    // plugin-sdk and tool-call-repair do this: no build output at all.
    const dir = checkout();
    fakePackage(dir, "tool-call-repair", {
      exports: { ".": "./src/index.ts", "./parse": "./src/parse.ts" },
      files: ["src/index.ts", "src/parse.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/tool-call-repair/parse", dir)?.file).toBe(
      path.join(dir, "tool-call-repair/src/parse.ts"),
    );
  });

  it("prefers a runtime condition over types", () => {
    // A `.d.mts` target has no loadable source; picking it would resolve to a
    // declaration file and fail at runtime with a syntax error.
    const dir = checkout();
    fakePackage(dir, "x-core", {
      exports: {
        ".": { types: "./dist/types.d.mts", import: "./dist/impl.mjs" },
      },
      files: ["src/impl.ts", "src/types.d.mts"],
    });
    expect(resolveOpenClawSource("@openclaw/x-core", dir)?.file).toBe(
      path.join(dir, "x-core/src/impl.ts"),
    );
  });

  it("falls back to types when no runtime condition exists", () => {
    const dir = checkout();
    fakePackage(dir, "x-core", {
      exports: { ".": { types: "./dist/only.d.mts" } },
      files: ["src/only.ts"],
    });
    // The declared `.d.mts` stem still names the source module.
    expect(resolveOpenClawSource("@openclaw/x-core", dir)?.file).toBe(
      path.join(dir, "x-core/src/only.ts"),
    );
  });

  it("resolves a dist target that names a directory index", () => {
    const dir = checkout();
    fakePackage(dir, "x-core", {
      exports: { "./harness": { import: "./dist/harness/index.mjs" } },
      files: ["src/harness/index.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/x-core/harness", dir)?.file).toBe(
      path.join(dir, "x-core/src/harness/index.ts"),
    );
  });

  it("resolves a dist target flattened from a directory carrying its own name", () => {
    // Real shape in @openclaw/agent-core: "./harness/compaction" declares
    // ./dist/harness/compaction.js while the module is
    // src/harness/compaction/compaction.ts, because the build collapses a
    // directory into one file. Guessing `src/<stem>.ts` finds nothing.
    const dir = checkout();
    fakePackage(dir, "agent-core", {
      exports: { "./harness/compaction": { import: "./dist/harness/compaction.js" } },
      files: ["src/harness/compaction/compaction.ts", "src/harness/compaction/utils.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/agent-core/harness/compaction", dir)?.file).toBe(
      path.join(dir, "agent-core/src/harness/compaction/compaction.ts"),
    );
  });

  it("prefers a directory index over the directory's own-basename module", () => {
    const dir = checkout();
    fakePackage(dir, "agent-core", {
      exports: { "./harness/compaction": { import: "./dist/harness/compaction.js" } },
      files: ["src/harness/compaction/index.ts", "src/harness/compaction/compaction.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/agent-core/harness/compaction", dir)?.file).toBe(
      path.join(dir, "agent-core/src/harness/compaction/index.ts"),
    );
  });

  it("finds a module that moved into a subdirectory when the dist layout is flat", () => {
    // Real shape in @openclaw/ai: "./diagnostics" declares
    // ./dist/diagnostics.mjs, but the module is src/utils/diagnostics.ts, and
    // the package has no build script of its own so the declared path can never
    // exist. agent-core imports this specifier at module scope, so the agent
    // loop is unloadable from source without the unique-basename rule.
    const dir = checkout();
    fakePackage(dir, "ai", {
      exports: { "./diagnostics": { import: "./dist/diagnostics.mjs" } },
      files: ["src/utils/diagnostics.ts", "src/index.ts"],
    });
    const resolved = resolveOpenClawSource("@openclaw/ai/diagnostics", dir);
    expect(resolved?.file).toBe(path.join(dir, "ai/src/utils/diagnostics.ts"));
    // Still found through the manifest, since the manifest named the module.
    expect(resolved?.via).toBe("exports");
  });

  it("leaves an ambiguous basename unresolved instead of guessing", () => {
    const dir = checkout();
    fakePackage(dir, "ai", {
      exports: { "./diagnostics": { import: "./dist/diagnostics.mjs" } },
      files: ["src/utils/diagnostics.ts", "src/providers/diagnostics.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/ai/diagnostics", dir)).toBeUndefined();
  });

  it("ignores test scaffolding when searching by basename", () => {
    // `agent-core` keeps tests beside sources, so counting them would make every
    // real module look ambiguous and disable the rule entirely.
    const dir = checkout();
    fakePackage(dir, "ai", {
      exports: { "./diagnostics": { import: "./dist/diagnostics.mjs" } },
      files: [
        "src/utils/diagnostics.ts",
        "src/utils/diagnostics.test.ts",
        "src/utils/diagnostics.test-support.ts",
      ],
    });
    expect(resolveOpenClawSource("@openclaw/ai/diagnostics", dir)?.file).toBe(
      path.join(dir, "ai/src/utils/diagnostics.ts"),
    );
  });

  it("never lets the basename rule override a file the manifest can already reach", () => {
    const dir = checkout();
    fakePackage(dir, "ai", {
      exports: {
        "./diagnostics": { import: "./dist/diagnostics.mjs" },
        // A genuine root-level source file, which is what the flat dist target
        // really describes.
        "./usage": "./src/usage.ts",
      },
      files: ["src/usage.ts", "src/utils/diagnostics.ts", "src/utils/usage.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/ai/diagnostics", dir)?.file).toBe(
      path.join(dir, "ai/src/utils/diagnostics.ts"),
    );
    expect(resolveOpenClawSource("@openclaw/ai/usage", dir)?.file).toBe(
      path.join(dir, "ai/src/usage.ts"),
    );
  });

  it("re-scans the source tree after a cache reset", () => {
    const dir = checkout();
    const packageDir = fakePackage(dir, "ai", {
      exports: { "./diagnostics": { import: "./dist/diagnostics.mjs" } },
      files: [],
    });
    expect(resolveOpenClawSource("@openclaw/ai/diagnostics", dir)).toBeUndefined();
    // The file appears only after the first scan, so the listing cache has to be
    // dropped for the rule to see it.
    mkdirSync(path.join(packageDir, "src/utils"), { recursive: true });
    writeFileSync(path.join(packageDir, "src/utils/diagnostics.ts"), "export const a = 1;\n");
    resetSourceResolutionCache();
    expect(resolveOpenClawSource("@openclaw/ai/diagnostics", dir)?.file).toBe(
      path.join(packageDir, "src/utils/diagnostics.ts"),
    );
  });

  it("falls back to the flat layout for an undeclared subpath", () => {
    // The manifest wins when it speaks; when it is silent, the uniform
    // `src/<subpath>.ts` layout is still a reasonable guess.
    const dir = checkout();
    fakePackage(dir, "x-core", {
      exports: { ".": "./src/index.ts" },
      files: ["src/index.ts", "src/extra.ts"],
    });
    const resolved = resolveOpenClawSource("@openclaw/x-core/extra", dir);
    expect(resolved?.via).toBe("subpath-extension");
    expect(resolved?.file).toBe(path.join(dir, "x-core/src/extra.ts"));
  });

  it("returns undefined when nothing matches, so the caller can rethrow", () => {
    const dir = checkout();
    fakePackage(dir, "x-core", {
      exports: { ".": "./dist/index.mjs" },
      files: [],
    });
    expect(resolveOpenClawSource("@openclaw/x-core", dir)).toBeUndefined();
  });

  it("caches a manifest but re-reads after a reset", () => {
    const dir = checkout();
    const packageDir = fakePackage(dir, "x-core", {
      exports: { ".": "./src/first.ts" },
      files: ["src/first.ts"],
    });
    expect(resolveOpenClawSource("@openclaw/x-core", dir)?.file).toBe(
      path.join(packageDir, "src/first.ts"),
    );
    // Rewrite the manifest behind the cache's back.
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@openclaw/x-core", exports: { ".": "./src/second.ts" } }),
    );
    writeFileSync(path.join(packageDir, "src/second.ts"), "export const marker = 1;\n");
    expect(resolveOpenClawSource("@openclaw/x-core", dir)?.file).toBe(
      path.join(packageDir, "src/first.ts"),
    );
    resetSourceResolutionCache();
    expect(resolveOpenClawSource("@openclaw/x-core", dir)?.file).toBe(
      path.join(packageDir, "src/second.ts"),
    );
  });
});

describe("resolveOpenClawSource fallbacks", () => {
  it("uses src/index.ts when there is no manifest", () => {
    const dir = checkout();
    fakePackage(dir, "bare", { files: ["src/index.ts"] });
    const resolved = resolveOpenClawSource("@openclaw/bare", dir);
    expect(resolved?.via).toBe("entry");
  });

  it("resolves a subpath that is already a real file", () => {
    const dir = checkout();
    fakePackage(dir, "bare", { files: ["src/nested/thing.ts"] });
    expect(resolveOpenClawSource("@openclaw/bare/nested/thing.ts", dir)?.via).toBe("subpath");
  });

  it("resolves a directory subpath through its index", () => {
    const dir = checkout();
    fakePackage(dir, "bare", { files: ["src/group/index.ts"] });
    expect(resolveOpenClawSource("@openclaw/bare/group", dir)?.via).toBe("directory-index");
  });

  it("ignores specifiers outside the scope", () => {
    const dir = checkout();
    expect(resolveOpenClawSource("openai", dir)).toBeUndefined();
    expect(resolveOpenClawSource("@openclaw/", dir)).toBeUndefined();
  });
});

describe("resolveRuntimeDependency", () => {
  // Why these exist: a reused core in `packages/<name>/src` imports its npm
  // dependencies by bare name, and Node resolves those by walking upward from
  // the *importing file*. On a phone that installed inside `ClawAgent/` there is
  // no node_modules on that path, so `openai` cannot be found at all unless the
  // hook supplies the right parent directory.

  function fakeInstall(packageDir: string, name: string, body: string): string {
    const target = path.join(packageDir, "node_modules", name);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, "package.json"),
      `${JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }, null, 2)}\n`,
    );
    writeFileSync(path.join(target, "index.mjs"), body);
    return target;
  }

  it("finds a package that normal resolution cannot reach", () => {
    const dir = checkout();
    const packageDir = path.join(dir, "consumer");
    fakeInstall(packageDir, "some-dep", "export const a = 1;\n");
    expect(resolveRuntimeDependency("some-dep", packageDir)).toBe(
      path.join(packageDir, "node_modules", "some-dep", "index.mjs"),
    );
  });

  it("resolves a scoped subpath export", () => {
    const dir = checkout();
    const packageDir = path.join(dir, "consumer");
    const target = fakeInstall(packageDir, "@scope/pkg", "export const a = 1;\n");
    writeFileSync(path.join(target, "extra.mjs"), "export const b = 2;\n");
    writeFileSync(
      path.join(target, "package.json"),
      `${JSON.stringify({
        name: "@scope/pkg",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.mjs", "./extra": "./extra.mjs" },
      }, null, 2)}\n`,
    );
    expect(resolveRuntimeDependency("@scope/pkg/extra", packageDir)).toBe(
      path.join(target, "extra.mjs"),
    );
  });

  it("returns undefined when the package is absent, so the original error survives", () => {
    const dir = checkout();
    mkdirSync(path.join(dir, "empty"), { recursive: true });
    expect(resolveRuntimeDependency("not-installed-anywhere", path.join(dir, "empty"))).toBeUndefined();
  });

  it("ignores specifiers it has no business resolving", () => {
    const dir = checkout();
    fakeInstall(dir, "some-dep", "export const a = 1;\n");
    expect(resolveRuntimeDependency("./some-dep", dir)).toBeUndefined();
    expect(resolveRuntimeDependency("node:path", dir)).toBeUndefined();
    expect(resolveRuntimeDependency("file:///tmp/x.mjs", dir)).toBeUndefined();
  });

  it("classifies bare specifiers without tripping on URL schemes", () => {
    expect(isBareSpecifier("openai")).toBe(true);
    expect(isBareSpecifier("@scope/name/sub")).toBe(true);
    expect(isBareSpecifier("./relative.js")).toBe(false);
    expect(isBareSpecifier("/absolute/path.js")).toBe(false);
    expect(isBareSpecifier("#internal")).toBe(false);
    expect(isBareSpecifier("node:fs")).toBe(false);
    expect(isBareSpecifier("data:text/javascript,")).toBe(false);
    expect(isBareSpecifier("")).toBe(false);
  });
});

describe("resolveTypeScriptSibling", () => {
  it("rewrites a .js specifier to the .ts file next to the importer", () => {
    const dir = checkout();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/helper.ts"), "export const a = 1;\n");
    const parent = pathToFileURL(path.join(dir, "src/index.ts")).href;
    expect(resolveTypeScriptSibling("./helper.js", parent)).toBe(
      path.join(dir, "src/helper.ts"),
    );
  });

  it("prefers a real .js file when one exists", () => {
    // A built checkout must win; otherwise the hook would shadow real output.
    const dir = checkout();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/helper.js"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "src/helper.ts"), "export const a = 1;\n");
    const parent = pathToFileURL(path.join(dir, "src/index.ts")).href;
    expect(resolveTypeScriptSibling("./helper.js", parent)).toBeUndefined();
  });

  it("ignores specifiers it has no rule for", () => {
    const dir = checkout();
    const parent = pathToFileURL(path.join(dir, "src/index.ts")).href;
    expect(resolveTypeScriptSibling("./helper", parent)).toBeUndefined();
    expect(resolveTypeScriptSibling("@openclaw/ai", parent)).toBeUndefined();
    expect(resolveTypeScriptSibling("./helper.js", "not-a-file-url")).toBeUndefined();
  });
});
