import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../utils/app-error.js";
import { allVoucherSearch, branchesAll, ledgerById, ledgerGroupsAll, voucherTypesForJournal } from "./__fixtures__/journl-shapes.js";

const m = vi.hoisted(() => ({ journlGet: vi.fn(), queryOne: vi.fn() }));
vi.mock("../integrations/journl.gateway.js", () => ({ journlGet: m.journlGet }));
vi.mock("../../database/connection.js", () => ({ queryOne: m.queryOne, query: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() }));

const { previewJournal, previewOpening, suspenseAmount, previewSuspense, BILL_WISE_BLOCKED, PERIOD_CLOSED } = await import("./correction.preview.js");
const { journalCorrectionSchema, openingCorrectionSchema, rupeesToPaise, formatRupees } = await import("./correction.validation.js");
const books = await import("./journl-books.js");

const SESSION = { token: "owner-token", companyId: "218" };
const CLIENT = 42;

type Ledger = typeof ledgerById;
const ledger = (id: number, name: string, extra: Partial<Ledger> = {}): Ledger => ({ ...ledgerById, id, name, ...extra });

let ledgers: Record<number, Ledger>;
let tb: unknown[];
let groups: unknown[];
let calls: { path: string; query: Record<string, unknown> }[];

/** Trial balance with top-level groups whose closingBalance sum is `diffRupees`; ledgers as leaves. */
const tbWith = (leaves: { id: number; name: string; closing: number }[], diffRupees = 0) => {
  const total = leaves.reduce((s, l) => s + Math.round(l.closing * 100), 0);
  return [
    { id: 3, name: "Current Liabilities", closingBalance: total / 100, children: leaves.map((l) => ({ id: l.id, ledgerName: l.name, closingBalance: l.closing })) },
    { id: 4, name: "Balancing", closingBalance: (Math.round(diffRupees * 100) - total) / 100, children: [] },
  ];
};

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  ledgers = {
    28: ledger(28, "ABC Mobiles Supplier"),
    29: ledger(29, "ABC Mobiles Supplier 2"),
    30: ledger(30, "ABC Mobiles Supplier 3"),
    40: ledger(40, "Cash", { groupId: 18, primaryGroupId: 18, openingBalance: 0, transactionType: "receivable" }),
    50: ledger(50, "Suspense A/c", { groupId: 9, primaryGroupId: 9, openingBalance: 0, transactionType: "payable" }),
    51: ledger(51, "Suspense deposit", { groupId: 15, primaryGroupId: 15, openingBalance: 0, transactionType: "payable" }),
  };
  tb = tbWith([{ id: 28, name: "ABC Mobiles Supplier", closing: 50000 }, { id: 40, name: "Cash", closing: -1200.5 }], 0);
  groups = ledgerGroupsAll;
  m.queryOne.mockResolvedValue(null);
  m.journlGet.mockImplementation(async (_token: string, path: string, query: Record<string, unknown> = {}) => {
    calls.push({ path, query });
    if (path.startsWith("companyMaster/")) return { kind: "ok", data: { id: 218, startDate: "2026-03-31T18:30:00.000Z" } }; // 1 Apr 2026 IST
    const lm = /^companyLedgerMaster\/id\/(\d+)$/.exec(path);
    if (lm) {
      const l = ledgers[Number(lm[1])];
      return l ? { kind: "ok", data: l } : { kind: "failed", reason: "JournL: Company Ledger Master not found" };
    }
    if (path === "defaultAccountingGroups/trial-balance") return { kind: "ok", data: tb };
    if (path === "ledgerGroup/all") return { kind: "ok", data: groups };
    if (path === "company-branch/all") return { kind: "ok", data: branchesAll };
    if (path === "company-voucher-types/primary-voucher-id/3") return { kind: "ok", data: voucherTypesForJournal };
    // The fixture's sample page holds 1 of its 2 hits; serve it as the complete result.
    if (path === "transaction/all-voucher") return { kind: "ok", data: { ...allVoucherSearch, total: allVoucherSearch.result.length } };
    return { kind: "failed", reason: `unexpected ${path}` };
  });
});

