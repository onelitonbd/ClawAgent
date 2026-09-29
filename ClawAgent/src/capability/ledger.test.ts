import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  buildLedger,
  capability,
  capabilityLabel,
  renderLedger,
  renderLedgerLegend,
  renderLedgerSummary,
  summarizeLedger,
  type Capability,
} from "./ledger.ts";

function entry(
  id: Capability["id"],
  status: Capability["status"],
  options: { required?: boolean } = {},
): Capability {
  return capability(id, status, `${id} detail`, {
    ...(options.required ? { required: true } : {}),
  });
}

describe("capability()", () => {
  it("fills in the canonical label", () => {
    expect(capability("node.runtime", "available", "ok").label).toBe("Node runtime");
    expect(capabilityLabel("node.runtime")).toBe("Node runtime");
  });

  it("omits optional fields rather than storing undefined", () => {
    const bare = capability("host.termux", "available", "ok");
    expect(Object.keys(bare)).toEqual(["id", "label", "status", "detail"]);
    expect("remediation" in bare).toBe(false);
    expect("required" in bare).toBe(false);
  });

  it("keeps remediation and required when supplied", () => {
    const full = capability("state.writable", "unavailable", "nope", {
      remediation: ["do this"],
      required: true,
    });
    expect(full.remediation).toEqual(["do this"]);
    expect(full.required).toBe(true);
  });

  it("has a label for every declared id", () => {
    // A new capability id without a label would render as "undefined" in doctor.
    for (const id of CAPABILITY_IDS) {
      expect(capabilityLabel(id), `missing label for ${id}`).toBeTruthy();
    }
  });
});

describe("buildLedger()", () => {
  it("is startable when nothing required is broken", () => {
    const ledger = buildLedger([
      entry("node.runtime", "available", { required: true }),
      entry("host.termux", "unavailable"),
    ]);
    expect(ledger.startable).toBe(true);
  });

  it("is not startable when a required capability is unavailable", () => {
    const ledger = buildLedger([entry("node.runtime", "unavailable", { required: true })]);
    expect(ledger.startable).toBe(false);
  });

  it("treats a degraded required capability as blocking", () => {
    // "Degraded" still means the promise cannot be kept, so it must block.
    const ledger = buildLedger([entry("state.writable", "degraded", { required: true })]);
    expect(ledger.startable).toBe(false);
    expect(summarizeLedger(ledger).blocking).toEqual(["state.writable"]);
  });

  it("does not block on optional capabilities", () => {
    const ledger = buildLedger([
      entry("termux-api.wake-lock", "unavailable"),
      entry("battery.reading", "unavailable"),
    ]);
    expect(ledger.startable).toBe(true);
    expect(summarizeLedger(ledger).blocking).toEqual([]);
  });

  it("lists every blocking capability, not just the first", () => {
    const ledger = buildLedger([
      entry("node.runtime", "unavailable", { required: true }),
      entry("node.sqlite", "unavailable", { required: true }),
      entry("state.home", "available", { required: true }),
    ]);
    expect(summarizeLedger(ledger).blocking).toEqual(["node.runtime", "node.sqlite"]);
  });

  it("does not alias the caller's array", () => {
    const input: Capability[] = [entry("node.runtime", "available")];
    const ledger = buildLedger(input);
    input.push(entry("host.termux", "unavailable"));
    expect(ledger.capabilities).toHaveLength(1);
  });
});

describe("summarizeLedger()", () => {
  it("counts each status", () => {
    const summary = summarizeLedger(
      buildLedger([
        entry("node.runtime", "available"),
        entry("node.sqlite", "available"),
        entry("storage.free", "degraded"),
        entry("host.termux", "unavailable"),
      ]),
    );
    expect(summary).toMatchObject({ total: 4, available: 2, degraded: 1, unavailable: 1 });
  });

  it("handles an empty ledger", () => {
    const summary = summarizeLedger(buildLedger([]));
    expect(summary).toMatchObject({ total: 0, available: 0, degraded: 0, unavailable: 0 });
    expect(summary.blocking).toEqual([]);
  });
});

describe("renderLedger()", () => {
  it("pads the status mark so columns line up across statuses", () => {
    // "ok" is two characters and "warn"/"fail" are four; without padding the
    // required marker and every label shift by two on healthy rows.
    const lines = renderLedger(
      buildLedger([
        entry("node.runtime", "available", { required: true }),
        entry("storage.free", "degraded"),
        entry("host.termux", "unavailable"),
      ]),
    );
    expect(lines).toEqual([
      "ok  * Node runtime  node.runtime detail",
      "warn  Free storage  storage.free detail",
      "fail  Termux host   host.termux detail",
    ]);
  });

  it("aligns details to the widest label regardless of status word length", () => {
    const lines = renderLedger(
      buildLedger([
        entry("resources.memory", "available"),
        entry("host.termux", "unavailable"),
      ]),
    );
    // Mark column (4) + required column (1) + separator (1) + widest label
    // ("Memory" is 6, "Termux host" is 11, so width is 11) + two spaces = 19.
    const detailColumns = lines.map((line) => line.search(/\S+ detail$/u));
    expect(detailColumns).toEqual([19, 19]);
  });

  it("indents remediation under its capability", () => {
    const lines = renderLedger(
      buildLedger([
        capability("termux-api.installed", "unavailable", "missing", {
          remediation: ["pkg install termux-api"],
        }),
      ]),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("    -> pkg install termux-api");
  });

  it("renders an empty ledger without throwing", () => {
    // Math.max() over an empty list is -Infinity; the renderer must not pad with it.
    expect(renderLedger(buildLedger([]))).toEqual([]);
  });
});

describe("renderLedgerSummary()", () => {
  it("reports counts on one line", () => {
    const lines = renderLedgerSummary(
      buildLedger([entry("node.runtime", "available"), entry("host.termux", "unavailable")]),
    );
    expect(lines[0]).toBe("1 available, 0 degraded, 1 unavailable");
    expect(lines).toHaveLength(1);
  });

  it("names blocking capabilities", () => {
    const lines = renderLedgerSummary(
      buildLedger([entry("node.runtime", "unavailable", { required: true })]),
    );
    expect(lines).toContain("cannot start: node.runtime");
  });
});

describe("renderLedgerLegend()", () => {
  it("explains the status words and the required marker", () => {
    const legend = renderLedgerLegend();
    expect(legend).toContain("ok");
    expect(legend).toContain("fail");
    expect(legend).toContain("*");
  });
});
