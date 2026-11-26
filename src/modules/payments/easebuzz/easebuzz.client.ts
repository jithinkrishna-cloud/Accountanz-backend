import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../../config/env.js";
import { AppError } from "../../../utils/app-error.js";

const BASE = { test: "https://testpay.easebuzz.in", prod: "https://pay.easebuzz.in" } as const;
const UDF = ["udf1", "udf2", "udf3", "udf4", "udf5", "udf6", "udf7", "udf8", "udf9", "udf10"] as const;
type Udf = (typeof UDF)[number];
const sha512 = (s: string) => createHash("sha512").update(s).digest("hex");

export const easebuzzConfigured = () => !!env.EASEBUZZ_KEY && !!env.EASEBUZZ_SALT;

function creds() {
  if (!env.EASEBUZZ_KEY || !env.EASEBUZZ_SALT) throw new AppError("UNAVAILABLE", "Online payments aren't set up yet");
  return { key: env.EASEBUZZ_KEY, salt: env.EASEBUZZ_SALT, base: BASE[env.EASEBUZZ_ENV] };
}

export interface InitiateInput extends Partial<Record<Udf, string>> {
  txnid: string;
  amount: number;
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  surl: string;
  furl: string;
}

/** sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf10|salt) */
export function requestHash(key: string, salt: string, i: Omit<InitiateInput, "amount"> & { amount: string }) {
  return sha512([key, i.txnid, i.amount, i.productinfo, i.firstname, i.email, ...UDF.map((u) => i[u] ?? ""), salt].join("|"));
}

/** sha512(salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key), amount exactly as received. */
export function responseHash(key: string, salt: string, p: Record<string, string | undefined>) {
  return sha512([salt, p.status, ...[...UDF].reverse().map((u) => p[u] ?? ""), p.email, p.firstname, p.productinfo, p.amount, p.txnid, key].join("|"));
}

/** Creates an Easebuzz payment link and returns the hosted checkout URL. */
export async function initiateLink(input: InitiateInput): Promise<string> {
  const { key, salt, base } = creds();
  const amount = input.amount.toFixed(2);
  const hash = requestHash(key, salt, { ...input, amount });
  const body = new URLSearchParams({
    key,
    txnid: input.txnid,
    amount,
    productinfo: input.productinfo,
    firstname: input.firstname,
    email: input.email,
    phone: input.phone,
    surl: input.surl,
    furl: input.furl,
    hash,
    ...Object.fromEntries(UDF.map((u) => [u, input[u] ?? ""])),
  });
  let json: { status?: number; data?: string; error_desc?: string };
  try {
    const res = await fetch(`${base}/payment/initiateLink`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    json = (await res.json()) as typeof json;
  } catch {
    throw new AppError("UNAVAILABLE", "Couldn't reach the payment gateway. Please try again in a moment.");
  }
  if (json.status !== 1 || !json.data) {
    throw new AppError("UNAVAILABLE", `The payment gateway refused the request: ${json.error_desc ?? json.data ?? "unknown error"}`);
  }
  return `${base}/pay/${json.data}`;
}

/** True when the hash Easebuzz sent (return URL or webhook) matches the payload. */
export function verifyResponse(p: Record<string, string | undefined>): boolean {
  if (!easebuzzConfigured()) return false;
  const { key, salt } = creds();
  const expected = Buffer.from(responseHash(key, salt, p));
  const got = Buffer.from(String(p.hash ?? ""));
  return expected.length === got.length && timingSafeEqual(expected, got);
}
