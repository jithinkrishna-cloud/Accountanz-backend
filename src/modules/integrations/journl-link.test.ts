import { describe, expect, it } from "vitest";
import { journlLink } from "./journl-link.js";

const T = "https://app.journl.test/company/{companyId}/dashboard";

describe("journlLink (integration on)", () => {
  it("builds the company link from the template, encoding the ID", () => {
    expect(journlLink({ status: "connected", external_org_id: "42" }, T, true)).toEqual({ state: "ready", url: "https://app.journl.test/company/42/dashboard" });
    expect(journlLink({ status: "connected", external_org_id: "a/b?c" }, T, true)).toEqual({ state: "ready", url: "https://app.journl.test/company/a%2Fb%3Fc/dashboard" });
  });

  it("says unavailable, with the status, when there's no usable connection", () => {
    expect(journlLink(null, T, true)).toEqual({ state: "unavailable", status: null });
    expect(journlLink({ status: "revoked", external_org_id: "42" }, T, true)).toEqual({ state: "unavailable", status: "revoked" });
    expect(journlLink({ status: "connected", external_org_id: null }, T, true)).toEqual({ state: "unavailable", status: "connected" });
  });

  it("uses the address as-is when it has no {companyId} (JournL picks the company from the login)", () => {
    expect(journlLink({ status: "connected", external_org_id: "42" }, "https://books.example.test/", true)).toEqual({ state: "ready", url: "https://books.example.test/" });
  });

  it("says not configured when the template is missing", () => {
    expect(journlLink({ status: "connected", external_org_id: "42" }, "", true)).toEqual({ state: "not_configured" });
  });

  it("never contains anything but the company ID", () => {
    const r = journlLink({ status: "connected", external_org_id: "42" }, T, true);
    expect(r.state === "ready" && r.url).not.toMatch(/token|bearer/i);
  });
});

describe("journlLink (integration off)", () => {
  it("links to JournL without needing a connection", () => {
    expect(journlLink(null, "https://books.example.test/", false)).toEqual({ state: "ready", url: "https://books.example.test/" });
    expect(journlLink({ status: "disconnected", external_org_id: "42" }, "https://books.example.test/", false)).toEqual({ state: "ready", url: "https://books.example.test/" });
  });

  it("drops {companyId} when there's no connection, and fills it from a live one", () => {
    expect(journlLink(null, T, false)).toEqual({ state: "ready", url: "https://app.journl.test/company/dashboard" });
    expect(journlLink({ status: "connected", external_org_id: "42" }, T, false)).toEqual({ state: "ready", url: "https://app.journl.test/company/42/dashboard" });
  });

  it("still needs the address, and still only hands out https", () => {
    expect(journlLink(null, "", false)).toEqual({ state: "not_configured" });
    expect(journlLink(null, "http://books.example.test/", false)).toEqual({ state: "not_configured" });
  });
});
