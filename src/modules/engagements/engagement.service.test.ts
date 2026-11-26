import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  lockEngagement: vi.fn(),
  setStatus: vi.fn(),
  findEngagement: vi.fn(),
  onEngagementActivated: vi.fn(),
  onEngagementEnded: vi.fn(),
  recordAudit: vi.fn(),
  conn: { tag: "tx" },
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../../utils/file-storage.js", () => ({ deleteFile: vi.fn(), openFile: vi.fn(), saveFile: vi.fn() }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../clients/client.repository.js", () => ({ findClientById: vi.fn(), updateClient: vi.fn() }));
vi.mock("../invoices/invoice.repository.js", () => ({ countLiveInvoices: vi.fn(), issueInvoice: vi.fn() }));
vi.mock("../notifications/notification.service.js", () => ({ notifyInvoiceIssued: vi.fn() }));
vi.mock("../packages/package.repository.js", () => ({ findPackageById: vi.fn() }));
vi.mock("../onboarding/onboarding.sync.js", () => ({ syncCaseWithEngagement: vi.fn() }));
vi.mock("../onboarding/onboarding.repository.js", () => ({}));
vi.mock("../projects/client-space-hooks.js", () => ({ onEngagementActivated: m.onEngagementActivated, onEngagementEnded: m.onEngagementEnded }));
vi.mock("./engagement.repository.js", () => ({ lockEngagement: m.lockEngagement, setStatus: m.setStatus, findEngagement: m.findEngagement }));

const { changeStatus } = await import("./engagement.service.js");

const actor = { id: 1, role: "super_admin" } as unknown as AuthUser;

beforeEach(() => {
  vi.clearAllMocks();
  m.findEngagement.mockResolvedValue({ id: 3 });
});

describe("changeStatus → ended", () => {
  it("archives the primary space when an active engagement ends", async () => {
    m.lockEngagement.mockResolvedValue({ id: 3, client_id: 22, status: "active" });
    await changeStatus(actor, 3, { to: "ended" });
    expect(m.onEngagementEnded).toHaveBeenCalledWith(actor, 22, m.conn);
  });

  it.each(["draft", "sent", "accepted"])("leaves the primary space alone when a %s engagement ends", async (status) => {
    m.lockEngagement.mockResolvedValue({ id: 3, client_id: 22, status });
    await changeStatus(actor, 3, { to: "ended" });
    expect(m.setStatus).toHaveBeenCalledWith(3, "ended", m.conn);
    expect(m.onEngagementEnded).not.toHaveBeenCalled();
  });
});
