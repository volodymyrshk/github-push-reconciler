// Reads the current HEAD of a branch. Uses the cheap "sha" media type and conditional requests:
// a 304 Not Modified does not count against GitHub's primary rate limit.
export type HeadResult =
  | { kind: "ok"; sha: string; etag: string }
  | { kind: "not_modified" }
  | { kind: "rate_limited"; resetAt: number }
  | { kind: "error"; status: number };

export interface GitHubHeads {
  getHead(repo: string, branch: string, etag: string): Promise<HeadResult>;
}

export class FetchGitHubHeads implements GitHubHeads {
  private token: string;
  private baseUrl: string;
  constructor(token: string, baseUrl = "https://api.github.com") {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async getHead(repo: string, branch: string, etag: string): Promise<HeadResult> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.sha",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (etag) headers["If-None-Match"] = etag;
    const res = await fetch(`${this.baseUrl}/repos/${repo}/commits/${encodeURIComponent(branch)}`, { headers });
    if (res.status === 304) return { kind: "not_modified" };
    if (res.ok) return { kind: "ok", sha: (await res.text()).trim(), etag: res.headers.get("etag") ?? "" };
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter > 0))) {
      return { kind: "rate_limited", resetAt: retryAfter ? Date.now() + retryAfter : reset };
    }
    return { kind: "error", status: res.status };
  }
}
