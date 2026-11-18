// One-off, GET-only probe of JournL response shapes (Task 1). Prints shapes, never the token.
import { openJournlSession } from "file:///C:/Users/Admin/Desktop/accountanz/backend/src/modules/integrations/journl-data.service.ts";
import { journlGet } from "file:///C:/Users/Admin/Desktop/accountanz/backend/src/modules/integrations/journl.gateway.ts";

const PII = /name|gst|email|phone|mobile|address|pan|contact|account|bank|ifsc|pincode/i;
function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return { __array: v.length, first: v.length ? shape(v[0], depth + 1) : null };
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 4 ? typeof x : shape(x, depth + 1)]));
  return v === null ? null : typeof v === "string" ? (v.length > 24 ? "string" : v) : v;
}
const s: any = await openJournlSession(1);
const token = s.token;
console.log("session company", s.companyId, "expires", s.expiresAt);
const show = (label: string, r: any) => console.log("\n##", label, r.kind, r.kind === "ok" ? JSON.stringify(shape(r.data), null, 1) : r.reason ?? "");

const groups = await journlGet<any[]>(token, "ledgerGroup/all");
show("ledgerGroup/all", groups);
if (groups.kind === "ok") {
  const rows: any[] = Array.isArray(groups.data) ? groups.data : [];
  console.log("group count", rows.length);
  console.log("groups:", rows.map((g) => `${g.id}:${g.name}(p${g.parentId})`).join(" | "));
  console.log("Suspense-like groups:", rows.filter((g) => /suspense/i.test(JSON.stringify(g))).map((g) => `${g.id}:${g.name}`));
}
const cred = await journlGet<any[]>(token, "companyLedgerMaster/accounting-groups-ledger", { id: 22 });
show("accounting-groups-ledger?id=22", cred);
const credRows: any[] = cred.kind === "ok" && Array.isArray(cred.data) ? cred.data : [];
const supplier = credRows.find((r) => /ABC Mobiles Supplier/i.test(r.name));
console.log("supplier ledger id:", supplier?.id);
const allLed = await journlGet<any>(token, "companyLedgerMaster/general-ledger", { page: 1, limit: 500 });
if (allLed.kind === "ok") {
  const list: any[] = allLed.data?.result ?? allLed.data ?? [];
  console.log("ledger count", list.length, "Suspense-like ledgers:", list.filter((l) => /suspense/i.test(l.name ?? "")).map((l) => `${l.id}:${l.name}:group${l.groupId}`));
} else show("general-ledger", allLed);
if (supplier) {
  const l: any = await journlGet<any>(token, `companyLedgerMaster/id/${supplier.id}`);
  show("companyLedgerMaster/id", l);
  if (l.kind === "ok") console.log("ledger scalar sample:", JSON.stringify({ openingBalance: l.data.openingBalance, transactionType: l.data.transactionType, groupId: l.data.groupId, primaryGroupId: l.data.primaryGroupId, enableBillWise: l.data.enableBillWise, groupName: l.data.groupName, openingBillEntry: l.data.openingBillEntry }));
}
const vt: any = await journlGet<any>(token, "company-voucher-types/primary-voucher-id/3");
show("voucher types primary 3", vt);
if (vt.kind === "ok") console.log("vt rows:", JSON.stringify(vt.data.map((r: any) => ({ id: r.id, name: r.name, primaryVoucherId: r.primaryVoucherId, isDeleted: r.isDeleted }))));
const br: any = await journlGet<any>(token, "company-branch/all");
show("company-branch/all", br);
if (br.kind === "ok") console.log("branches:", JSON.stringify(br.data.map((b: any) => ({ id: b.id, code: b.code, isDeleted: b.isDeleted }))));
const av: any = await journlGet<any>(token, "transaction/all-voucher", { searchQuery: "36", allBranches: true, page: 1, limit: 5 });
show("all-voucher search", av);
const me: any = await journlGet<any>(token, "companyMaster/" + encodeURIComponent(s.companyId));
console.log("\ncompanyMaster:", me.kind);
void PII;
process.exit(0);
