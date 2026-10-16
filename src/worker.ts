import type { GitHubHeads } from "./github.ts";
import type { RepoState, Store } from "./store.ts";

export type Deployer = (repo: string, sha: string) => Promise<void>;
export type WorkerOptions = {
  maxAttempts?: number;      // then dead-letter
  baseDelayMs?: number;      // first retry delay
  maxDelayMs?: number;       // backoff cap
  onDeadLetter?: (state: RepoState, error: unknown) => void;
};

// Deploys every dirty repo at its CURRENT head. Ten pushes in a row become one deploy of the newest commit.
export async function runWorker(store: Store, github: GitHubHeads, deploy: Deployer, now: number,
                                opts: WorkerOptions = {}): Promise<string[]> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const base = opts.baseDelayMs ?? 30_000;
  const cap = opts.maxDelayMs ?? 30 * 60_000;
  const deployed: string[] = [];
  for (const state of store.all()) {
    if (!state.dirty || state.deadLetter || state.nextAttemptAt > now) continue;
    try {
      const head = await github.getHead(state.repo, state.branch, "");
      if (head.kind !== "ok") throw new Error(`head lookup failed: ${head.kind}`);
      if (head.sha !== state.lastDeployedSha) {
        await deploy(state.repo, head.sha);
        deployed.push(`${state.repo}@${head.sha}`);
      }
      state.lastDeployedSha = head.sha;
      state.dirty = false;
      state.dirtyReason = "";
      state.attempts = 0;
      state.nextAttemptAt = 0;
    } catch (error) {
      state.attempts += 1;
      if (state.attempts >= maxAttempts) {
        state.deadLetter = true;
        opts.onDeadLetter?.(state, error);
      } else {
        state.nextAttemptAt = now + Math.min(cap, base * 2 ** (state.attempts - 1));
      }
    }
    store.put(state);
  }
  return deployed;
}
