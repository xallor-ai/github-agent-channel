import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/store.js";
import { renderQuestionChoices } from "../src/outcomes.js";
import { seedBinding } from "./binding-fixture.js";
import type { NewTask } from "../src/contracts.js";

const scope = { owner: "org", repo: "app", installationId: 1, repositoryId: 2 };
function fixture(t: test.TestContext) {
  const after = Date.now() - 10000;
  const dir = mkdtempSync(join(tmpdir(), "question-")),
    path = join(dir, "cloud.db");
  let store = new TaskStore(path);
  const b = seedBinding(store, scope, "worker");
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let serial = 0;
  function comment(prompt: string, actorId = 3): NewTask {
    const n = ++serial;
    return {
      ...scope,
      bindingId: b.id,
      deliveryId: "d" + n,
      actorId,
      actorLogin: "person" + actorId,
      target: { kind: "issue", number: 9 },
      prompt,
      source: { event: "issue_comment", action: "created", commentId: n },
    };
  }
  function receive(input: NewTask, time = after + 2000) {
    return store.observe({
      input,
      execute: false,
      reason: "observed",
      githubTime: time,
    });
  }
  function request(prompt: string) {
    const q = store.observe({
      input: comment(prompt),
      execute: true,
      reason: "mention",
      githubTime: after - 1000,
    });
    return q.taskId!;
  }
  function ask(id: string, q: string, receiptTime = after, unknown = false) {
    assert.equal(
      store.claimAssignment("worker", "lease", Date.now() + 60_000)?.id,
      id,
    );
    store.finishAssignment(
      id,
      "worker",
      "lease",
      {
        status: "succeeded",
        outcome: {
          publication: { kind: "clarification" },
          artifacts: [],
          text: q,
        },
      },
      "digest",
    );
    assert.equal(store.pendingDelivery(receiptTime - 1000)?.id, id);
    const receipt = {
      kind: "comment" as const,
      id: 11,
      url: "https://github.com/org/app/issues/9#issuecomment-11",
      createdAt: receiptTime,
    };
    if (unknown) store.markDelivery(id, "unknown");
    else store.markDelivery(id, "sent", receipt);
    return receipt;
  }
  return {
    get store() {
      return store;
    },
    after,
    b,
    comment,
    receive,
    request,
    ask,
    restart() {
      store.close();
      store = new TaskStore(path);
      store.recover();
    },
  };
}
test("a verified posted question can resume only its original actor and root, once, across restarts", (t) => {
  const f = fixture(t);
  const id = f.request("original task"),
    receipt = f.ask(id, "Which test?", f.after, true);
  assert.equal(f.receive(f.comment("early"), f.after - 1000).taskId, null);
  assert.throws(() =>
    f.store.resolveUnknownDelivery(id, "sent", {
      kind: "comment",
      id: 11,
      url: receipt.url,
    }),
  );
  assert.equal(f.store.get(id)?.deliveryStatus, "unknown");
  f.store.resolveUnknownDelivery(id, "sent", receipt);
  f.restart();
  assert.equal(f.store.clarificationState(id)?.status, "waiting");
  for (const prompt of [
    "@other please inspect",
    "@org/team take this",
    "/other-command one",
    "FYI @bob handle this",
    "please ask @org/team to look",
  ]) {
    assert.equal(f.receive(f.comment(prompt)).taskId, null);
    assert.equal(f.store.clarificationState(id)?.status, "waiting");
  }
  assert.equal(f.receive(f.comment("other author", 99)).taskId, null);
  assert.equal(f.receive(f.comment("unordered"), f.after).taskId, null);
  const answer = f.comment("use unit tests");
  const run = f.receive(answer).taskId!;
  assert.ok(run && run !== id);
  assert.deepEqual(f.store.get(run)?.continuation, {
    history: [],
    rootTaskId: id,
    questionTaskId: id,
    originalPrompt: "original task",
    question: "Which test?",
  });
  assert.equal(f.store.clarificationState(id)?.answerTaskId, run);
  assert.equal(f.receive({ ...answer, deliveryId: "redelivery" }).taskId, run);
  assert.equal(f.receive(f.comment("unrelated")).taskId, null);
  f.ask(run, "Which platform?", f.after + 2500);
  const next = f.receive(f.comment("Linux"), f.after + 3000).taskId!;
  assert.equal(f.store.get(next)?.continuation?.rootTaskId, id);
  assert.equal(f.store.get(next)?.continuation?.questionTaskId, run);
  const conversation = f.store.conversation(next);
  assert.deepEqual(conversation, f.store.conversation(id));
  assert.deepEqual(
    conversation?.turns.map((e) => e.taskId),
    [id, run, next],
  );
  assert.equal(conversation?.turns.at(-1)?.nextTaskId, null);
  assert.deepEqual(f.store.get(next)?.continuation?.history, [
    { question: "Which test?", answer: "use unit tests" },
  ]);
  f.store.closeThread({
    ...scope,
    bindingId: f.b.id,
    target: { kind: "issue", number: 9 },
    githubTime: f.after + 500,
  });
  assert.equal(f.store.get(next)?.status, "rejected");
});
test("competing questions require a scoped selection; invalid, stale or cross-thread references cannot consume a question", (t) => {
  const f = fixture(t),
    a = f.request("alpha");
  f.ask(a, "What A?");
  const b = f.request("bravo");
  f.ask(b, "What B?");
  const notice = f.receive(f.comment("yes")).taskId!;
  assert.deepEqual(
    new Set(f.store.get(notice)?.questionChoices),
    new Set([a, b]),
  );
  for (const input of [
    f.comment("/answer unknown yes"),
    f.comment("/answer " + a + " yes", 42),
    {
      ...f.comment("/answer " + a + " yes"),
      target: { kind: "issue" as const, number: 88 },
    },
  ]) {
    assert.equal(f.receive(input).reason, "clarification_unmatched");
  }
  const reply = f.receive(f.comment("/answer " + a + " line one\nline two"));
  assert.equal(reply.reason, "clarification_reply");
  assert.equal(f.store.get(reply.taskId!)?.prompt, "line one\nline two");
  assert.equal(
    f.receive(f.comment("/answer " + a + " already consumed")).taskId,
    null,
  );
  assert.equal(f.store.clarificationState(b)?.status, "waiting");
});
test("expired or retired questions cannot start a new run", (t) => {
  const f = fixture(t),
    a = f.request("alpha");
  f.ask(a, "What?", f.after - 8 * 86400000);
  assert.equal(f.store.clarificationState(a)?.status, "expired");
  assert.equal(f.receive(f.comment("/answer " + a + " never")).taskId, null);
  const b = f.request("bravo");
  f.ask(b, "what?");
  f.store.registry.apply(
    { ...scope, deviceId: "worker", administratorId: 44 },
    1,
    { enabled: false },
  );
  assert.equal(f.store.clarificationState(b)?.status, "retired");
});
test("expiry drops an unconfirmed explicit answer without changing the question or replaying it later", (t) => {
  const f = fixture(t),
    q = f.request("initial"),
    receipt = f.ask(q, "which?", f.after, true),
    input = f.comment("/answer " + q + " private draft");
  f.receive(input);
  f.store.expireTasks(Date.now() + 25 * 3600000);
  f.restart();
  assert.equal(
    f.store.activityReceipt(input.deliveryId)?.reason,
    "clarification_unmatched",
  );
  f.store.resolveUnknownDelivery(q, "sent", receipt);
  assert.equal(f.store.clarificationState(q)?.status, "waiting");
  assert.equal(f.store.activityReceipt(input.deliveryId)?.taskId, null);
});
test("a second question with an unconfirmed write prevents assigning implicit replies to the older question", (t) => {
  const f = fixture(t),
    first = f.request("one");
  f.ask(first, "First?");
  const second = f.request("two");
  f.ask(second, "Second?", f.after + 1000, true);
  assert.equal(f.receive(f.comment("new context")).taskId, null);
  assert.equal(f.store.clarificationState(first)?.status, "waiting");
  assert.equal(
    f.receive(f.comment("    /answer " + first + " example")).reason,
    "clarification_unmatched",
  );
  assert.equal(
    f.receive(f.comment("/answer " + first + " first answer")).reason,
    "clarification_reply",
  );
});
test("an explicitly addressed answer can be activated after delayed confirmation; preserve receipts and one run", (t) => {
  const f = fixture(t);
  const q = f.request("inspect"),
    receipt = f.ask(q, "Which?", f.after, true);
  const early = f.comment("/answer " + q + " premature");
  f.receive(early, f.after - 1000);
  const old = f.receive(
    f.comment("ordinary answer before publication"),
    f.after - 1000,
  );
  const input = f.comment("/answer " + q + " check L2");
  const d = f.receive(input);
  assert.equal(d.reason, "clarification_pending");
  assert.equal(d.taskId, null);
  f.receive({ ...input, deliveryId: "alias" });
  f.store.confirmActivities(
    "worker",
    { type: "openclaw", id: "github", deepReview: true, nativeReview: true },
    f.b.id,
    [{ cursor: d.cursor, deliveryId: input.deliveryId }],
  );
  assert.equal(f.store.ownerReceipt(input.deliveryId)?.reaction, null);
  f.restart();
  f.store.resolveUnknownDelivery(q, "sent", receipt);
  const answer = f.store.activityReceipt(input.deliveryId);
  assert.equal(answer?.reason, "clarification_reply");
  assert.ok(answer?.taskId);
  assert.equal(f.store.activityReceipt("alias")?.taskId, answer.taskId);
  assert.equal(f.store.get(answer.taskId)?.prompt, "check L2");
  assert.equal(f.store.get(answer.taskId)?.continuation?.rootTaskId, q);
  assert.equal(
    f.store.ownerReceipt(input.deliveryId)?.reaction?.status,
    "pending",
  );
  assert.equal(f.store.clarificationState(q)?.answerTaskId, answer.taskId);
  assert.equal(
    f.store.activityReceipt(early.deliveryId)?.reason,
    "clarification_unmatched",
  );
  assert.equal(old.taskId, null);
});
test("a unique inflight question holds an implicit reply without claiming silent handling until GitHub confirms chronology", (t) => {
  const f = fixture(t),
    q = f.request("root"),
    r = f.ask(q, "Which?", f.after, true);
  const ans = f.comment("use head\nlogs say @bob too");
  assert.equal(f.receive(ans).reason, "clarification_pending");
  f.restart();
  f.store.resolveUnknownDelivery(q, "sent", r);
  const result = f.store.activityReceipt(ans.deliveryId);
  assert.equal(result?.reason, "clarification_reply");
  assert.equal(f.store.get(result!.taskId!)?.continuation?.questionTaskId, q);
});
test("obsolete choices cannot be sent after a delayed close retires both questions", (t) => {
  const f = fixture(t),
    a = f.request("first");
  f.ask(a, "A?");
  const b = f.request("second");
  f.ask(b, "B?");
  const choice = f.receive(f.comment("which?"), f.after + 3000).taskId!;
  const task = f.store.claimAssignment("worker", "x", Date.now() + 60_000)!;
  assert.equal(task.id, choice);
  f.store.finishAssignment(
    choice,
    "worker",
    "x",
    {
      status: "succeeded",
      outcome: {
        publication: { kind: "comment" },
        artifacts: [],
        text: renderQuestionChoices(task.questionChoices!),
      },
    },
    "digest",
  );
  f.store.closeThread({
    ...scope,
    bindingId: f.b.id,
    target: { kind: "issue", number: 9 },
    githubTime: f.after + 1000,
  });
  assert.equal(f.store.pendingDelivery(), undefined);
  assert.equal(f.store.publicationAllowed(choice), false);
  assert.equal(f.store.get(choice)?.deliveryStatus, "skipped");
  assert.match(f.store.get(choice)?.error ?? "", /choices changed/);
});
test("retired, expired or pre-attempt unconfirmed writes never capture an implicit reply", (t) => {
  const f = fixture(t),
    q = f.request("first");
  f.ask(q, "Past?", f.after - 8 * 86400000, true);
  assert.equal(
    f.receive(f.comment("nobody requested this")).reason,
    "observed",
  );
  assert.equal(
    f.receive(f.comment("/answer " + q + " old")).reason,
    "clarification_unmatched",
  );
});
test("late and same-second deliveries cannot consume a remaining question by erasing a historical competitor; obsolete pick is skipped", (t) => {
  const f = fixture(t),
    a = f.request("first");
  f.ask(a, "A?");
  const b = f.request("second");
  f.ask(b, "B?");
  const choice = f.receive(f.comment("ambiguous"), f.after + 1000).taskId!;
  f.receive(f.comment("/answer " + a + " yes"), f.after + 4000);
  for (const signed of [f.after + 2000, f.after + 4000])
    assert.equal(
      f.receive(f.comment("late"), signed).reason,
      "clarification_unmatched",
    );
  assert.equal(f.store.clarificationState(b)?.status, "waiting");
  assert.equal(
    f.store.claimAssignment("worker", "token", Date.now() + 60000),
    undefined,
  );
  assert.match(f.store.get(choice)?.error ?? "", /choices changed/);
});
