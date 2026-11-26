import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  conn: { tag: "tx" },
  insertRequest: vi.fn(),
  findRequest: vi.fn(),
  insertDocument: vi.fn(),
  findDocument: vi.fn(),
  taskBelongsToClient: vi.fn(),
  findTaskForRequest: vi.fn(),
  createRequestFolder: vi.fn(),
  assertStaffFolder: vi.fn(),
  moveDocument: vi.fn(),
  canSeeDocument: vi.fn(),
  requireClientAccess: vi.fn(),
  recordAudit: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn(m.conn) }));
vi.mock("../../utils/file-storage.js", () => ({ saveFile: m.saveFile, deleteFile: m.deleteFile, openFile: vi.fn() }));
vi.mock("../access/client-access.js", () => ({ requireClientAccess: m.requireClientAccess, clientScope: () => ({ sql: "1 = 1", params: [] }) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../notifications/notification.service.js", () => ({ notifyDocumentRequested: vi.fn() }));
vi.mock("../document-folders/document-folder.repository.js", () => ({ listFoldersForClients: vi.fn() }));
vi.mock("../document-folders/document-folder.service.js", () => ({
  createRequestFolder: m.createRequestFolder,
  assertStaffFolder: m.assertStaffFolder,
  moveDocument: m.moveDocument,
  canSeeDocument: m.canSeeDocument,
  documentVisibility: () => ({ sql: "1 = 1", params: [] }),
  folderPaths: () => new Map(),
}));
vi.mock("./document.repository.js", () => ({
  insertRequest: m.insertRequest,
  findRequest: m.findRequest,
  insertDocument: m.insertDocument,
  findDocument: m.findDocument,
  taskBelongsToClient: m.taskBelongsToClient,
  findTaskForRequest: m.findTaskForRequest,
}));

const service = await import("./document.service.js");

const accountant = { id: 7, role: "bookkeeper", fullName: "Arun" } as unknown as AuthUser;

beforeEach(() => {
  vi.clearAllMocks();
  m.requireClientAccess.mockResolvedValue(undefined);
  m.findRequest.mockResolvedValue({ id: 90 });
  m.findDocument.mockResolvedValue({ id: 5, client_id: 3, file_path: "k", folder_id: null, request_id: null, from_client: 1 });
});

describe("document requests get a folder", () => {
  it("creates the request folder in the same transaction and saves it on the request", async () => {
    m.createRequestFolder.mockResolvedValue(41);
    m.insertRequest.mockResolvedValue(90);
    m.findTaskForRequest.mockResolvedValue({ id: 9, title: "Bank reconciliation", period: "2026-11" });
    const input = { client_id: 3, description: "Bank statements", period: "2026-11", due_date: null, task_id: 9 };
    await service.createRequest(accountant, input);
    expect(m.createRequestFolder).toHaveBeenCalledWith({ clientId: 3, period: "2026-11", taskTitle: "Bank reconciliation", description: "Bank statements", userId: 7 }, m.conn);
    expect(m.insertRequest).toHaveBeenCalledWith(input, 7, 41, m.conn);
  });

  it("refuses a request whose task isn't this client's, and takes the task's period when none is given", async () => {
    m.findTaskForRequest.mockResolvedValueOnce(undefined);
    await expect(service.createRequest(accountant, { client_id: 3, description: "Bank statements", period: null, due_date: null, task_id: 99 })).rejects.toThrow("another client");
    m.findTaskForRequest.mockResolvedValueOnce({ id: 9, title: "GST review", period: "2026-10" });
    m.createRequestFolder.mockResolvedValue(42);
    await service.createRequest(accountant, { client_id: 3, description: "Sales invoices", period: null, due_date: null, task_id: 9 });
    expect(m.createRequestFolder).toHaveBeenLastCalledWith(expect.objectContaining({ period: "2026-10", taskTitle: "GST review" }), m.conn);
  });
});

describe("staff filing", () => {
  it("an upload into a folder checks the folder and stores it", async () => {
    m.saveFile.mockResolvedValue("key");
    m.insertDocument.mockResolvedValue(5);
    const file = { originalname: "a.pdf", buffer: Buffer.from(""), mimetype: "application/pdf", size: 1 } as Express.Multer.File;
    await service.uploadDocument(accountant, { client_id: 3, category: "other", folder_id: 41 }, file);
    expect(m.assertStaffFolder).toHaveBeenCalledWith(accountant, 3, 41);
    expect(m.insertDocument).toHaveBeenCalledWith(expect.objectContaining({ folder_id: 41 }), expect.anything(), 7, m.conn);
  });

  it("moving needs a document and a target folder this person can see", async () => {
    m.canSeeDocument.mockResolvedValueOnce(false);
    await expect(service.moveToFolder(accountant, 5, { folder_id: 41 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.moveDocument).not.toHaveBeenCalled();
    m.canSeeDocument.mockResolvedValueOnce(true);
    await service.moveToFolder(accountant, 5, { folder_id: 41 });
    expect(m.assertStaffFolder).toHaveBeenCalledWith(accountant, 3, 41);
    expect(m.moveDocument).toHaveBeenCalledWith(accountant, 3, 5, { folder_id: 41 });
  });
});
