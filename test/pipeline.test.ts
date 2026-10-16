import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, track } from "../src/store.ts";
import { receivePush } from "../src/receiver.ts";
import { runWorker } from "../src/worker.ts";
import { reconcile } from "../src/reconciler.ts";
import { FakeGitHub, SECRET, pushBody, signed } from "./fakes.ts";

function setup() {
  const store = new MemoryStore();
  const gh = new FakeGitHub();
  const deploys: string[] = [];
  const deploy = async (repo: string, sha: string) => { deploys.push(`${repo}@${sha}`); };
  track(store, "acme/docs", "main");
  gh.push("acme/docs", "a1");
  return { store, gh, deploys, deploy };
}

test("initial deploy, then a push webhook triggers a deploy of HEAD", async () => {
  const { store, gh, deploys, deploy } = setup();
  await runWorker(store, gh, deploy, 0);
  gh.push("acme/docs", "b2");
  assert.equal(receivePush(store, SECRET, signed(pushBody("acme/docs", "b2"), "d1")).outcome, "queued");
  await runWorker(store, gh, deploy, 1);
  assert.deepEqual(deploys, ["acme/docs@a1", "acme/docs@b2"]);
  assert.equal(store.get("acme/docs")?.lastDeployedSha, "b2");
});

test("duplicate deliveries are ignored and bad signatures rejected", async () => {
  const { store } = setup();
  const req = signed(pushBody("acme/docs", "b2"), "same-id");
  assert.equal(receivePush(store, SECRET, req).outcome, "queued");
  assert.equal(receivePush(store, SECRET, req).outcome, "duplicate");
  const forged = { ...req, headers: { ...req.headers, "X-Hub-Signature-256": "sha256=00", "X-GitHub-Delivery": "x" } };
  assert.equal(receivePush(store, SECRET, forged).status, 401);
});

test("pushes to other branches and untracked repos do not deploy", async () => {
  const { store } = setup();
  await runWorker(store, new FakeGitHub(), async () => {}, 0).catch(() => {});
  assert.equal(receivePush(store, SECRET, signed(pushBody("acme/docs", "z", "feature"), "d2")).outcome, "other_branch");
  assert.equal(receivePush(store, SECRET, signed(pushBody("other/repo", "z"), "d3")).outcome, "untracked_repo");
});

test("ten pushes coalesce into one deploy of the newest commit; late old webhooks cannot roll back", async () => {
  const { store, gh, deploys, deploy } = setup();
  await runWorker(store, gh, deploy, 0);
  for (let i = 1; i <= 10; i++) {
    gh.push("acme/docs", `c${i}`);
    receivePush(store, SECRET, signed(pushBody("acme/docs", `c${i}`), `d${i}`));
  }
  await runWorker(store, gh, deploy, 1);
  assert.deepEqual(deploys, ["acme/docs@a1", "acme/docs@c10"]);
  receivePush(store, SECRET, signed(pushBody("acme/docs", "c3"), "late"));   // stale delivery arrives last
  await runWorker(store, gh, deploy, 2);
  assert.equal(store.get("acme/docs")?.lastDeployedSha, "c10");
  assert.equal(deploys.length, 2);
});

test("a dropped webhook is caught by the reconciler and deployed", async () => {
  const { store, gh, deploys, deploy } = setup();
  await runWorker(store, gh, deploy, 0);
  await reconcile(store, gh, 0);                 // learn the ETag
  gh.push("acme/docs", "lost1");                 // webhook never arrives
  const report = await reconcile(store, gh, 10);
  assert.deepEqual(report.replayed, ["acme/docs@lost1"]);
  assert.equal(store.get("acme/docs")?.dirtyReason, "reconciler");
  await runWorker(store, gh, deploy, 11);
  assert.deepEqual(deploys, ["acme/docs@a1", "acme/docs@lost1"]);
});