const line = (ledger_id: number, side: "dr" | "cr", amount: string | number) => ({ ledger_id, side, amount });
const journal = (lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) => ({ voucher_date: "2026-10-15", reason: "Fix duplicate opening", lines, ...extra });
const parseJournal = (input: unknown) => journalCorrectionSchema.safeParse(input);
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message));

const rejectsWith = async (p: Promise<unknown>, status: number, message: string | RegExp) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (typeof message === "string") expect((err as AppError).message).toBe(message);
  else expect((err as AppError).message).toMatch(message);
};

describe("money helpers", () => {
  it("converts rupees to paise exactly and formats Indian grouping", () => {
    expect(rupeesToPaise("264141.50")).toBe(26414150);
    expect(rupeesToPaise(0.1)).toBe(10);
    expect(rupeesToPaise(88047.17)).toBe(8804717);
    expect(rupeesToPaise("1.005")).toBeNull();
    expect(rupeesToPaise(1e-7)).toBeNull();
    expect(formatRupees(26414150)).toBe("2,64,141.50");
    expect(books.toPaise(-1200.5)).toBe(-120050);
    expect(books.toPaise("50000")).toBe(5000000);
  });
});

describe("journal schema", () => {
  it("rejects a journal with no debit line or no credit line", () => {
    expect(messages(parseJournal(journal([line(28, "cr", 10), line(29, "cr", 10)])))).toContain("Add at least one debit line");
    expect(messages(parseJournal(journal([line(28, "dr", 10), line(29, "dr", 10)])))).toContain("Add at least one credit line");
  });

  it("rejects amounts that are zero, negative or have more than 2 decimals", () => {
    expect(messages(parseJournal(journal([line(28, "dr", 0), line(29, "cr", 0)])))).toContain("Amount must be more than zero");
    expect(parseJournal(journal([line(28, "dr", -5), line(29, "cr", -5)])).success).toBe(false);
    expect(messages(parseJournal(journal([line(28, "dr", "10.005"), line(29, "cr", "10.005")])))).toContain("Enter an amount in rupees with at most 2 decimals");
    expect(parseJournal(journal([line(28, "dr", 10.123), line(29, "cr", 10.123)])).success).toBe(false);
  });

  it("rejects unequal totals with the exact message", () => {
    expect(messages(parseJournal(journal([line(28, "dr", "1000"), line(29, "cr", "999.99")])))).toContain("Debits ₹1,000.00 and credits ₹999.99 must be equal");
  });

  it("accepts 0.10 + 0.20 Dr against 0.30 Cr exactly in paise", () => {
    const r = parseJournal(journal([line(28, "dr", 0.1), line(29, "dr", 0.2), line(30, "cr", 0.3)]));
    expect(r.success).toBe(true);
    expect(r.data!.lines.map((l) => l.amount_paise)).toEqual([10, 20, 30]);
  });

  it("accepts ₹2,64,141.50 Cr against 88,047.17 + 88,047.17 + 88,047.16 Dr", () => {
    const r = parseJournal(journal([line(28, "dr", "88047.17"), line(29, "dr", 88047.17), line(30, "dr", "88047.16"), line(40, "cr", "264141.50")]));
    expect(r.success).toBe(true);
  });

  it("rejects the same ledger on both sides", () => {
    expect(messages(parseJournal(journal([line(28, "dr", 5), line(28, "cr", 5)])))).toContain("A ledger can't be on both the debit and the credit side");
  });

  it("requires a reason", () => {
    expect(messages(parseJournal(journal([line(28, "dr", 5), line(29, "cr", 5)], { reason: "   " })))).toContain("A reason is required");
    expect(parseJournal({ voucher_date: "2026-10-15", lines: [line(28, "dr", 5), line(29, "cr", 5)] }).success).toBe(false);
  });
});

