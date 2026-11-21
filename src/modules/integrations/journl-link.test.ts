import { describe, expect, it } from "vitest";
import { journlLink } from "./journl-link.js";

const T = "https://app.journl.test/company/{companyId}/dashboard";

describe("journlLink", () => {
  it("builds the company link from the template, encoding the ID", () => {
    expect(journlLink({ status: "connected", external_org_id: "42" }, T)).toEqual({ state: "ready", url: "https://app.journl.test/company/42/dashboard" });
    expect(journlLink({ status: "connected", external_org_id: "a/b?c" }, T)).toEqual({ state: "ready", url: "https://app.journl.test/company/a%2Fb%3Fc/dashboard" });
  });

  it("says unavailable, with the status, when there's no usable connection", () => {
    expect(journlLink(null, T)).toEqual({ state: "unavailable", status: null });
    expect(journlLink({ status: "revoked", external_org_id: "42" }, T)).toEqual({ state: "unavailable", status: "revoked" });
    expect(journlLink({ status: "connected", external_org_id: null }, T)).toEqual({ state: "unavailable", status: "connected" });
  });

  it("says not configured when the template is missing", () => {
    expect(journlLink({ status: "connected", external_org_id: "42" }, undefined)).toEqual({ state: "not_configured" });
  });

  it("never contains anything but the company ID", () => {
    const r = journlLink({ status: "connected", external_org_id: "42" }, T);
    expect(r.state === "ready" && r.url).not.toMatch(/token|bearer/i);
  });
});
