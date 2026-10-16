import type { GitHubHeads } from "./github.ts";
import { markDirty, type Store } from "./store.ts";

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
  // Oldest-checked first, so a request budget smaller than the repo count still covers every repo over several sweeps.
  const due = store.all().filter((s) => !s.dirty && !s.deadLetter).sort((a, b) => a.lastCheckedAt - b.lastCheckedAt);
  for (const snapshot of due) {
    if (report.checked >= maxRequests) break;
    report.checked += 1;
    const head = await github.getHead(snapshot.repo, snapshot.branch, snapshot.etag);
    if (head.kind === "rate_limited") {
      report.rateLimitedUntil = head.resetAt;
      break;
    }
    const state = store.get(snapshot.repo);   // re-read: a webhook may have changed it during the await
    if (!state) continue;
    state.lastCheckedAt = now;
    if (head.kind === "not_modified") report.notModified += 1;
    else if (head.kind === "error") report.errors += 1;
    else {
      state.etag = head.etag;
      if (head.sha !== state.lastDeployedSha && !state.dirty) {
        store.put(markDirty(state, "reconciler"));
        report.replayed.push(`${state.repo}@${head.sha}`);
        continue;
      }
    }
    store.put(state);
  }
  return report;
}