describe("previewJournal", () => {
  const payload = (lines: ReturnType<typeof line>[], date = "2026-10-15") => {
    const r = parseJournal(journal(lines, { voucher_date: date }));
    if (!r.success) throw new Error(JSON.stringify(r.error.issues));
    return { voucher_date: r.data.voucher_date, lines: r.data.lines };
  };

  it("shows signed before/after closing balances as of the voucher date and an unchanged difference", async () => {
    tb = tbWith([{ id: 28, name: "ABC Mobiles Supplier", closing: 50000 }, { id: 40, name: "Cash", closing: -1200.5 }], 1567.59);
    const res = await previewJournal(SESSION, CLIENT, payload([line(28, "dr", "50000"), line(40, "cr", "50000")]));
    expect(res.before).toEqual([
      { ledger_id: 28, ledger_name: "ABC Mobiles Supplier", before_paise: 5000000, after_paise: 5000000 },
      { ledger_id: 40, ledger_name: "Cash", before_paise: -120050, after_paise: -120050 },
    ]);
    expect(res.after).toEqual([
      { ledger_id: 28, ledger_name: "ABC Mobiles Supplier", before_paise: 5000000, after_paise: 0 },
      { ledger_id: 40, ledger_name: "Cash", before_paise: -120050, after_paise: 4879950 },
    ]);
    expect(res.tb_difference_before).toBe(156759);
    expect(res.tb_difference_after).toBe(156759);
    const tbCall = calls.find((c) => c.path === "defaultAccountingGroups/trial-balance")!;
    expect(tbCall.query).toMatchObject({ startDate: "2026-04-01", endDate: "2026-10-15", companyStartDate: "2026-04-01", allBranches: true });
  });

  it("accepts the three-way split exactly and fills ledger names from JournL", async () => {
    const res = await previewJournal(SESSION, CLIENT, payload([line(28, "dr", "88047.17"), line(29, "dr", "88047.17"), line(30, "dr", "88047.16"), line(40, "cr", "264141.50")]));
    expect(res.payload.lines.map((l) => l.ledger_name)).toEqual(["ABC Mobiles Supplier", "ABC Mobiles Supplier 2", "ABC Mobiles Supplier 3", "Cash"]);
    expect(res.after.find((r) => r.ledger_id === 40)!.after_paise).toBe(-120050 + 26414150);
  });

  it("rejects unbalanced lines even when they bypass the schema", async () => {
    await rejectsWith(
      previewJournal(SESSION, CLIENT, { voucher_date: "2026-10-15", lines: [{ ledger_id: 28, ledger_name: "", side: "dr", amount_paise: 100000 }, { ledger_id: 40, ledger_name: "", side: "cr", amount_paise: 99999 }] }),
      400,
      "Debits ₹1,000.00 and credits ₹999.99 must be equal",
    );
  });

  it("rejects an unknown ledger id", async () => {
    await rejectsWith(previewJournal(SESSION, CLIENT, payload([line(999, "dr", 5), line(40, "cr", 5)])), 400, "Ledger 999 isn't in this client's JournL books");
  });

  it("rejects a date before the books start", async () => {
    await rejectsWith(previewJournal(SESSION, CLIENT, payload([line(28, "dr", 5), line(40, "cr", 5)], "2026-03-31")), 400, /before the start of this client's books/);
  });

  it("rejects a date in a month Accountanz has closed for the client", async () => {
    m.queryOne.mockResolvedValue({ status: "closed" });
    await rejectsWith(previewJournal(SESSION, CLIENT, payload([line(28, "dr", 5), line(40, "cr", 5)])), 400, PERIOD_CLOSED);
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining("period_closings"), [CLIENT, "2026-10"]);
  });

  it("allows a month whose closing row is only ready", async () => {
    m.queryOne.mockResolvedValue({ status: "ready" });
    await expect(previewJournal(SESSION, CLIENT, payload([line(28, "dr", 5), line(40, "cr", 5)]))).resolves.toBeTruthy();
  });

  it("maps an expired JournL session to 409 and a failed read to 503", async () => {
    m.journlGet.mockResolvedValueOnce({ kind: "expired" });
    await rejectsWith(previewJournal(SESSION, CLIENT, payload([line(28, "dr", 5), line(40, "cr", 5)])), 409, books.SESSION_EXPIRED);
    m.journlGet.mockResolvedValueOnce({ kind: "failed", reason: "JournL: down" });
    await rejectsWith(previewJournal(SESSION, CLIENT, payload([line(28, "dr", 5), line(40, "cr", 5)])), 503, "JournL: down");
  });
});

