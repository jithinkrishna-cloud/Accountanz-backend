import { createHash, randomBytes } from "node:crypto";

/** Opaque random token for refresh / reset / invite links. Only its hash is stored. */
export const newOpaqueToken = () => randomBytes(32).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
