import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySignature } from "../src/signature.ts";
import { SECRET, signed } from "./fakes.ts";

test("accepts a correct signature over the raw body", () => {
  const req = signed({ a: 1 }, "d1");
  assert.equal(verifySignature(SECRET, req.rawBody, req.headers["X-Hub-Signature-256"]), true);
});

test("rejects a wrong secret, a changed body, a missing or malformed header", () => {
  const req = signed({ a: 1 }, "d1");
  assert.equal(verifySignature("other", req.rawBody, req.headers["X-Hub-Signature-256"]), false);
  assert.equal(verifySignature(SECRET, req.rawBody + " ", req.headers["X-Hub-Signature-256"]), false);
  assert.equal(verifySignature(SECRET, req.rawBody, undefined), false);
  assert.equal(verifySignature(SECRET, req.rawBody, "sha1=abc"), false);
  assert.equal(verifySignature(SECRET, req.rawBody, "sha256=abc"), false);
});
