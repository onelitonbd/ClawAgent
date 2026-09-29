// Version resolution.
//
// The first test is the one that matters: `resolvePackageVersion()` with no
// argument is how the CLI calls it, and it silently returned the fallback for as
// long as this file did not exist. `import.meta.url` is a string holding a `file:`
// URL, and the lookup treated any string as a filesystem path — so every explicit
// argument worked while the default did not.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_VERSION,
  PACKAGE_NAME,
  findPackageManifest,
  resolvePackageVersion,
} from "./version.ts";

// Derived from this file's own location, never hardcoded: the test has to pass in
// CI, in a checkout at any path, and on a phone.
const HERE = fileURLToPath(import.meta.url).replace(/version\.test\.ts$/u, "version.ts");
const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clawagent-version-"));
  created.push(dir);
  return dir;
}

/** Writes `package.json` files down a nested tree and returns the deepest dir. */
function nested(manifests: Array<{ at: string; contents: unknown }>): string {
  const root = tempDir();
  let deepest = root;
  for (const manifest of manifests) {
    const dir = path.join(root, manifest.at);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest.contents)}\n`);
    deepest = dir;
  }
  return deepest;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolvePackageVersion", () => {
  it("resolves the real version when called with no argument", () => {
    // Regression: the default `import.meta.url` is a `file:` URL *string*. It was
    // handed to `path.resolve`, producing "<cwd>/file:/home/...", so the walk
    // found nothing and `clawagent --version` printed the fallback.
    expect(resolvePackageVersion()).not.toBe(FALLBACK_VERSION);
    expect(resolvePackageVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("resolves the same version for every locator form", () => {
    const expected = resolvePackageVersion(new URL(pathToFileURL(HERE).href));
    expect(resolvePackageVersion(pathToFileURL(HERE).href)).toBe(expected);
    expect(resolvePackageVersion(new URL(pathToFileURL(HERE).href))).toBe(expected);
    expect(resolvePackageVersion(HERE)).toBe(expected);
    expect(resolvePackageVersion()).toBe(expected);
  });

  it("falls back rather than throwing when nothing matches", () => {
    const dir = nested([{ at: "a/b", contents: { name: "something-else", version: "1.2.3" } }]);
    expect(resolvePackageVersion(path.join(dir, "index.ts"))).toBe(FALLBACK_VERSION);
  });

  it("falls back for a locator that is not a file URL or a path", () => {
    // A non-file URL cannot name a directory to walk; the answer is the fallback
    // rather than a throw, because `--version` must always print something.
    expect(resolvePackageVersion("http://example.invalid/package.json")).toBe(FALLBACK_VERSION);
  });
});

describe("findPackageManifest", () => {
  it("walks up past directories with no manifest", () => {
    const root = tempDir();
    const deep = path.join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "4.5.6" }),
    );
    expect(findPackageManifest(path.join(deep, "index.ts"))?.version).toBe("4.5.6");
  });

  it("stops at the nearest manifest that names this package", () => {
    const root = tempDir();
    const inner = path.join(root, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "9.9.9" }),
    );
    writeFileSync(
      path.join(inner, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "1.0.0" }),
    );
    expect(findPackageManifest(path.join(inner, "x.ts"))?.version).toBe("1.0.0");
  });

  it("ignores a manifest belonging to another package and keeps walking", () => {
    // This is the real layout: the repository root above ClawAgent names
    // `openclaw`, and stopping there would report the wrong version.
    const root = tempDir();
    const inner = path.join(root, "ClawAgent");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "9.9.9" }),
    );
    writeFileSync(
      path.join(inner, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "2.0.0" }),
    );
    expect(findPackageManifest(path.join(inner, "src", "version.ts"))?.version).toBe("2.0.0");
  });

  it("keeps walking past an unparseable manifest", () => {
    const root = tempDir();
    const inner = path.join(root, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(inner, "package.json"), "{ not json");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "3.0.0" }),
    );
    expect(findPackageManifest(path.join(inner, "x.ts"))?.version).toBe("3.0.0");
  });

  it("gives up after a bounded walk", () => {
    // A runaway walk on a deep phone storage tree would be a slow, silent hang.
    const root = tempDir();
    let dir = root;
    for (let index = 0; index < 12; index += 1) {
      dir = path.join(dir, `level-${index}`);
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "9.9.9" }),
    );
    expect(findPackageManifest(path.join(dir, "x.ts"))).toBeUndefined();
  });

  it("accepts a file URL string, a URL object, and a path alike", () => {
    const root = tempDir();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "5.0.0" }),
    );
    const file = path.join(root, "x.ts");
    const url = pathToFileURL(file);
    expect(findPackageManifest(file)?.version).toBe("5.0.0");
    expect(findPackageManifest(url)?.version).toBe("5.0.0");
    expect(findPackageManifest(url.href)?.version).toBe("5.0.0");
  });
});
