import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/store.js";
import { seedBinding, fixtureAgent } from "./binding-fixture.js";
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
  s.recordReviewDrift(first, pin("c"), 500);
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
  assert.equal(s.reviewLineage(a)?.observedRevision, null);
  assert.equal(s.reviewPublicationCurrent(a), false);
  assert.equal(s.reviewLineage(a)?.reason, "ambiguous_order");
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
  const recovered = s.activityReceipt("c")?.taskId;
  assert.ok(recovered && recovered !== first);
  assert.equal(s.get(recovered)?.deliveryStatus, "pending");
  assert.equal(observe("b", 300, "c").taskId, recovered);
  assert.equal(observe("b", 300, "copy-of-c").taskId, recovered);
  assert.equal(s.reviewLineage(first)?.generation?.successorTaskId, recovered);
  s.closeThread({
    ...scope,
    bindingId: b.id,
    target: { kind: "pull_request", number: 7 },
    githubTime: 125,
  });
  assert.equal(s.reviewLineage(first)?.generation, null);
});
test("a late event cannot corroborate an earlier drift using the local clock alone", (t) => {
  const { s, observe } = fixture(t);
  const original = observe("b", 100).taskId!;
  s.recordReviewDrift(original, pin("c"));
  observe("c", 200);
  assert.equal(s.reviewLineage(original)?.successorTaskId, null);
});
test("an undated published review prevents guessing which published revision was previous", (t) => {
  const { s, observe } = fixture(t);
  function publish(head: string, time: number | undefined, id: number) {
    const t = observe(head, time).taskId!;
    s.claimAssignment("device", "lease", Date.now() + 60000);
    s.finishAssignment(
      t,
      "device",
      "lease",
      {
        status: "succeeded",
        outcome: {
          text: "review",
          artifacts: [],
          publication: { kind: "comment" },
        },
      },
      "done",
    );
    s.pendingDelivery();
    s.markDelivery(t, "sent", {
      kind: "comment",
      id,
      url: `https://github.com/org/repo/pull/7#issuecomment-${id}`,
    });
  }
  publish("b", 100, 7);
  publish("c", undefined, 8);
  const current = observe("d", 300).taskId!;
  assert.equal(s.previousPublishedReview(current), null);
});

test("a signed change on a new binding cannot name the previous binding's task as successor", (t) => {
  const { s, b, observe } = fixture(t);
  const old = observe("b", 100, "original").taskId!;
  assert.equal(
    s.claimAssignment("device", "lease", Date.now() + 60000)?.id,
    old,
  );
  s.finishAssignment(
    old,
    "device",
    "lease",
    {
      status: "succeeded",
      outcome: {
        publication: { kind: "comment" },
        text: "Original",
        artifacts: [],
      },
    },
    "ok",
  );
  s.pendingDelivery();
  s.markDelivery(old, "sent", {
    kind: "comment",
    id: 51,
    url: "https://github.com/org/repo/pull/7#issuecomment-51",
  });
  s.registry.apply({ ...scope, deviceId: "device", administratorId: 44 }, 1, {
    enabled: true,
    responsibleAgent: fixtureAgent,
    nativeReview: true,
    events: ["pull_request.synchronize"],
  });
  const live = s.activeBinding(1, 2)!;
  assert.notEqual(live.id, b.id);
  const receive = (head: string, time: number) =>
    s.observe({
      execute: true,
      reason: "review",
      githubTime: time,
      input: {
        ...scope,
        deliveryId: "new-" + time,
        bindingId: live.id,
        actorLogin: "alice",
        actorId: 4,
        prompt: "review",
        source: { event: "pull_request", action: "synchronize" },
        target: { kind: "pull_request", number: 7, revision: pin(head) },
      },
    });
  const second = receive("c", 200).taskId!;
  const alias = receive("b", 300);
  assert.equal(alias.taskId, old);
  assert.equal(s.reviewPublicationCurrent(second), false);
  const relation = s.reviewLineage(second);
  assert.ok(relation?.signedChange);
  assert.equal(relation.successorTaskId, null);
  assert.equal(s.get(old)?.publicationReceipt?.id, 51);
});
test("a same-second competing predecessor and later return cannot authorize the old task", (t) => {
  const { s, observe } = fixture(t),
    old = observe("b", 100).taskId!;
  s.claimAssignment("device", "lease", Date.now() + 60000);
  observe("c", 100);
  const ret = observe("b", 300);
  assert.equal(ret.taskId, null);
  assert.equal(s.reviewPublicationCurrent(old), false);
  assert.equal(s.reviewLineage(old)?.reason, "ambiguous_order");
});
test("an unassigned drifted return recovers from its own retained event when intermediate evidence arrives", (t) => {
  const { s, observe } = fixture(t),
    old = observe("b", 100).taskId!;
  s.recordReviewDrift(old, pin("c"));
  const ret = observe("b", 300, "returned");
  assert.equal(ret.taskId, null);
  observe("c", 200);
  const recovered = s.activityReceipt("returned")?.taskId;
  assert.ok(recovered && recovered !== old);
  assert.equal(s.get(recovered)?.deliveryId, "returned");
  assert.equal(observe("b", 300, "returned").taskId, recovered);
  assert.equal(s.reviewPublicationCurrent(old), false);
  assert.equal(s.reviewPublicationCurrent(recovered), true);
});
test("a strictly later signed different revision blocks the old write before a return webhook or drift GET", (t) => {
  const { s, observe } = fixture(t),
    old = observe("b", 100).taskId!;
  s.claimAssignment("device", "lease", Date.now() + 60000);
  const second = observe("c", 200, "next").taskId!;
  assert.equal(s.reviewPublicationCurrent(old), false);
  assert.equal(s.reviewLineage(old)?.observedRevision, null);
  assert.equal(s.reviewLineage(old)?.reason, "signed_later_version");
  assert.equal(s.reviewLineage(old)?.successorTaskId, second);
  assert.equal(s.reviewPublicationCurrent(second), true);
});
