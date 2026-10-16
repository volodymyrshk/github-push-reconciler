// State the receiver, worker and reconciler share. MemoryStore is for tests and the simulation;
// in production this is a database table with the same fields and a unique key on delivery IDs.
export type RepoState = {
  repo: string;              // "owner/name"
  branch: string;            // the branch that is deployed
  lastDeployedSha: string;   // "" until the first deploy
  dirty: boolean;            // something may have changed since the last deploy
  dirtyReason: string;       // "webhook" | "reconciler" | ""
  attempts: number;          // consecutive failed deploys
  nextAttemptAt: number;     // epoch ms; 0 = now
  deadLetter: boolean;       // gave up after maxAttempts; a human must look
  etag: string;              // last ETag from GitHub for the branch HEAD
};

export interface Store {
  seenDelivery(id: string): boolean;        // true if this delivery ID was already recorded
  recordDelivery(id: string): void;
  get(repo: string): RepoState | undefined;
  put(state: RepoState): void;
  all(): RepoState[];
}

export class MemoryStore implements Store {
  private deliveries = new Set<string>();
  private repos = new Map<string, RepoState>();
  seenDelivery(id: string): boolean { return this.deliveries.has(id); }
  recordDelivery(id: string): void { this.deliveries.add(id); }
  get(repo: string): RepoState | undefined {
    const s = this.repos.get(repo);
    return s ? { ...s } : undefined;
  }
  put(state: RepoState): void { this.repos.set(state.repo, { ...state }); }
  all(): RepoState[] { return [...this.repos.values()].map((s) => ({ ...s })); }
}

export function track(store: Store, repo: string, branch: string): void {
  if (store.get(repo)) return;
  store.put({ repo, branch, lastDeployedSha: "", dirty: true, dirtyReason: "initial", attempts: 0,
    nextAttemptAt: 0, deadLetter: false, etag: "" });
}
