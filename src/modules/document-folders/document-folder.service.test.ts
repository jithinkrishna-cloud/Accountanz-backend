import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";

const m = vi.hoisted(() => ({
  findFolder: vi.fn(),
  siblingNamed: vi.fn(),
  insertFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  folderContents: vi.fn(),
  findClientDocument: vi.fn(),
  moveDocument: vi.fn(),
  recordAudit: vi.fn(),
  documentShareIds: vi.fn(),
  sharedFolderIds: vi.fn(),
  folderShareIds: vi.fn(),
  addShares: vi.fn(),
  removeShares: vi.fn(),
  addDocumentShares: vi.fn(),
  removeDocumentShares: vi.fn(),
  listDocumentShares: vi.fn(),
  listShares: vi.fn(),
  activeTeamRoles: vi.fn(),
  notifyShared: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../notifications/notification.service.js", () => ({ notifyShared: m.notifyShared }));
vi.mock("../access/client-access.js", () => ({ activeTeamRoles: m.activeTeamRoles, isAdmin: (u: AuthUser) => u.role === "super_admin" || u.role === "ops_admin" }));
vi.mock("./document-folder.repository.js", () => ({ ...m, listFolders: vi.fn().mockResolvedValue([]), listFoldersForClients: vi.fn(), SHARED_FOLDERS_SQL: "SELECT 1" }));

const service = await import("./document-folder.service.js");

const owner = { id: 21, role: "client_owner" } as unknown as AuthUser;
const folder = (id: number, parent_id: number | null, name: string, client_id = 3) => ({ id, client_id, parent_id, name, created_at: "" });

beforeEach(() => {
  vi.clearAllMocks();
  m.siblingNamed.mockResolvedValue(null);
  m.insertFolder.mockResolvedValue(10);
});

describe("folder paths", () => {
  it("builds the full path at any depth", () => {
    const paths = service.folderPaths([folder(1, null, "Bank"), folder(2, 1, "2026"), folder(3, 2, "March"), folder(4, null, "GST")]);
    expect(paths.get(3)).toBe("Bank / 2026 / March");
    expect(paths.get(4)).toBe("GST");
  });
});

describe("creating folders", () => {
  it("creates a subfolder inside the company's own folder", async () => {
    m.findFolder.mockResolvedValueOnce(folder(1, null, "Bank")).mockResolvedValueOnce(folder(10, 1, "2026"));
    const f = await service.createFolder(owner, 3, { name: "2026", parent_id: 1 });
    expect(m.insertFolder).toHaveBeenCalledWith({ clientId: 3, parentId: 1, name: "2026", userId: 21 }, expect.anything());
    expect(f.name).toBe("2026");
  });

  it("refuses a parent that isn't this company's", async () => {
    m.findFolder.mockResolvedValueOnce(null);
    await expect(service.createFolder(owner, 3, { name: "X", parent_id: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.insertFolder).not.toHaveBeenCalled();
  });

  it("refuses a name already used next to it", async () => {
    m.siblingNamed.mockResolvedValueOnce({ id: 5 });
    await expect(service.createFolder(owner, 3, { name: "Bank", parent_id: null })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("deleting folders", () => {
  it("only deletes empty folders", async () => {
    m.findFolder.mockResolvedValue(folder(1, null, "Bank"));
    m.folderContents.mockResolvedValueOnce({ folders: 1, files: 0 });
    await expect(service.deleteFolder(owner, 3, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    m.folderContents.mockResolvedValueOnce({ folders: 0, files: 2 });
    await expect(service.deleteFolder(owner, 3, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(m.deleteFolder).not.toHaveBeenCalled();
    m.folderContents.mockResolvedValueOnce({ folders: 0, files: 0 });
    await service.deleteFolder(owner, 3, 1);
    expect(m.deleteFolder).toHaveBeenCalledWith(1, expect.anything());
  });
});

describe("moving and uploading", () => {
  it("moves a file into a folder of the same company, and refuses others", async () => {
    m.findClientDocument.mockResolvedValue({ id: 7, file_name: "a.pdf", folder_id: null });
    m.findFolder.mockResolvedValueOnce(folder(2, 1, "2026"));
    await service.moveDocument(owner, 3, 7, { folder_id: 2 });
    expect(m.moveDocument).toHaveBeenCalledWith(3, 7, 2, expect.anything());
    m.findFolder.mockResolvedValueOnce(null);
    await expect(service.moveDocument(owner, 3, 7, { folder_id: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an upload can only target the company's own folder", async () => {
    m.findFolder.mockResolvedValueOnce(null);
    await expect(service.assertUploadFolder(3, 99)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.assertUploadFolder(3, undefined)).resolves.toBeUndefined();
  });
});

describe("privacy: which client files an accountant can see", () => {
  const bookkeeper = { id: 7, role: "bookkeeper" } as unknown as AuthUser;
  const admin = { id: 1, role: "super_admin" } as unknown as AuthUser;
  const clientFile = { id: 50, folder_id: 2, request_id: null, from_client: 1 as const };

  it("a client's file is private until shared", async () => {
    m.documentShareIds.mockResolvedValue([]);
    m.sharedFolderIds.mockResolvedValue([]);
    expect(await service.canSeeDocument(bookkeeper, clientFile)).toBe(false);
    expect(await service.canSeeDocument(bookkeeper, { ...clientFile, folder_id: null })).toBe(false);
  });

  it("shared directly, through a folder, sent for a request, uploaded by the team, or admin: visible", async () => {
    m.documentShareIds.mockResolvedValueOnce([7]);
    expect(await service.canSeeDocument(bookkeeper, clientFile)).toBe(true);
    m.documentShareIds.mockResolvedValueOnce([]);
    m.sharedFolderIds.mockResolvedValueOnce([1, 2]);
    expect(await service.canSeeDocument(bookkeeper, clientFile)).toBe(true);
    expect(await service.canSeeDocument(bookkeeper, { ...clientFile, request_id: 9 })).toBe(true);
    expect(await service.canSeeDocument(bookkeeper, { ...clientFile, from_client: 0 })).toBe(true);
    expect(await service.canSeeDocument(admin, clientFile)).toBe(true);
  });

  it("can only share with people on the company's team, and emails only people newly added", async () => {
    m.findClientDocument.mockResolvedValue({ id: 50, file_name: "a.pdf", folder_id: null });
    m.listDocumentShares.mockResolvedValue([]);
    m.activeTeamRoles.mockResolvedValueOnce([]);
    await expect(service.shareDocument(owner, { clientId: 3, clientName: "ABC" }, 50, [99])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    m.activeTeamRoles.mockResolvedValue(["bookkeeper"]);
    m.documentShareIds.mockResolvedValueOnce([8]);
    await service.shareDocument(owner, { clientId: 3, clientName: "ABC" }, 50, [7, 8]);
    expect(m.addDocumentShares).toHaveBeenCalledWith(50, [7], 21, expect.anything());
    expect(m.notifyShared).toHaveBeenCalledWith([7], expect.objectContaining({ kind: "file", name: "a.pdf" }));
  });
});
