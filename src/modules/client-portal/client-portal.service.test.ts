import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";
import type { ClientContext } from "./client-portal.types.js";

const m = vi.hoisted(() => ({
  conn: { tag: "tx" },
  lockOpenRequest: vi.fn(),
  insertDocument: vi.fn(),
  fulfilRequest: vi.fn(),
  findDocumentForRequest: vi.fn(),
  linkDocumentToRequest: vi.fn(),
  assertUploadFolder: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../../utils/file-storage.js", () => ({ saveFile: m.saveFile, deleteFile: m.deleteFile, openFile: vi.fn() }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../notifications/notification.service.js", () => ({ notifyDocumentReceived: vi.fn() }));
vi.mock("../document-folders/document-folder.service.js", () => ({ assertUploadFolder: m.assertUploadFolder, listDocumentShares: vi.fn() }));
vi.mock("../communication/communication.repository.js", () => ({}));
vi.mock("../communication/communication.service.js", () => ({}));
vi.mock("../integrations/integration.repository.js", () => ({}));
vi.mock("../engagements/engagement.repository.js", () => ({}));
vi.mock("../onboarding/onboarding.service.js", () => ({}));
vi.mock("../onboarding/onboarding.repository.js", () => ({}));
vi.mock("../onboarding/onboarding.sync.js", () => ({}));
vi.mock("../package-changes/package-change.repository.js", () => ({}));
vi.mock("../packages/package.repository.js", () => ({}));
vi.mock("./client-portal.repository.js", () => ({
  lockOpenRequest: m.lockOpenRequest,
  insertDocument: m.insertDocument,
  fulfilRequest: m.fulfilRequest,
  findDocumentForRequest: m.findDocumentForRequest,
  linkDocumentToRequest: m.linkDocumentToRequest,
}));

const service = await import("./client-portal.service.js");

const owner = { id: 21, role: "client_owner" } as unknown as AuthUser;
const ctx = { userId: 21, clientId: 3, clientName: "ABC" } as ClientContext;
const file = { originalname: "march.pdf", buffer: Buffer.from(""), mimetype: "application/pdf", size: 10 } as Express.Multer.File;
const request = { id: 90, description: "Bank statements", requested_by: 7, period: "2026-11", folder_id: 41 };

beforeEach(() => {
  vi.clearAllMocks();
  m.saveFile.mockResolvedValue("key");
  m.insertDocument.mockResolvedValue(500);
  m.lockOpenRequest.mockResolvedValue(request);
});

describe("files sent for a request land in the request's folder", () => {
  it("a new upload against the request goes into its folder", async () => {
    await service.uploadDocument(owner, ctx, { category: "bank_statement", request_id: 90 }, file);
    expect(m.insertDocument).toHaveBeenCalledWith(expect.objectContaining({ requestId: 90, folderId: 41 }), m.conn);
    expect(m.fulfilRequest).toHaveBeenCalledWith(90, m.conn);
  });

  it("a folder the client picked wins; a request without a folder leaves the file at the top level", async () => {
    await service.uploadDocument(owner, ctx, { category: "other", request_id: 90, folder_id: 12 }, file);
    expect(m.insertDocument).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: 12 }), m.conn);
    m.lockOpenRequest.mockResolvedValueOnce({ ...request, folder_id: null });
    await service.uploadDocument(owner, ctx, { category: "other", request_id: 90 }, file);
    expect(m.insertDocument).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: null }), m.conn);
  });

  it("an existing file is linked where it is; a copy (file already sent for another request) goes into the folder", async () => {
    const doc = { id: 8, file_name: "a.pdf", file_path: "k", mime_type: null, size_bytes: 1, category: "other", period: null, folder_id: 5, request_id: null };
    m.findDocumentForRequest.mockResolvedValueOnce(doc);
    await service.attachExistingDocument(owner, ctx, 90, 8);
    expect(m.linkDocumentToRequest).toHaveBeenCalledWith(8, 90, m.conn);
    expect(m.insertDocument).not.toHaveBeenCalled();

    m.findDocumentForRequest.mockResolvedValueOnce({ ...doc, request_id: 70 });
    await service.attachExistingDocument(owner, ctx, 90, 8);
    expect(m.insertDocument).toHaveBeenCalledWith(expect.objectContaining({ requestId: 90, folderId: 41 }), m.conn);
  });
});
