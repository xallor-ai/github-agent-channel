import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/store.js";
import { seedBinding } from "./binding-fixture.js";
import type { NewTask } from "../src/contracts.js";
const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  },
  pin = (head: string) => ({
    baseRepoId: 2,
    headRepoId: 2,
    baseSha: "a".repeat(40),
    headSha: head.repeat(40),
  });
function fixture(t: test.TestContext) {
  const s = new TaskStore(":memory:");
  t.after(() => s.close());
  const b = seedBinding(s, scope, "device", [
    "pull_request.synchronize",
    "pull_request.closed",
    "issue_comment.created",
  ]);
  let n = 0;
  const observe = (
    head: string,
    time: number | undefined,
    deliveryId = "d" + ++n,
    number = 7,
  ) => {
    const input: NewTask = {
      ...scope,
      bindingId: b.id,
      deliveryId,
      prompt: "review",
      actorId: 4,
      actorLogin: "alice",
      source: { event: "pull_request", action: "synchronize" },
      target: { kind: "pull_request", number, revision: pin(head) },
    };
    return s.observe({
      input,
      reason: "review",
      execute: true,
      githubTime: time,
    });
  };
  return { s, b, observe };
}
test("recorded drift remains immutable, matching later delivery uses signed time and respects late close", (t) => {
  const { s, b, observe } = fixture(t);
  const first = observe("b", 100).taskId!;
  s.recordReviewDrift(first, pin("c"));
  assert.equal(s.reviewLineage(first)?.successorTaskId, null);
  s.recordReviewDrift(first, pin("d"));
  assert.deepEqual(s.reviewLineage(first)?.observedRevision, pin("c"));
  observe("c", 150, undefined, 8);
  assert.equal(s.reviewLineage(first)?.successorTaskId, null);
  const second = observe("c", 200).taskId!;
  assert.equal(s.reviewLineage(first)?.successorTaskId, second);
  assert.equal(s.get(first)?.status, "rejected");
  s.closeThread({
    ...scope,
    bindingId: b.id,
    target: { kind: "pull_request", number: 7 },
    githubTime: 150,
  });
  assert.equal(s.reviewLineage(first)?.successorTaskId, null);
  assert.equal(s.reviewLineage(first)?.reason, "lifecycle_uncertain");
});
test("signed return after distinct intervening review creates fresh generation without replaying original delivery", (t) => {
  const { s, observe } = fixture(t);
  const h1 = observe("b", 100, "first").taskId!;
  s.recordReviewDrift(h1, pin("c"));
  const h2 = observe("c", 200).taskId!;
  const h3 = observe("b", 300, "third").taskId!;
  assert.ok(h3 && h2 && h3 !== h1 && h3 !== h2);
  assert.equal(observe("b", 100, "first").taskId, h1);
  assert.equal(observe("b", 300, "repeated-return").taskId, h3);
  assert.equal(observe("b", 100, "distinct-id-for-old-action").taskId, null);
  s.recordReviewDrift(h2, pin("b"));
  assert.equal(s.reviewLineage(h2)?.successorTaskId, h3);
  assert.ok(s.publicationAllowed(h3));
});
test("same-second revisions do not establish a successor and out-of-repo facts cannot create a drift fence", (t) => {
  const { s, observe } = fixture(t);
  const a = observe("b", 100).taskId!;
  observe("c", 100);
  s.recordReviewDrift(a, { ...pin("c"), headRepoId: 3 });
  assert.equal(s.reviewLineage(a), null);
  assert.ok(s.publicationAllowed(a));
  s.recordReviewDrift(a, pin("c"));
  assert.equal(s.reviewLineage(a)?.successorTaskId, null);
  assert.equal(s.reviewLineage(a)?.reason, "ambiguous_order");
});
test("an already running review retains the actual outcome, not a stop receipt, and cannot publish after a witnessed replacement", (t) => {
  const { s, observe } = fixture(t);
  const a = observe("b", 100).taskId!;
  s.claimAssignment("device", "hash", Date.now() + 10000);
  const summary = {
    revision: pin("b"),
    changedFiles: 2,
    suppliedFiles: 1,
    completePatches: 0,
    truncatedPatches: 1,
    unavailablePatches: 0,
    limited: true,
  };
  s.recordReviewInput(a, summary);
  s.recordReviewInput(a, {
    ...summary,
    completePatches: 1,
    truncatedPatches: 0,
  });
  assert.equal(s.reviewInput(a)?.truncatedPatches, 1);
  s.recordReviewDrift(a, pin("c"));
  assert.equal(s.get(a)?.status, "running");
  s.finishAssignment(
    a,
    "device",
    "hash",
    {
      status: "succeeded",
      outcome: {
        text: "Reviewed old input",
        artifacts: [],
        publication: { kind: "comment" },
      },
    },
    "digest",
  );
  assert.equal(s.get(a)?.status, "succeeded");
  assert.equal(s.get(a)?.deliveryStatus, "skipped");
  assert.equal(s.pendingDelivery(), undefined);
});
test("a previously published result stays independently verifiable after a new revision", (t) => {
  const { s, observe } = fixture(t);
  const a = observe("b", 100).taskId!;
  s.claimAssignment("device", "hash", Date.now() + 10000);
  s.finishAssignment(
    a,
    "device",
    "hash",
    {
      status: "succeeded",
      outcome: {
        text: "old verdict",
        artifacts: [],
        publication: { kind: "comment" },
      },
    },
    "digest",
  );
  s.pendingDelivery();
  const receipt = {
    kind: "comment" as const,
    id: 23,
    url: "https://github.com/org/repo/pull/7#issuecomment-23",
  };
  s.markDelivery(a, "sent", receipt);
  const b = observe("c", 200).taskId!;
  s.recordReviewDrift(a, pin("c"));
  assert.equal(s.get(a)?.deliveryStatus, "sent");
  assert.deepEqual(s.previousPublishedReview(b)?.publicationReceipt, receipt);
});
test("a witnessed signed return fences an earlier running generation even without a different live SHA read", (t) => {
  const { s, observe } = fixture(t);
  const first = observe("b", 100).taskId!;
  s.claimAssignment("device", "lease", Date.now() + 10_000);
  const pivot = observe("c", 200).taskId!,
    current = observe("b", 300).taskId!;
  assert.ok(current && current !== first);
  assert.equal(s.get(first)?.status, "running");
  assert.equal(s.publicationAllowed(first), false);
  assert.equal(s.publicationAllowed(current), true);
  const line = s.reviewLineage(first);
  assert.equal(line?.observedRevision, null);
  assert.equal(line?.generation?.intermediateTaskId, pivot);
  assert.equal(line?.successorTaskId, current);
  s.finishAssignment(
    first,
    "device",
    "lease",
    {
      status: "succeeded",
      outcome: { text: "old", artifacts: [], publication: { kind: "comment" } },
    },
    "old",
  );
  assert.equal(s.get(first)?.deliveryStatus, "skipped");
});
test("late intermediate webhook detaches previously coalesced future deliveries without replay or inherited receipts", (t) => {
  const { s, b, observe } = fixture(t);
  const first = observe("b", 100, "a").taskId!;
  s.claimAssignment("device", "lease", Date.now() + 10_000);
  s.finishAssignment(
    first,
    "device",
    "lease",
    {
      status: "succeeded",
      outcome: {
        text: "prior",
        artifacts: [],
        publication: { kind: "comment" },
      },
    },
    "1",
  );
  s.pendingDelivery();
  s.markDelivery(first, "sent", {
    kind: "comment",
    id: 7,
    url: "https://github.com/org/repo/pull/7#issuecomment-7",
  });
  assert.equal(observe("b", 300, "c").taskId, first);
  observe("c", 200, "b");
  assert.equal(s.get(first)?.deliveryStatus, "sent");
  assert.equal(s.activityReceipt("c")?.taskId, null);
  assert.equal(
    s.activityReceipt("c")?.reviewFollowUp,
    "review_generation_unconfirmed",
  );
  assert.equal(observe("b", 300, "c").taskId, null);
  assert.equal(observe("b", 300, "copy-of-c").taskId, null);
  assert.equal(s.reviewLineage(first)?.generation?.successorTaskId, null);
  s.closeThread({
    ...scope,
    bindingId: b.id,
    target: { kind: "pull_request", number: 7 },
    githubTime: 125,
  });
  assert.equal(s.reviewLineage(first)?.generation, null);
});
