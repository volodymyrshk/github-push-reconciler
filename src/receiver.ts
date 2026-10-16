import { verifySignature } from "./signature.ts";
import { markDirty, type Store } from "./store.ts";

export type WebhookRequest = { headers: Record<string, string | undefined>; rawBody: Buffer | string };
export type WebhookResult = { status: number; outcome: string };

// The receiver does as little as possible: verify, de-duplicate, mark the repo dirty, return 202.
// It does not deploy and does not trust the payload's SHA ordering. The worker deploys the branch's
// current HEAD, so duplicates and out-of-order deliveries cannot roll a site back.
export function receivePush(store: Store, secret: string, req: WebhookRequest): WebhookResult {
  const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (!verifySignature(secret, req.rawBody, h["x-hub-signature-256"])) return { status: 401, outcome: "bad_signature" };
  const event = h["x-github-event"];
  if (event === "ping") return { status: 200, outcome: "ping" };
  if (event !== "push") return { status: 202, outcome: "ignored_event" };
  const delivery = h["x-github-delivery"];
  if (!delivery) return { status: 400, outcome: "missing_delivery_id" };
  if (store.seenDelivery(delivery)) return { status: 202, outcome: "duplicate" };

  let payload: { ref?: string; repository?: { full_name?: string } };
  try {
    payload = JSON.parse(req.rawBody.toString());
  } catch {
    return { status: 400, outcome: "bad_json" };
  }
  // Recording the delivery and marking the repo dirty happen together with no await in between.
  // In a database, do both in one transaction (insert the delivery ID with a unique key, then update).
  const repo = payload.repository?.full_name ?? "";
  const state = store.get(repo);
  store.recordDelivery(delivery);
  if (!state) return { status: 202, outcome: "untracked_repo" };
  if (payload.ref !== `refs/heads/${state.branch}`) return { status: 202, outcome: "other_branch" };

  store.put(markDirty(state, "webhook"));
  return { status: 202, outcome: "queued" };
}
