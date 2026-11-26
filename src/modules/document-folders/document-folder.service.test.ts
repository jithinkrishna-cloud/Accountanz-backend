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
  visibleFolderIds: vi.fn(),
  findFolderById: vi.fn(),
  requireClientAccess: vi.fn(),
  folderShareIds: vi.fn(),
  addShares: vi.fn(),
  removeShares: vi.fn(),
  addDocumentShares: vi.fn(),
  removeDocumentShares: vi.fn(),
  listDocumentShares: vi.fn(),
  listShares: vi.fn(),
  activeTeamRoles: vi.fn(),
  notifyShared: vi.fn(),
  listFolders: vi.fn(),
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}), pool: {}, query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("../notifications/notification.service.js", () => ({ notifyShared: m.notifyShared }));
vi.mock("../access/client-access.js", () => ({ activeTeamRoles: m.activeTeamRoles, requireClientAccess: m.requireClientAccess, isAdmin: (u: AuthUser) => u.role === "super_admin" || u.role === "ops_admin" }));
vi.mock("./document-folder.repository.js", async (importActual) => {
  // The real SQL (the visibility test checks it); everything that touches the database is mocked.
  const actual = await importActual<typeof import("./document-folder.repository.js")>();
  return { ...m, listFoldersForClients: vi.fn(), VISIBLE_FOLDERS_SQL: actual.VISIBLE_FOLDERS_SQL, SHARED_FOLDERS_SQL: actual.SHARED_FOLDERS_SQL };
});

const service = await import("./document-folder.service.js");

const owner = { id: 21, role: "client_owner" } as unknown as AuthUser;
const folder = (id: number, parent_id: number | null, name: string, client_id = 3, staff_folder: 0 | 1 = 0) => ({ id, client_id, parent_id, name, staff_folder, created_at: "" });