describe("opening schema and previewOpening", () => {
  const opening = (ledger_id: number, amount: string | number, side: "dr" | "cr") => {
    const r = openingCorrectionSchema.safeParse({ ledger_id, amount, side, reason: "Duplicate opening" });
    if (!r.success) throw new Error(r.error.issues[0].message);
    return { ledger_id: r.data.ledger_id, ledger_name: r.data.ledger_name, amount_paise: r.data.amount_paise, side: r.data.side };
  };

  it("rejects a negative amount at the schema and in the preview", async () => {
    expect(openingCorrectionSchema.safeParse({ ledger_id: 28, amount: -1, side: "cr", reason: "x" }).success).toBe(false);
    expect(openingCorrectionSchema.safeParse({ ledger_id: 28, amount: "-1", side: "cr", reason: "x" }).success).toBe(false);
    await rejectsWith(previewOpening(SESSION, { ledger_id: 28, ledger_name: "", amount_paise: -100, side: "cr" }), 400, "The opening balance can't be negative");
  });

  it("accepts zero at the schema", () => {
    expect(opening(28, 0, "cr").amount_paise).toBe(0);
  });

  it("rejects an unchanged amount and side", async () => {
    await rejectsWith(previewOpening(SESSION, opening(28, "50000", "cr")), 400, "The new opening balance is the same as the current one");
  });

  it("projects the difference: after = before − (old signed − new signed)", async () => {
    tb = tbWith([{ id: 28, name: "ABC Mobiles Supplier", closing: 50000 }], 150000);
    const res = await previewOpening(SESSION, opening(28, 0, "cr"));
    expect(res.before).toEqual({ ledger_id: 28, ledger_name: "ABC Mobiles Supplier", amount_paise: 5000000, side: "cr" });
    expect(res.after).toEqual({ ledger_id: 28, ledger_name: "ABC Mobiles Supplier", amount_paise: 0, side: "cr" });
    expect(res.tb_difference_before).toBe(15000000);
    expect(res.tb_difference_after).toBe(15000000 - (5000000 - 0));

    const flip = await previewOpening(SESSION, opening(28, "500", "dr"));
    expect(flip.tb_difference_after).toBe(15000000 - (5000000 - -50000));
  });

  it.each([
    ["bill-wise with no opening bills", { enableBillWise: 1, openingBillEntry: [] }],
    ["bill-wise with one opening bill", { enableBillWise: 1, openingBillEntry: [{ id: 1, billNo: "B1", entryDate: "2026-04-01", dueDate: "2026-05-01", amount: 50000, settledAmount: "0" }] }],
    ["not bill-wise but carrying an opening bill", { enableBillWise: 0, openingBillEntry: [{ id: 1, billNo: "B1", entryDate: "2026-04-01", dueDate: "2026-05-01", amount: 50000, settledAmount: "0" }] }],
  ])("blocks a ledger that is %s", async (_label, extra) => {
    ledgers[28] = ledger(28, "ABC Mobiles Supplier", extra as Partial<Ledger>);
    await rejectsWith(previewOpening(SESSION, opening(28, 0, "cr")), 400, BILL_WISE_BLOCKED);
    expect(BILL_WISE_BLOCKED).toBe("This ledger tracks opening balances bill by bill; correct it in JournL.");
  });

  it("rejects an unknown ledger", async () => {
    await rejectsWith(previewOpening(SESSION, opening(999, 1, "cr")), 400, "Ledger 999 isn't in this client's JournL books");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["not a list", { 0: "x" }],
  ])("blocks (400) when JournL's opening bill list is %s", async (_label, list) => {
    const l = ledger(28, "ABC Mobiles Supplier") as Record<string, unknown>;
    if (list === undefined) delete l.openingBillEntry;
    else l.openingBillEntry = list;
    ledgers[28] = l as Ledger;
    await rejectsWith(previewOpening(SESSION, opening(28, 0, "cr")), 400, "JournL didn't return the ledger's opening bills; correct it in JournL");
  });

  it("blocks a Suspense ledger whose opening bill list is missing", async () => {
    const l = { ...ledgers[50] } as Record<string, unknown>;
    delete l.openingBillEntry;
    ledgers[50] = l as Ledger;
    tb = tbWith([{ id: 28, name: "ABC Mobiles Supplier", closing: 50000 }], 100);
    await rejectsWith(previewSuspense(SESSION, CLIENT, 50), 400, "JournL didn't return the ledger's opening bills; correct it in JournL");
  });
});

