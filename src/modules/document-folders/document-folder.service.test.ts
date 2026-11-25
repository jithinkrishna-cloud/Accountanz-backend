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
}));

vi.mock("../../database/connection.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("../audit/audit.service.js", () => ({ recordAudit: m.recordAudit }));
vi.mock("./document-folder.repository.js", () => ({ ...m, listFolders: vi.fn(), listFoldersForClients: vi.fn() }));

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
