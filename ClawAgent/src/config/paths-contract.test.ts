// Delegation contract for the rules ClawAgent used to duplicate.
//
// HISTORY, because the shape of this file only makes sense with it: at M0,
// ClawAgent could not import `@openclaw/normalization-core` at runtime, since
// workspace packages resolve their imports with `.js` specifiers that Node's
// type-stripping loader cannot match against `.ts` sources. So `src/config/paths.ts`
// reimplemented the home-dir and agent-id rules, and this file compared the two
// implementations case by case to keep the copy honest.
//
// M1 removed the reason for the copy: `src/runtime/source-resolution.ts` maps
// `@openclaw/*` onto package sources, so `paths.ts` now imports these functions
// outright. The comparison tests became tautologies — a function compared with
// itself always agrees — which is worse than no test, because it looks like
// coverage.
//
// What is worth enforcing now is the opposite direction: that the delegation is
// real and nobody reintroduces a local copy. Reference equality proves it, and it
// fails the moment someone writes a lookalike implementation with the same name.

import { describe, expect, it } from "vitest";
import {
  isValidAgentId as isValidAgentIdUpstream,
  normalizeAgentId as normalizeAgentIdUpstream,
  normalizeAgentIdStrict as normalizeAgentIdStrictUpstream,
} from "@openclaw/normalization-core/agent-id";
import {
  normalizeHomeDirValue as normalizeHomeDirValueUpstream,
  resolveOsHomeDir as resolveOsHomeDirUpstream,
} from "@openclaw/normalization-core/home-dir";
import {
  isValidAgentId,
  normalizeAgentId,
  normalizeHomeDirValue,
  resolveOsHomeDir,
} from "./paths.ts";

/** Inputs that must never become a directory name. */
const AGENT_ID_CASES: ReadonlyArray<string | undefined | null> = [
  "main",
  "Main",
  "agent-1",
  "agent_1",
  "a".repeat(80),
  "../../etc/passwd",
  "..",
  ".",
  "",
  "   ",
  "a.b",
  "a/b",
  "a\\b",
  undefined,
  null,
];

describe("paths.ts delegates to @openclaw/normalization-core", () => {
  it.each([
    ["normalizeHomeDirValue", normalizeHomeDirValue, normalizeHomeDirValueUpstream],
    ["resolveOsHomeDir", resolveOsHomeDir, resolveOsHomeDirUpstream],
    ["isValidAgentId", isValidAgentId, isValidAgentIdUpstream],
  ] as const)("%s is the upstream function, not a copy", (_name, local, upstream) => {
    // Identity, not equivalence: a re-implementation could agree on every case
    // tried here and still diverge on the next one upstream adds.
    expect(local).toBe(upstream);
  });

  it.each(AGENT_ID_CASES)(
    "normalizeAgentId(%j) is the strict upstream result, minus its fallback",
    (value) => {
      // This one cannot be a re-export, and must not be: upstream's
      // `normalizeAgentId` returns "main" for unusable input, while ClawAgent
      // returns undefined so a caller has to choose the fallback deliberately.
      // The contract is therefore "derived from `normalizeAgentIdStrict`".
      const strict = normalizeAgentIdStrictUpstream(value);
      expect(normalizeAgentId(value)).toBe(strict.ok ? strict.value : undefined);
    },
  );

  it("never silently defaults an unusable agent id to main", () => {
    // The whole reason the adapter exists: upstream's loose helper answers "main"
    // for input it cannot use, which would route a misaddressed message into the
    // main agent's session history.
    for (const value of ["..", "", "   ", undefined, null]) {
      expect(normalizeAgentId(value)).toBeUndefined();
      expect(isValidAgentId(value)).toBe(false);
      expect(normalizeAgentIdUpstream(value)).toBe("main");
    }
  });

  it("sanitizes a traversal attempt rather than accepting or defaulting it", () => {
    // Path characters are stripped, so the result is a safe directory name; it is
    // not rejected outright, and it is certainly not "main".
    const normalized = normalizeAgentId("../../etc/passwd");
    expect(normalized).toBe("etc-passwd");
    expect(normalized).not.toContain(".");
    expect(normalized).not.toContain("/");
  });

  it("re-exports the agent-id pair together", () => {
    // `isValidAgentId` and `normalizeAgentId` must come from the same source, or
    // a value one accepts the other can reject.
    expect(isValidAgentId("main")).toBe(normalizeAgentId("main") !== undefined);
    expect(isValidAgentId("..")).toBe(normalizeAgentId("..") !== undefined);
  });
});