describe("Suspense", () => {
  it("offsets the current difference: credits exceed → dr", async () => {
    tb = tbWith([], 1567.59);
    await expect(suspenseAmount(SESSION)).resolves.toEqual({ amount_paise: 156759, side: "dr" });
    tb = tbWith([], -10.01);
    await expect(suspenseAmount(SESSION)).resolves.toEqual({ amount_paise: 1001, side: "cr" });
  });

  it("returns 409 when the trial balance already balances", async () => {
    tb = tbWith([], 0);
    await rejectsWith(suspenseAmount(SESSION), 409, "The trial balance already balances");
  });

  it("previews the matched Suspense ledger with its id, name and group, and a zero difference after", async () => {
    tb = tbWith([], 1567.59);
    const res = await previewSuspense(SESSION, CLIENT, 50);
    expect(res.ledger).toEqual({ id: 50, name: "Suspense A/c", group_id: 9, group_name: "Suspense A/c" });
    expect(res).toMatchObject({ amount_paise: 156759, side: "dr", tb_difference_before: 156759, tb_difference_after: 0 });
    expect(res.after).toEqual({ ledger_id: 50, ledger_name: "Suspense A/c", amount_paise: 156759, side: "dr" });
  });

  it("moves an existing Suspense opening by the offset", async () => {
    ledgers[50] = ledger(50, "Suspense A/c", { groupId: 9, primaryGroupId: 9, openingBalance: 1000, transactionType: "payable" });
    tb = tbWith([], 1567.59);
    const res = await previewSuspense(SESSION, CLIENT, 50);
    expect(res.after).toEqual({ ledger_id: 50, ledger_name: "Suspense A/c", amount_paise: 156759 - 100000, side: "dr" });
    expect(res.tb_difference_after).toBe(0);
  });

  it("rejects a ledger outside the Suspense group, even one named Suspense", async () => {
    tb = tbWith([], 1567.59);
    await rejectsWith(previewSuspense(SESSION, CLIENT, 51), 400, "Choose a ledger in a Suspense group. Create one in JournL first if there is none.");
    await rejectsWith(previewSuspense(SESSION, CLIENT, 40), 400, "Choose a ledger in a Suspense group. Create one in JournL first if there is none.");
  });

  it("uses the per-client Suspense group override", async () => {
    tb = tbWith([], 1567.59);
    groups = [...ledgerGroupsAll, { id: 77, name: "Suspense (old)", isDeleted: 0 }];
    ledgers[52] = ledger(52, "Old suspense", { groupId: 77, primaryGroupId: 9 });
    m.queryOne.mockResolvedValue({ journl_corrections_suspense_group_id: 77 });
    const res = await previewSuspense(SESSION, CLIENT, 52);
    expect(res.ledger.group_id).toBe(77);
    await rejectsWith(previewSuspense(SESSION, CLIENT, 51), 400, "Choose a ledger in a Suspense group. Create one in JournL first if there is none.");
  });

  it("blocks when the configured group is not a live Suspense group in this company", async () => {
    groups = [{ id: 9, name: "Suspense A/c", isDeleted: 1 }];
    await rejectsWith(previewSuspense(SESSION, CLIENT, 50), 400, /is not a Suspense group/);
    groups = [{ id: 9, name: "Misc", isDeleted: 0 }];
    await rejectsWith(previewSuspense(SESSION, CLIENT, 50), 400, /is not a Suspense group/);
  });

  it("suspenseCheck matches by group id or primary group id only", () => {
    expect(books.suspenseCheck({ groupId: 9, primaryGroupId: 9 }, 9, ledgerGroupsAll)).toEqual({ ok: true });
    expect(books.suspenseCheck({ groupId: 31, primaryGroupId: 9 }, 9, ledgerGroupsAll)).toEqual({ ok: true });
    expect(books.suspenseCheck({ groupId: 15, primaryGroupId: 15 }, 9, ledgerGroupsAll)).toEqual({ ok: false, reason: books.NOT_SUSPENSE });
    expect(books.suspenseCheck({ groupId: 9, primaryGroupId: 9 }, 9, [])).toMatchObject({ ok: false });
  });
});

