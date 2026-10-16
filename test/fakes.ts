import { createHmac } from "node:crypto";
import type { GitHubHeads, HeadResult } from "../src/github.ts";

export const SECRET = "test-secret";

export class FakeGitHub implements GitHubHeads {
  heads = new Map<string, string>();
  calls = 0;
  failNext: HeadResult[] = [];
  push(repo: string, sha: string): void { this.heads.set(repo, sha); }
  async getHead(repo: string, _branch: string, etag: string): Promise<HeadResult> {
    this.calls += 1;
    const forced = this.failNext.shift();
    if (forced) return forced;
    const sha = this.heads.get(repo) ?? "";
    const tag = `"${sha}"`;
    if (etag && etag === tag) return { kind: "not_modified" };
    return { kind: "ok", sha, etag: tag };
  }
}

export function signed(body: object, delivery: string, event = "push") {
  const raw = JSON.stringify(body);
  return {
    rawBody: raw,
    headers: {
      "X-Hub-Signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex"),
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery,
    },
  };
}

export function pushBody(repo: string, sha: string, branch = "main") {
  return { ref: `refs/heads/${branch}`, after: sha, repository: { full_name: repo } };
}
