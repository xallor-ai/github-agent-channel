import test from "node:test";
import assert from "node:assert/strict";
import { Webhooks } from "@octokit/webhooks";
import { normalizeWebhook } from "../src/webhook.js";
import type { Binding } from "../src/contracts.js";

const config = {
  github: { botLogin: "helper[bot]" },
  bindings: [
    {
      id: "b",
      installationId: 1,
      repositoryId: 2,
      owner: "org",
      repo: "repo",
      enabled: true,
      events: ["issue_comment.created"],
    },
  ],
} as { github: { botLogin: string }; bindings: Binding[] };
const event = () => ({
  action: "created",
  installation: { id: 1 },
  repository: { id: 2, name: "repo", owner: { login: "org" } },
  sender: { id: 3, login: "reader", type: "User" },
  comment: {
    id: 4,
    body: "@helper[bot] explain this",
    user: { id: 3, login: "reader", type: "User" },
  },
  issue: { number: 5, state: "open" },
});
async function run(
  payload: unknown,
  eventName = "issue_comment",
  settings = config,
) {
  const raw = Buffer.from(JSON.stringify(payload));
  return normalizeWebhook(
    {
      github: settings.github,
      lookup: (i, r) =>
        settings.bindings.find(
          (b) => b.installationId === i && b.repositoryId === r,
        ),
    },
    raw,
    {
      signature: await new Webhooks({ secret: "test" }).sign(raw.toString()),
      delivery: "12345678-1234-1234-1234-123456789abc",
      event: eventName,
    },
    "test",
  );
}
test("valid signed mention constructs only server scope", async () => {
  const result = await run(event());
  assert.equal(result?.input.repositoryId, 2);
  assert.equal(result?.input.actorId, 3);
  assert.equal(result?.execute, true);
  assert.equal(result?.reason, "mention");
  assert.deepEqual(result?.input.target, { kind: "issue", number: 5 });
  assert.equal(result?.input.source.commentId, 4);
});

test("accepts bot slug mentions while rejecting lookalike names", async () => {
  for (const body of [
    "@helper please analyze",
    "@HELPER[bot] please analyze",
  ]) {
    const payload = event();
    payload.comment.body = body;
    assert.equal((await run(payload))?.reason, "mention");
  }
  for (const body of [
    "@helper-other",
    "@helper[bot]-other",
    "mail@helper",
    "@helper_name",
  ]) {
    const payload = event();
    payload.comment.body = body;
    assert.equal((await run(payload))?.reason, "observed");
  }
});
test("a signed mention on a closed PR does not start a task", async () => {
  assert.deepEqual(
    (
      await run({
        ...event(),
        issue: { number: 5, state: "open", pull_request: {} },
      })
    )?.input.target,
    { kind: "pull_request", number: 5 },
  );
  assert.equal(
    (
      await run({
        ...event(),
        issue: { number: 5, state: "closed", pull_request: {} },
      })
    )?.reason,
    "closed",
  );
});
test("invalid signature rejected before malformed JSON parse", async () => {
  await assert.rejects(
    normalizeWebhook(
      { github: config.github, lookup: () => config.bindings[0] },
      Buffer.from("{"),
      {
        signature: "sha256=" + "0".repeat(64),
        delivery: "bad",
        event: "issue_comment",
      },
      "test",
    ),
    /signature/i,
  );
});
test("unsupported, edited, bot and mismatched identities or scope ignored", async () => {
  assert.equal(await run(event(), "issues"), null);
  for (const mutate of [
    (x: ReturnType<typeof event>) => {
      x.action = "edited";
    },
    (x: ReturnType<typeof event>) => {
      x.sender.type = "Bot";
    },
    (x: ReturnType<typeof event>) => {
      x.sender.id = 7;
    },
    (x: ReturnType<typeof event>) => {
      x.installation.id = 7;
    },
    (x: ReturnType<typeof event>) => {
      x.repository.id = 7;
    },
    (x: ReturnType<typeof event>) => {
      x.repository.name = "other";
    },
    (x: ReturnType<typeof event>) => {
      x.comment.id = -1;
    },
  ]) {
    const x = event();
    mutate(x);
    assert.equal(await run(x), null);
  }
});
test("delivery id must be UUID", async () => {
  const raw = Buffer.from(JSON.stringify(event()));
  await assert.rejects(
    normalizeWebhook(
      { github: config.github, lookup: () => config.bindings[0] },
      raw,
      {
        signature: await new Webhooks({ secret: "test" }).sign(raw.toString()),
        delivery: "../bad",
        event: "issue_comment",
      },
      "test",
    ),
    /delivery/i,
  );
});

test("ordinary comments update context only; self-replies are receipts", async () => {
  const p = event();
  p.comment.body = "ordinary request " + "x".repeat(18000);
  const received = await run(p);
  assert.equal(received?.execute, false);
  assert.equal(received?.reason, "observed");
  assert.equal(received?.input.prompt, p.comment.body);
  const bot = { id: 20, type: "Bot", login: "Helper[bot]" };
  const reply = {
    ...p,
    sender: bot,
    comment: { ...p.comment, user: bot, body: "@helper done" },
  };
  assert.equal((await run(reply))?.reason, "self_receipt");
  assert.equal((await run(reply))?.execute, false);
  assert.equal(await run({ ...reply, comment: p.comment }), null);
  const other = { ...bot, login: "other[bot]" };
  assert.equal(
    await run({
      ...reply,
      sender: other,
      comment: { ...reply.comment, user: other },
    }),
    null,
  );
});
test("event filters cannot enable unimplemented actions", async () => {
  const settings = {
    ...config,
    bindings: config.bindings.map((b) => ({
      ...b,
      events: ["issue_comment.edited"],
    })),
  };
  assert.equal(
    await run({ ...event(), action: "edited" }, "issue_comment", settings),
    null,
  );
  assert.equal(await run({ ...event(), issue: { number: 5 } }), null);
});

test("signed comment actions use their creation time and closed observations use the thread close time", async () => {
  const time = "2026-11-24T01:02:03Z",
    eventTime = "2026-11-25T01:02:03Z",
    payload = event();
  const comment = { ...payload.comment, created_at: eventTime };
  assert.equal(
    (await run({ ...payload, comment }))?.githubTime,
    Date.parse(eventTime),
  );
  assert.equal(
    (
      await run({
        ...payload,
        comment,
        issue: { ...payload.issue, state: "closed", closed_at: time },
      })
    )?.githubTime,
    Date.parse(time),
  );
  assert.equal(
    (await run({ ...payload, comment: { ...comment, created_at: "invalid" } }))
      ?.githubTime,
    undefined,
  );
});