beforeEach(() => {
  vi.clearAllMocks();
  m.siblingNamed.mockResolvedValue(null);
  m.insertFolder.mockResolvedValue(10);
  m.listFolders.mockResolvedValue([]);
  m.listShares.mockResolvedValue([]);
  m.requireClientAccess.mockResolvedValue(undefined);
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
    expect(m.insertFolder).toHaveBeenCalledWith({ clientId: 3, parentId: 1, name: "2026", userId: 21, staff: false }, expect.anything());
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
    m.visibleFolderIds.mockResolvedValue([]);
    expect(await service.canSeeDocument(bookkeeper, clientFile)).toBe(false);
    expect(await service.canSeeDocument(bookkeeper, { ...clientFile, folder_id: null })).toBe(false);
  });

  it("shared directly, through a folder, sent for a request, uploaded by the team, or admin: visible", async () => {
    m.documentShareIds.mockResolvedValueOnce([7]);
    expect(await service.canSeeDocument(bookkeeper, clientFile)).toBe(true);
    m.documentShareIds.mockResolvedValueOnce([]);
    m.visibleFolderIds.mockResolvedValueOnce([1, 2]);
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

describe("document request folders", () => {
  const conn = {} as never;
  const req = { clientId: 3, period: "2026-11", description: "Bank statements for all current accounts", userId: 7 };

  it("creates the month folder and the request folder inside it, both staff folders", async () => {
    m.siblingNamed.mockResolvedValue(null);
    m.insertFolder.mockResolvedValueOnce(40).mockResolvedValueOnce(41);
    expect(await service.createRequestFolder(req, conn)).toBe(41);
    expect(m.insertFolder).toHaveBeenNthCalledWith(1, { clientId: 3, parentId: null, name: "Nov 2026", userId: 7, staff: true }, conn);
    expect(m.insertFolder).toHaveBeenNthCalledWith(2, { clientId: 3, parentId: 40, name: "Bank statements for all current accounts", userId: 7, staff: true }, conn);
  });

  it("reuses an existing month folder", async () => {
    m.siblingNamed.mockResolvedValueOnce({ id: 40 }).mockResolvedValue(null);
    m.insertFolder.mockResolvedValueOnce(42);
    expect(await service.createRequestFolder(req, conn)).toBe(42);
    expect(m.insertFolder).toHaveBeenCalledTimes(1);
    expect(m.insertFolder).toHaveBeenCalledWith(expect.objectContaining({ parentId: 40 }), conn);
    expect(m.siblingNamed).toHaveBeenNthCalledWith(1, 3, null, "Nov 2026", conn);
  });

  it("suffixes (2), (3)… when a sibling already has the name, staying within 100 characters", async () => {
    m.siblingNamed
      .mockResolvedValueOnce({ id: 40 }) // month
      .mockResolvedValueOnce({ id: 50 }) // "GST" taken
      .mockResolvedValueOnce({ id: 51 }) // "GST (2)" taken
      .mockResolvedValue(null);
    await service.createRequestFolder({ ...req, description: "GST" }, conn);
    expect(m.insertFolder).toHaveBeenCalledWith(expect.objectContaining({ parentId: 40, name: "GST (3)" }), conn);

    m.insertFolder.mockClear();
    m.siblingNamed.mockReset();
    m.siblingNamed.mockResolvedValueOnce({ id: 40 }).mockResolvedValueOnce({ id: 50 }).mockResolvedValue(null);
    await service.createRequestFolder({ ...req, description: "x".repeat(300) }, conn);
    const name = m.insertFolder.mock.calls[0][0].name as string;
    expect(name).toBe(`${"x".repeat(96)} (2)`);
    expect(name.length).toBe(100);
  });

  it("names: the request's period or the current month; descriptions become one plain line", () => {
    expect(service.monthFolderName("2026-01")).toBe("Jan 2026");
    expect(service.monthFolderName(null, new Date(2026, 10, 26))).toBe("Nov 2026");
    expect(service.requestFolderName("  Bank / card\nstatements  ")).toBe("Bank - card statements");
    expect(service.requestFolderName("x".repeat(150))).toHaveLength(100);
  });
});

describe("staff folders (shared tree)", () => {
  const bookkeeper = { id: 7, role: "bookkeeper" } as unknown as AuthUser;
  const admin = { id: 1, role: "super_admin" } as unknown as AuthUser;

  it("staff can't rename or delete a client's own folder, even one shared with them", async () => {
    const privateFolder = folder(5, null, "Personal", 3, 0);
    m.findFolderById.mockResolvedValue(privateFolder);
    m.findFolder.mockResolvedValue(privateFolder);
    m.visibleFolderIds.mockResolvedValue([5]);
    await expect(service.renameStaffFolder(bookkeeper, 5, { name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deleteStaffFolder(admin, 5)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.renameFolder).not.toHaveBeenCalled();
    expect(m.deleteFolder).not.toHaveBeenCalled();
  });

  it("staff rename their team's folders; the client can't rename, delete or share them", async () => {
    const staffFolder = folder(6, null, "Nov 2026", 3, 1);
    m.findFolderById.mockResolvedValue(staffFolder);
    m.findFolder.mockResolvedValue(staffFolder);
    m.visibleFolderIds.mockResolvedValue([6]);
    await service.renameStaffFolder(bookkeeper, 6, { name: "November 2026" });
    expect(m.renameFolder).toHaveBeenCalledWith(6, "November 2026", expect.anything());
    await expect(service.renameFolder(owner, 3, 6, { name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deleteFolder(owner, 3, 6)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.shareFolder(owner, { clientId: 3, clientName: "ABC" }, 6, [7])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a hidden client folder answers like a missing one", async () => {
    m.findFolderById.mockResolvedValue(folder(5, null, "Personal"));
    m.findFolder.mockResolvedValue(folder(5, null, "Personal"));
    m.visibleFolderIds.mockResolvedValue([]);
    await expect(service.renameStaffFolder(bookkeeper, 5, { name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.createStaffFolder(bookkeeper, { client_id: 3, parent_id: 5, name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("staff create staff folders; accountants list only what they can see, admins everything", async () => {
    m.findFolder.mockResolvedValue(folder(10, null, "Payroll", 3, 1));
    await service.createStaffFolder(bookkeeper, { client_id: 3, parent_id: null, name: "Payroll" });
    expect(m.insertFolder).toHaveBeenCalledWith({ clientId: 3, parentId: null, name: "Payroll", userId: 7, staff: true }, expect.anything());
    expect(m.requireClientAccess).toHaveBeenCalledWith(bookkeeper, 3);

    m.listFolders.mockResolvedValue([folder(1, null, "Personal"), folder(2, null, "Nov 2026", 3, 1)]);
    m.visibleFolderIds.mockResolvedValue([2]);
    expect((await service.listStaffFolders(bookkeeper, 3)).map((f) => f.id)).toEqual([2]);
    expect((await service.listStaffFolders(admin, 3)).map((f) => f.id)).toEqual([1, 2]);
  });

  it("visibility: files in staff folders (and below them) are visible to the team", async () => {
    const v = service.documentVisibility(bookkeeper, "d");
    expect(v.sql).toContain("d.folder_id IN");
    expect(v.sql).toContain("staff_folder = 1");
    expect(v.sql).toContain("document_folder_shares");
    expect(v.sql).toContain("RECURSIVE");
    expect(v.params).toEqual([7, 7]);
    expect(service.documentVisibility(admin).sql).toBe("1 = 1");

    m.documentShareIds.mockResolvedValue([]);
    m.visibleFolderIds.mockResolvedValueOnce([2]);
    expect(await service.canSeeDocument(bookkeeper, { id: 9, folder_id: 2, request_id: null, from_client: 1 })).toBe(true);
  });
});