describe("journl-books helpers", () => {
  it("reads branches, the opening entry branch, the Journal voucher type and a voucher by exact ref", async () => {
    await expect(books.branches("t")).resolves.toEqual([
      { id: 7, name: "Branch A" },
      { id: 3, name: "Branch B" },
      { id: 1, name: "Head Office" },
    ]);
    await expect(books.openingEntryBranch("t", 28)).resolves.toBe(1);
    await expect(books.journalVoucherType("t")).resolves.toEqual({ voucherTypeId: 3, primaryVoucherTypeId: 3 });
    await expect(books.findVoucherByRef("t", "37")).resolves.toEqual([{ id: "102" }]);
    await expect(books.findVoucherByRef("t", "3")).resolves.toEqual([]);
    expect(calls.find((c) => c.path === "transaction/all-voucher")!.query).toMatchObject({ searchQuery: "37", allBranches: true, page: 1, limit: 100 });
  });

  it("finds a ledger's closing in the tree by id and name, and treats a missing ledger as zero", () => {
    const tree = tbWith([{ id: 28, name: "ABC Mobiles Supplier", closing: 50000 }], 0);
    expect(books.ledgerClosingOf(tree, 28, "ABC Mobiles Supplier")).toBe(5000000);
    expect(books.ledgerClosingOf(tree, 3)).toBe(0); // group id 3 is not a ledger
    expect(books.ledgerClosingOf(tree, 28, "Someone else")).toBe(0); // no ledgerId on these leaves: the name guard applies
    expect(books.tbDifferenceOf([{ closingBalance: 0.1 }, { closingBalance: 0.2 }, { closingBalance: -0.3 }])).toBe(0);
  });

  it("refuses to read an unreadable amount as zero", () => {
    expect(() => books.tbDifferenceOf([{ closingBalance: "1,234.00" }])).toThrow(AppError);
    expect(books.toPaise(null)).toBe(0);
  });
});

describe("live trial-balance shape (company 218, verified 2026-11-18)", () => {
  // Nested groups; ledger leaves carry ledgerId; leaf `id` values differ from the ledger ids and collide with group ids;
  // the three suppliers share one name. Sum of top-level closingBalance = +1,56,759.90 (credits exceed).
  const liveTb = () => [
    {
      id: 3, name: "Current Liabilities", closingBalance: 150000,
      children: [
        {
          id: 29, name: "Sundry Creditors", closingBalance: 150000,
          children: [
            { id: 3, ledgerId: 28, ledgerName: "ABC Mobiles Supplier", name: "ABC Mobiles Supplier", closingBalance: 50000 },
            { id: 4, ledgerId: 29, ledgerName: "ABC Mobiles Supplier", name: "ABC Mobiles Supplier", closingBalance: 50000 },
            { id: 5, ledgerId: 30, ledgerName: "ABC Mobiles Supplier", name: "ABC Mobiles Supplier", closingBalance: 50000 },
          ],
        },
      ],
    },
    { id: 1, name: "Capital Account", closingBalance: 10000, children: [{ id: 6, ledgerId: 1, ledgerName: "Capital", closingBalance: 10000 }] },
    { id: 18, name: "Current Assets", closingBalance: -3240.1, children: [{ id: 7, ledgerId: 40, ledgerName: "Cash", closingBalance: -3240.1 }] },
  ];

  it("picks each same-named supplier leaf by ledgerId, not by leaf id or name", () => {
    const tree = liveTb() as never;
    expect(books.tbDifferenceOf(tree)).toBe(15675990);
    expect(books.ledgerClosingOf(tree, 28, "ABC Mobiles Supplier")).toBe(5000000);
    expect(books.ledgerClosingOf(tree, 29, "ABC  Mobiles Supplier (label differs)")).toBe(5000000); // id only when ledgerId exists
    expect(books.ledgerClosingOf(tree, 40)).toBe(-324010);
    expect(books.ledgerClosingOf(tree, 4)).toBe(0); // a leaf's own id is not a ledger id
  });

  it("zeroing ledger 29's 50,000 Cr opening moves the difference from 1,56,759.90 to 1,06,759.90", async () => {
    tb = liveTb();
    ledgers[29] = ledger(29, "ABC Mobiles Supplier");
    const res = await previewOpening(SESSION, { ledger_id: 29, ledger_name: "", amount_paise: 0, side: "cr" });
    expect(res.tb_difference_before).toBe(15675990);
    expect(res.tb_difference_after).toBe(10675990);
    expect(res.before).toEqual({ ledger_id: 29, ledger_name: "ABC Mobiles Supplier", amount_paise: 5000000, side: "cr" });
  });

  it("shows ledger 29's own closing in a journal preview", async () => {
    tb = liveTb();
    ledgers[29] = ledger(29, "ABC Mobiles Supplier");
    const res = await previewJournal(SESSION, CLIENT, {
      voucher_date: "2026-10-15",
      lines: [
        { ledger_id: 29, ledger_name: "", side: "dr", amount_paise: 5000000 },
        { ledger_id: 40, ledger_name: "", side: "cr", amount_paise: 5000000 },
      ],
    });
    expect(res.after).toEqual([
      { ledger_id: 29, ledger_name: "ABC Mobiles Supplier", before_paise: 5000000, after_paise: 0 },
      { ledger_id: 40, ledger_name: "Cash", before_paise: -324010, after_paise: 4675990 },
    ]);
    expect(res.tb_difference_after).toBe(15675990);
  });
});

