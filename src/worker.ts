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
// Single worker per repo assumed; with several workers, also take a per-repo lease (e.g. SELECT ... FOR UPDATE SKIP LOCKED).
export async function runWorker(store: Store, github: GitHubHeads, deploy: Deployer, now: number,
                                opts: WorkerOptions = {}): Promise<string[]> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const base = opts.baseDelayMs ?? 30_000;
  const cap = opts.maxDelayMs ?? 30 * 60_000;
  const deployed: string[] = [];
  for (const snapshot of store.all()) {
    if (!snapshot.dirty || snapshot.deadLetter || snapshot.nextAttemptAt > now) continue;
    const startedGeneration = snapshot.generation;
    let sha = "";
    let failure: unknown = null;
    try {
      const head = await github.getHead(snapshot.repo, snapshot.branch, "");
      if (head.kind !== "ok") throw new Error(`head lookup failed: ${head.kind}`);
      sha = head.sha;
      if (sha !== snapshot.lastDeployedSha) {
        await deploy(snapshot.repo, sha);
        deployed.push(`${snapshot.repo}@${sha}`);
      }
    } catch (error) {
      failure = error;
    }
    // Re-read after the awaits: a webhook may have arrived meanwhile. Only clear `dirty` if the
    // generation is unchanged (compare-and-set). In a database:
    // UPDATE repos SET dirty = false, ... WHERE repo = $1 AND generation = $2
    const state = store.get(snapshot.repo);
    if (!state) continue;
    if (failure === null) {
      state.lastDeployedSha = sha;
      state.attempts = 0;
      state.nextAttemptAt = 0;
      if (state.generation === startedGeneration) {
        state.dirty = false;
        state.dirtyReason = "";
      }
    } else {
      state.attempts += 1;
      if (state.attempts >= maxAttempts) {
        state.deadLetter = true;
        opts.onDeadLetter?.(state, failure);
      } else {
        state.nextAttemptAt = now + Math.min(cap, base * 2 ** (state.attempts - 1));
      }
    }
    store.put(state);
  }
  return deployed;
}
