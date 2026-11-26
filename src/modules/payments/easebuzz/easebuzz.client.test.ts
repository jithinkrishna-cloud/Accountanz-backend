import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ EASEBUZZ_KEY: "KEY123" as string | undefined, EASEBUZZ_SALT: "SALT456", EASEBUZZ_ENV: "test" }));
vi.mock("../../../config/env.js", async (orig) => {
  const real = await orig<typeof import("../../../config/env.js")>();
  return { ...real, env: new Proxy(real.env, { get: (t, k) => (k in settings ? settings[k as keyof typeof settings] : t[k as keyof typeof t]) }) };
});

const { initiateLink, responseHash, verifyResponse } = await import("./easebuzz.client.js");
const sha512 = (s: string) => createHash("sha512").update(s).digest("hex");

const paid = { status: "success", txnid: "ACZ1", amount: "1180.00", productinfo: "Invoice INV-1", firstname: "Asha", email: "a@x.in", udf1: "42" };

describe("verifyResponse", () => {
  it("accepts a correctly signed payload (reverse udf order, salt first)", () => {
    const hash = sha512(["SALT456", "success", "", "", "", "", "", "", "", "", "", "42", "a@x.in", "Asha", "Invoice INV-1", "1180.00", "ACZ1", "KEY123"].join("|"));
    expect(responseHash("KEY123", "SALT456", paid)).toBe(hash);
    expect(verifyResponse({ ...paid, hash })).toBe(true);
  });
  it("rejects a tampered amount or status", () => {
    const hash = responseHash("KEY123", "SALT456", paid);
    expect(verifyResponse({ ...paid, amount: "1.00", hash })).toBe(false);
    expect(verifyResponse({ ...paid, status: "failure", hash })).toBe(false);
    expect(verifyResponse({ ...paid })).toBe(false);
  });
  it("rejects everything while credentials are missing", () => {
    const hash = responseHash("KEY123", "SALT456", paid);
    settings.EASEBUZZ_KEY = undefined;
    expect(verifyResponse({ ...paid, hash })).toBe(false);
    settings.EASEBUZZ_KEY = "KEY123";
  });
});

describe("initiateLink", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => vi.stubGlobal("fetch", (fetchMock = vi.fn())));
  afterEach(() => vi.unstubAllGlobals());
  const input = { txnid: "ACZ1", amount: 1180, productinfo: "Invoice INV-1", firstname: "Asha", email: "a@x.in", phone: "9876543210", surl: "https://s", furl: "https://f", udf1: "42" };

  it("posts a signed form and returns the hosted checkout URL", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 1, data: "ACCESSKEY" })));
    await expect(initiateLink(input)).resolves.toBe("https://testpay.easebuzz.in/pay/ACCESSKEY");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://testpay.easebuzz.in/payment/initiateLink");
    const body = init.body as URLSearchParams;
    expect(body.get("amount")).toBe("1180.00");
    expect(body.get("hash")).toBe(sha512(["KEY123", "ACZ1", "1180.00", "Invoice INV-1", "Asha", "a@x.in", "42", "", "", "", "", "", "", "", "", "", "SALT456"].join("|")));
  });
  it("turns a gateway refusal into an UNAVAILABLE error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 0, error_desc: "Invalid phone" })));
    await expect(initiateLink(input)).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("Invalid phone") });
  });
});
