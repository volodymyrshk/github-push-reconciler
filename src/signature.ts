import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub signs the raw request body with the webhook secret and sends it as
// X-Hub-Signature-256: sha256=<hex>. Verify against the raw bytes, never a re-serialized JSON.
export function verifySignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
