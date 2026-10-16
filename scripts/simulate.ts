// Two hours of simulated traffic: 30 repos, random pushes, 10% of webhooks dropped, a 20-minute
// webhook outage, 5% GitHub API errors and 3% failed builds. Compares webhooks alone with
// webhooks + a reconciler sweep every 5 minutes. Deterministic (seeded), no network.
import { MemoryStore, track } from "../src/store.ts";
import { receivePush } from "../src/receiver.ts";
import { runWorker } from "../src/worker.ts";
import { reconcile } from "../src/reconciler.ts";
import type { GitHubHeads, HeadResult } from "../src/github.ts";
import { createHmac } from "node:crypto";

const SECRET = "sim";
// Separate streams so both runs see identical pushes and drops; only failure timing differs.
const rng = (s: number) => () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
let traffic = rng(42), faults = rng(7);

class FlakyGitHub implements GitHubHeads {
  heads = new Map<string, string>();
  requests = 0;
  async getHead(repo: string, _b: string, etag: string): Promise<HeadResult> {
    this.requests += 1;
    if (faults() < 0.05) return { kind: "error", status: 502 };
    const sha = this.heads.get(repo)!;
    if (etag === `"${sha}"`) return { kind: "not_modified" };
    return { kind: "ok", sha, etag: `"${sha}"` };
  }
}

async function run(withReconciler: boolean) {
  traffic = rng(42); faults = rng(7);
  const store = new MemoryStore();
  const gh = new FlakyGitHub();
  const repos = Array.from({ length: 30 }, (_, i) => `acme/site-${i}`);
  for (const r of repos) { track(store, r, "main"); gh.heads.set(r, `${r}#0`); }
  const deploy = async () => { if (faults() < 0.03) throw new Error("build failed"); };
  const pushedAt = new Map<string, number>();
  let delivery = 0, dropped = 0, staleMinutes = 0, maxStale = 0;
  const MIN = 60_000;
  for (let t = 0; t <= 120 * MIN; t += MIN) {
    for (const r of repos) {
      if (traffic() < 0.08) {
        const sha = `${r}#${t}`;
        gh.heads.set(r, sha);
        pushedAt.set(r, pushedAt.get(r) ?? t);
        const outage = t >= 40 * MIN && t < 60 * MIN;
        if (outage || traffic() < 0.10) { dropped += 1; continue; }
        const raw = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: r } });
        receivePush(store, SECRET, { rawBody: raw, headers: {
          "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex"),
          "x-github-event": "push", "x-github-delivery": `d${++delivery}` } });
      }
    }
    if (withReconciler && t % (5 * MIN) === 0) await reconcile(store, gh, t);
    await runWorker(store, gh, deploy, t, { baseDelayMs: MIN, maxDelayMs: 10 * MIN, maxAttempts: 8 });
    for (const r of repos) {
      const s = store.get(r)!;
      if (s.lastDeployedSha === gh.heads.get(r)) pushedAt.delete(r);
      else if (pushedAt.has(r)) { staleMinutes += 1; maxStale = Math.max(maxStale, (t - pushedAt.get(r)!) / MIN); }
    }
  }
  const behind = repos.filter((r) => store.get(r)!.lastDeployedSha !== gh.heads.get(r)).length;
  return { behind, dropped, staleMinutes, maxStale, requests: gh.requests };
}

const a = await run(false);
const b = await run(true);
console.log("                              webhooks only   + reconciler");
console.log(`webhooks dropped               ${String(a.dropped).padStart(13)}   ${String(b.dropped).padStart(12)}`);
console.log(`sites behind HEAD at the end   ${String(a.behind).padStart(13)}   ${String(b.behind).padStart(12)}`);
console.log(`repo-minutes out of date       ${String(a.staleMinutes).padStart(13)}   ${String(b.staleMinutes).padStart(12)}`);
console.log(`worst delay (minutes)          ${String(a.maxStale).padStart(13)}   ${String(b.maxStale).padStart(12)}`);
console.log(`GitHub API requests (304s free)${String(a.requests).padStart(13)}   ${String(b.requests).padStart(12)}`);