describe("findVoucherByRef", () => {
  const row = (id: number, invoiceNo: string) => ({ id, invoiceNo, voucherNo: String(id) });
  /** Serves `all` as JournL would: paged by page/limit, with the full total on every page. */
  const serve = (all: { id: number; invoiceNo: string }[], over: Partial<{ total: number; failOnPage: number; expiredOnPage: number }> = {}) =>
    m.journlGet.mockImplementation(async (_t: string, path: string, q: Record<string, number>) => {
      calls.push({ path, query: q });
      if (q.page === over.failOnPage) return { kind: "failed", reason: "JournL: Company not found" };
      if (q.page === over.expiredOnPage) return { kind: "expired" };
      const start = (q.page - 1) * q.limit;
      return { kind: "ok", data: { total: over.total ?? all.length, page: q.page, limit: q.limit, result: all.slice(start, start + q.limit) } };
    });

  it("matches invoiceNo exactly: ACZ-1 never matches ACZ-10 or ACZ-100", async () => {
    serve([row(1, "ACZ-10"), row(2, "ACZ-100"), row(3, "ACZ-1"), row(4, "XACZ-1"), row(5, "ACZ-1 ")]);
    await expect(books.findVoucherByRef("t", "ACZ-1")).resolves.toEqual([{ id: "3" }]);
  });

  it("pages through every result and returns all exact matches", async () => {
    const all = Array.from({ length: 250 }, (_, i) => row(1000 + i, `ACZ-1${i}`));
    all[180] = row(5000, "ACZ-1");
    all[249] = row(5001, "ACZ-1");
    serve(all);
    await expect(books.findVoucherByRef("t", "ACZ-1")).resolves.toEqual([{ id: "5000" }, { id: "5001" }]);
    expect(calls.filter((c) => c.path === "transaction/all-voucher").map((c) => c.query.page)).toEqual([1, 2, 3]);
  });

  it("returns an empty list only after seeing every result", async () => {
    serve([]);
    await expect(books.findVoucherByRef("t", "ACZ-7")).resolves.toEqual([]);
    serve([row(1, "ACZ-70")]);
    await expect(books.findVoucherByRef("t", "ACZ-7")).resolves.toEqual([]);
  });

  it("throws instead of answering none on any failed or expired read, even a not-found message", async () => {
    serve([row(1, "ACZ-70")], { failOnPage: 1 });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, "JournL: Company not found");
    serve(Array.from({ length: 150 }, (_, i) => row(i + 1, "X")), { expiredOnPage: 2 });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 409, books.SESSION_EXPIRED);
    serve(Array.from({ length: 150 }, (_, i) => row(i + 1, "X")), { failOnPage: 2 });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, "JournL: Company not found");
  });

  it("asks for a fixed order", async () => {
    serve([row(1, "ACZ-7")]);
    await books.findVoucherByRef("t", "ACZ-7");
    expect(calls.at(-1)!.query).toMatchObject({ sortBy: "voucherDate", sortOrder: "ASC" });
  });

  it("throws when the server ignores the page parameter (same rows every time)", async () => {
    const first = Array.from({ length: 100 }, (_, i) => row(i + 1, "X"));
    m.journlGet.mockImplementation(async (_t: string, path: string, q: Record<string, number>) => {
      calls.push({ path, query: q });
      return { kind: "ok", data: { total: 150, result: first } };
    });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, /ended before every result was read/);
    expect(calls.filter((c) => c.path === "transaction/all-voucher")).toHaveLength(2);
  });

  it("counts distinct ids: rows repeated across pages neither fake completeness nor duplicate matches", async () => {
    // 3 distinct vouchers, total 3; page 1 = [1, 2], page 2 = [2 again], page 3 = [3].
    const pages: Record<number, { id: number; invoiceNo: string }[]> = { 1: [row(1, "X"), row(2, "ACZ-7")], 2: [row(2, "ACZ-7")], 3: [row(3, "ACZ-7")] };
    m.journlGet.mockImplementation(async (_t: string, path: string, q: Record<string, number>) => {
      calls.push({ path, query: q });
      return { kind: "ok", data: { total: 3, result: pages[q.page] ?? [] } };
    });
    // Page 2 adds no new id → fail closed rather than guess.
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, /ended before every result was read/);

    // A partial overlap that still adds new ids completes, with each match once.
    pages[2] = [row(2, "ACZ-7"), row(3, "ACZ-7")];
    await expect(books.findVoucherByRef("t", "ACZ-7")).resolves.toEqual([{ id: "2" }, { id: "3" }]);
  });

  it("throws when the pages run out before the reported total", async () => {
    serve([row(1, "X")], { total: 5 });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, /ended before every result was read/);
  });

  it("throws on a body without a total or result list", async () => {
    m.journlGet.mockResolvedValue({ kind: "ok", data: { result: [] } });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, /shape/);
    m.journlGet.mockResolvedValue({ kind: "ok", data: { total: 0 } });
    await rejectsWith(books.findVoucherByRef("t", "ACZ-7"), 503, /shape/);
  });
});

