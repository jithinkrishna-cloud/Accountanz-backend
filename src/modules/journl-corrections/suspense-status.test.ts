import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("./correction.repository.js", () => ({ listPostedSuspenseAdjustments: m.list }));
vi.mock("../../utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../integrations/journl.gateway.js", () => ({ journlGet: vi.fn() }));

const { suspenseStatus, suspenseField, SUSPENSE_CHECK_FAILED } = await import("./suspense-status.js");

const tree = (closing: number | string) => [
  { id: 9, name: "Suspense A/c", closingBalance: closing, children: [{ ledgerId: 77, ledgerName: "Suspense", closingBalance: closing }] },
  { id: 1, name: "Other", closingBalance: 0, children: [{ ledgerId: 5, ledgerName: "Cash", closingBalance: 0 }] },
];
const adj = (id: number, name = "Suspense", approver = "Asha", ledgerId = 77) => ({ id, payload: { ledger_id: ledgerId, ledger_name: name, amount_paise: 1, side: "dr" as const }, approved_by_name: approver });
const two = (a: number, b: number) => [
  { id: 9, name: "Suspense A/c", closingBalance: a + b, children: [{ ledgerId: 77, ledgerName: "Suspense", closingBalance: a }, { ledgerId: 78, ledgerName: "Suspense 2", closingBalance: b }] },
];

beforeEach(() => vi.resetAllMocks());

describe("suspenseStatus", () => {
  it("is null with no posted adjustment", async () => {
    m.list.mockResolvedValue([]);
    expect(await suspenseStatus(1, tree(-6759.9))).toBeNull();
    expect(m.list).toHaveBeenCalledWith(1);
  });
  it("is null when the Suspense ledger balance is 0", async () => {
    m.list.mockResolvedValue([adj(4)]);
    expect(await suspenseStatus(1, tree(0))).toBeNull();
  });
  it("reports 6,759.90 as 675990 paise with ledger and refs", async () => {
    m.list.mockResolvedValue([adj(12), adj(4, "Suspense", "Ravi")]);
    expect(await suspenseStatus(1, tree(-6759.9))).toEqual({
      unresolved_paise: 675990,
      side: "dr",
      ledger: "Suspense",
      corrections: [{ ref: "ACZ-12", approved_by: "Asha" }, { ref: "ACZ-4", approved_by: "Ravi" }],
      ledgers: [{ ledger_id: 77, ledger: "Suspense", unresolved_paise: 675990, side: "dr" }],
    });
  });
  it("reports a credit balance on the cr side", async () => {
    m.list.mockResolvedValue([adj(4)]);
    expect(await suspenseStatus(1, tree("6759.90"))).toMatchObject({ unresolved_paise: 675990, side: "cr" });
  });
});

describe("suspenseStatus across several ledgers", () => {
  it("reports an older ledger that is non-zero while the newest is clear", async () => {
    m.list.mockResolvedValue([adj(9, "Suspense 2", "Ravi", 78), adj(4)]);
    const r = await suspenseStatus(1, two(-100, 0));
    expect(r).toMatchObject({ unresolved_paise: 10000, side: "dr", ledger: "Suspense", corrections: [{ ref: "ACZ-4", approved_by: "Asha" }] });
    expect(r?.ledgers).toEqual([{ ledger_id: 77, ledger: "Suspense", unresolved_paise: 10000, side: "dr" }]);
  });
  it("lists two non-zero ledgers with the signed sum", async () => {
    m.list.mockResolvedValue([adj(9, "Suspense 2", "Ravi", 78), adj(4)]);
    const r = await suspenseStatus(1, two(-100, -50));
    expect(r).toMatchObject({ unresolved_paise: 15000, side: "dr", ledger: "Suspense 2, Suspense" });
    expect(r?.ledgers).toHaveLength(2);
    expect(r?.corrections.map((c) => c.ref)).toEqual(["ACZ-9", "ACZ-4"]);
  });
  it("stays non-null when two ledgers net to zero", async () => {
    m.list.mockResolvedValue([adj(9, "Suspense 2", "Ravi", 78), adj(4)]);
    expect(await suspenseStatus(1, two(-100, 100))).toMatchObject({ unresolved_paise: 0, side: "dr" });
  });
  it("treats a ledger missing from the tree as zero", async () => {
    m.list.mockResolvedValue([adj(4, "Gone", "Asha", 999)]);
    expect(await suspenseStatus(1, tree(-5))).toBeNull();
  });
});

describe("suspenseField", () => {
  it("returns an error marker, not null, when the lookup fails", async () => {
    m.list.mockRejectedValue(new Error("db down"));
    expect(await suspenseField(1, tree(-1))).toEqual({ error: SUSPENSE_CHECK_FAILED });
  });
});