test("unchanged repos cost a 304, and a rate limit stops the sweep without losing state", async () => {
  const { store, gh, deploy } = setup();
  track(store, "acme/api", "main");
  gh.push("acme/api", "x1");
  await runWorker(store, gh, deploy, 0);
  await reconcile(store, gh, 0);
  const quiet = await reconcile(store, gh, 1);
  assert.equal(quiet.notModified, 2);
  gh.push("acme/api", "x2");
  gh.failNext.push({ kind: "rate_limited", resetAt: 5_000 });
  const limited = await reconcile(store, gh, 2);
  assert.equal(limited.rateLimitedUntil, 5_000);
  const paused = await reconcile(store, gh, 3, 500, limited.rateLimitedUntil);
  assert.equal(paused.checked, 0);
  const resumed = await reconcile(store, gh, 6_000);
  assert.deepEqual(resumed.replayed, ["acme/api@x2"]);
});

test("failed deploys retry with backoff, then dead-letter for a human", async () => {
  const { store, gh } = setup();
  let calls = 0;
  const dead: string[] = [];
  const failing = async () => { calls += 1; throw new Error("build failed"); };
  const opts = { maxAttempts: 3, baseDelayMs: 100, onDeadLetter: (s: { repo: string }) => dead.push(s.repo) };
  await runWorker(store, gh, failing, 0, opts);
  assert.equal(store.get("acme/docs")?.nextAttemptAt, 100);
  await runWorker(store, gh, failing, 50, opts);       // too early: no attempt
  assert.equal(calls, 1);
  await runWorker(store, gh, failing, 100, opts);
  assert.equal(store.get("acme/docs")?.nextAttemptAt, 300);
  await runWorker(store, gh, failing, 300, opts);
  assert.equal(store.get("acme/docs")?.deadLetter, true);
  assert.deepEqual(dead, ["acme/docs"]);
  const report = await reconcile(store, gh, 400);
  assert.equal(report.checked, 0);                     // dead-lettered repos wait for a human
});

test("a GitHub error during deploy counts as a failed attempt, not a lost event", async () => {
  const { store, gh, deploys, deploy } = setup();
  gh.failNext.push({ kind: "error", status: 502 });
  await runWorker(store, gh, deploy, 0, { baseDelayMs: 10 });
  assert.equal(store.get("acme/docs")?.dirty, true);
  await runWorker(store, gh, deploy, 10, { baseDelayMs: 10 });
  assert.deepEqual(deploys, ["acme/docs@a1"]);
});

test("a webhook that arrives during a deploy is not erased by the worker", async () => {
  const { store, gh, deploys } = setup();
  let inject = true;
  const deploy = async (repo: string, sha: string) => {
    deploys.push(`${repo}@${sha}`);
    if (inject) {                       // a new push and its webhook land mid-deploy
      inject = false;
      gh.push("acme/docs", "mid");
      receivePush(store, SECRET, signed(pushBody("acme/docs", "mid"), "during"));
    }
  };
  await runWorker(store, gh, deploy, 0);
  assert.equal(store.get("acme/docs")?.dirty, true);
  await runWorker(store, gh, deploy, 1);
  assert.deepEqual(deploys, ["acme/docs@a1", "acme/docs@mid"]);
  assert.equal(store.get("acme/docs")?.dirty, false);
});

test("a webhook that arrives during a reconciler check is not erased", async () => {
  const { store, gh, deploy } = setup();
  await runWorker(store, gh, deploy, 0);
  const real = gh.getHead.bind(gh);
  gh.getHead = async (repo, branch, etag) => {
    gh.push("acme/docs", "mid");
    receivePush(store, SECRET, signed(pushBody("acme/docs", "mid"), "during-sweep"));
    return real(repo, branch, etag);
  };
  await reconcile(store, gh, 5);
  assert.equal(store.get("acme/docs")?.dirty, true);
});

test("a request budget smaller than the repo count still covers every repo across sweeps", async () => {
  const store = new MemoryStore();
  const gh = new FakeGitHub();
  for (let i = 0; i < 5; i++) { track(store, `acme/r${i}`, "main"); gh.push(`acme/r${i}`, "s0"); }
  await runWorker(store, gh, async () => {}, 0);
  const seen = new Set<string>();
  const real = gh.getHead.bind(gh);
  gh.getHead = async (repo, branch, etag) => { seen.add(repo); return real(repo, branch, etag); };
  for (let sweep = 1; sweep <= 3; sweep++) await reconcile(store, gh, sweep * 1000, 2);
  assert.equal(seen.size, 5);
});