describe("getLedger not-found", () => {
  it("is null only for JournL's ledger-not-found answer; other failures throw", async () => {
    await expect(books.getLedger("t", 999)).resolves.toBeNull();
    m.journlGet.mockResolvedValueOnce({ kind: "failed", reason: "JournL: Company not found" });
    await rejectsWith(books.getLedger("t", 28), 503, "JournL: Company not found");
    m.journlGet.mockResolvedValueOnce({ kind: "failed", reason: "JournL answered 404" });
    await rejectsWith(books.getLedger("t", 28), 503, "JournL answered 404");
  });
});

describe("ledger id input", () => {
  it("accepts integers and digit strings only", () => {
    const parse = (ledger_id: unknown) => openingCorrectionSchema.safeParse({ ledger_id, amount: 1, side: "cr", reason: "x" }).success;
    expect(parse(28)).toBe(true);
    expect(parse("28")).toBe(true);
    for (const v of [true, "1e3", "0x1c", 0, -1, 1.5, "", " 28"]) expect(parse(v)).toBe(false);
  });
});

const preview = await import("./correction.preview.js");
const db = await import("../../database/connection.js");
const query = vi.mocked(db.query);

describe("closed months for opening-balance corrections (Task 8)", () => {

  it("queries closed rows from the books start month through the current month (India time)", async () => {
    query.mockResolvedValue([]);
    await expect(preview.assertOpeningMonthsOpen(SESSION, CLIENT)).resolves.toBeUndefined();
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toMatch(/period_closings[\s\S]*status = 'closed'/);
    expect(params).toEqual([CLIENT, "2026-04", preview.todayIst().slice(0, 7)]);
  });

  it("names every closed month and says to reopen", async () => {
    query.mockResolvedValue([{ period: "2026-04" }, { period: "2026-06" }] as never);
    await rejectsWith(preview.assertOpeningMonthsOpen(SESSION, CLIENT), 400, /April 2026, June 2026[\s\S]*Reopen those months/);
  });

  it("the post-time wording points at reopening, or rejecting and preparing a new one (never Prepare again)", () => {
    expect(preview.closedMonthsMessage(["2026-05"], true)).toMatch(/May 2026[\s\S]*Reopen that month in Accountanz, then post this correction; or reject it and prepare a new correction/);
    expect(preview.closedMonthsMessage(["2026-05"], true)).not.toMatch(/Prepare again/);
  });
});
