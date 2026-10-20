# github-push-reconciler

[![test](https://github.com/volodymyrshk/github-push-reconciler/actions/workflows/test.yml/badge.svg)](https://github.com/volodymyrshk/github-push-reconciler/actions/workflows/test.yml)

Keep every deployed repo converging to its latest push, even when webhooks go missing. A small TypeScript reference (not a production library) for any product that deploys or syncs from customers' GitHub repos: docs platforms, static sites, CI, previews.

Webhooks are a notification, not a guarantee. GitHub has outages, your receiver has deploys, and rate limits bite exactly when traffic is high. The usual workaround is "redeploy manually from the dashboard", which means a customer noticed first.

This repo shows three pieces that make a deploy pipeline self-healing. Note the guarantee: each repo eventually gets deployed at its **latest** HEAD. Intermediate commits are skipped on purpose. If your workflow must process every commit (audits, per-commit builds), this is the wrong pattern.

1. **Receiver** (`src/receiver.ts`): verifies `X-Hub-Signature-256` over the raw body, de-duplicates on `X-GitHub-Delivery`, marks the repo dirty (bumping a generation counter) and returns 202. It doesn't deploy and doesn't trust the payload's ordering.
2. **Worker** (`src/worker.ts`): deploys each dirty repo at its **current HEAD**. Ten quick pushes become one deploy of the newest commit, and a late, stale webhook can't roll a site back. It only clears `dirty` if no new webhook arrived while it was deploying (compare-and-set on the generation). Failed deploys retry with capped exponential backoff, then dead-letter for a human.
3. **Reconciler** (`src/reconciler.ts`): on a schedule, compares each repo's HEAD with the last deployed SHA and queues the gap, checking the least recently checked repos first so a request budget covers every repo over several sweeps. It uses conditional requests (`If-None-Match`); a `304 Not Modified` doesn't count against GitHub's primary rate limit, so checking thousands of quiet repos is cheap. On a rate limit it stops and resumes after the reset, without losing anything.

## An illustration (not a benchmark)

`npm run simulate`: two hours, 30 repos, ~10% of webhooks dropped plus a 20-minute webhook outage, 5% GitHub API errors, 3% failed builds. Pushes and dropped webhooks are identical in both runs; the injected API and build failures are not matched one-for-one, because the reconciler makes more API calls. In-memory, single process:

```
                              webhooks only   + reconciler
webhooks dropped                          73             73
sites behind HEAD at the end               2              1
repo-minutes out of date                 819            185
worst delay (minutes)                     74              8
GitHub API requests (304s free)          279           1007
```

Without the reconciler, a missed webhook is fixed only when the next push to the same repo happens to arrive. With it, the worst case is one sweep interval plus retries. (The one repo behind at the end was pushed in the final minute.)

## Run

Node 23.6 or newer (runs TypeScript directly, no build step, no dependencies).

```bash
npm test
npm run simulate
```

## Limitations

- `MemoryStore` is single-process. With a database, the receiver's "record delivery + mark dirty" must be one transaction, and the worker's compare-and-set becomes `UPDATE ... WHERE repo = $1 AND generation = $2`.
- One worker per repo is assumed. With several workers, take a per-repo lease (for example `SELECT ... FOR UPDATE SKIP LOCKED`).
- Crashes, transaction failures and competing workers are not simulated. The numbers above illustrate the mechanism; they are not evidence of what a deployed system will achieve.

## Using it for real

- Replace `MemoryStore` with a table keyed by repo, plus a unique index on delivery IDs (Postgres works well; `INSERT ... ON CONFLICT DO NOTHING` is the de-duplication).
- Run the worker and the reconciler as separate jobs. Sweep every 5 to 15 minutes; spread repos across sweeps if you have many installations.
- Use a GitHub App installation token per customer installation, so each installation has its own rate-limit budget.
- Alert on dead letters and on `dirtyReason = "reconciler"` counts: a rising count means your webhooks are failing, which you want to know before a customer does.
- GitHub also lets you list and redeliver failed deliveries for an App or hook. That's worth wiring in, but it doesn't replace the HEAD comparison: it can't help when the delivery never left GitHub or your receiver accepted it and then lost it.

## Scope

A reference, not a framework. About 230 lines of source, 13 tests covering signatures, duplicates, branch filtering, coalescing, out-of-order deliveries, dropped webhooks, webhooks arriving mid-deploy and mid-sweep, sweep coverage under a request budget, 304s, rate limits, retries and dead letters.

MIT licensed. Volodymyr Shkarban, USK Group LLC.
