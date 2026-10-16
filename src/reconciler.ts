import type { GitHubHeads } from "./github.ts";
import type { Store } from "./store.ts";

export type SweepReport = { checked: number; replayed: string[]; notModified: number; errors: number;
  rateLimitedUntil: number };

// The safety net. Webhooks get lost (provider outages, your own downtime, a bad deploy of the receiver).
// On a schedule, compare each repo's HEAD with the last deployed SHA and mark the gap dirty.
// Conditional requests keep this cheap; on a rate limit the sweep stops and resumes after the reset.
export async function reconcile(store: Store, github: GitHubHeads, now: number,
                                maxRequests = 500, pausedUntil = 0): Promise<SweepReport> {
  const report: SweepReport = { checked: 0, replayed: [], notModified: 0, errors: 0, rateLimitedUntil: 0 };
  if (pausedUntil > now) {
    report.rateLimitedUntil = pausedUntil;
    return report;
  }
  for (const state of store.all()) {
    if (state.dirty || state.deadLetter) continue;   // already queued or waiting for a human
    if (report.checked >= maxRequests) break;
    report.checked += 1;
    const head = await github.getHead(state.repo, state.branch, state.etag);
    if (head.kind === "not_modified") {
      report.notModified += 1;
      continue;
    }
    if (head.kind === "rate_limited") {
      report.rateLimitedUntil = head.resetAt;
      break;
    }
    if (head.kind === "error") {
      report.errors += 1;
      continue;
    }
    state.etag = head.etag;
    if (head.sha !== state.lastDeployedSha) {
      state.dirty = true;
      state.dirtyReason = "reconciler";
      state.nextAttemptAt = 0;
      report.replayed.push(`${state.repo}@${head.sha}`);
    }
    store.put(state);
  }
  return report;
}
