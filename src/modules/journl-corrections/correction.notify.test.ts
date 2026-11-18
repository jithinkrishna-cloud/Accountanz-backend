import { beforeEach, describe, expect, it, vi } from "vitest";

/** The posting-outcome notice to the preparer (Task 8). DB and mail mocked. */

const m = vi.hoisted(() => ({ findCorrection: vi.fn(), events: vi.fn(), listApproverContacts: vi.fn(), findActiveContact: vi.fn(), findClientName: vi.fn(), sendMail: vi.fn() }));
vi.mock("./correction.repository.js", () => ({ findCorrection: m.findCorrection, events: m.events, listApproverContacts: m.listApproverContacts }));
vi.mock("../notifications/notification.repository.js", () => ({ findActiveContact: m.findActiveContact, findClientName: m.findClientName }));
vi.mock("../../utils/mailer.js", () => ({ sendMail: m.sendMail }));
vi.mock("../communication/communication.repository.js", () => ({ findMeetingRequest: vi.fn() }));
vi.mock("../tasks/task.repository.js", () => ({ findTask: vi.fn() }));

const { notifyCorrectionOutcome } = await import("../notifications/notification.service.js");

const base = { id: 101, client_id: 42, initiated_by: 7, journl_voucher_id: null, journl_message: null, rejected_by_source: null };

beforeEach(() => {
  vi.resetAllMocks();
  m.findActiveContact.mockResolvedValue({ email: "r@x.in", full_name: "Rahul" });
  m.findClientName.mockResolvedValue("ABC Traders");
});

describe("notifyCorrectionOutcome", () => {
  it.each([
    [{ status: "posted", journl_voucher_id: "9876" }, "posted", /Posted: JournL correction ACZ-101/],
    [{ status: "unknown", journl_message: "JournL did not answer in time" }, "unknown", /Check JournL/],
    [{ status: "rejected", rejected_by_source: "journl", journl_message: "Bad" }, "rejected", /refused/],
    [{ status: "rejected", rejected_by_source: "stale", journl_message: "Branch 5 no longer exists in JournL" }, "rejected", /Cancelled/],
  ])("tells the preparer about %o", async (over, to, subject) => {
    m.findCorrection.mockResolvedValue({ ...base, ...over });
    m.events.mockResolvedValue([{ id: 55, from_status: "posting", to_status: to }]);
    await notifyCorrectionOutcome(101);
    expect(m.findActiveContact).toHaveBeenCalledWith(7);
    expect(m.sendMail).toHaveBeenCalledTimes(1);
    const mail = m.sendMail.mock.calls[0][0];
    expect(mail.to).toBe("r@x.in");
    expect(mail.subject).toMatch(subject);
    expect(mail.idempotencyKey).toBe("correction-outcome/101/55");
  });

  it("nothing for a reviewer rejection or a still-approved correction", async () => {
    for (const over of [{ status: "rejected", rejected_by_source: "reviewer" }, { status: "approved" }]) {
      m.findCorrection.mockResolvedValue({ ...base, ...over });
      m.events.mockResolvedValue([{ id: 1, from_status: "pending_approval", to_status: over.status }]);
      await notifyCorrectionOutcome(101);
    }
    expect(m.sendMail).not.toHaveBeenCalled();
  });

  it("never throws when mail fails", async () => {
    m.findCorrection.mockResolvedValue({ ...base, status: "posted" });
    m.events.mockResolvedValue([{ id: 2, from_status: "posting", to_status: "posted" }]);
    m.sendMail.mockRejectedValue(new Error("smtp down"));
    await expect(notifyCorrectionOutcome(101)).resolves.toBeUndefined();
  });
});
