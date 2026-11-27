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
async function ingress(
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
async function run(...args: Parameters<typeof ingress>) {
  const decision = await ingress(...args);
  assert.ok(!decision || !("closure" in decision));
  return decision;
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
    "Please ask @helper to take a look.",
    "(@helper)",
    "cc: (@helper[bot]) please review",
    "- ((**@helper**)) please review",
    "~~withdrawn request~~ please ask (@helper) instead",
    "~do not ask @helper~ but please ask **@helper** now",
    "@helper review the diff\n\n```\n" + "[]".repeat(1000) + "\n```",
    "<!-- instructions -->\n\n@helper please review",
    "- **@helper** please review",
    "1. _@helper_ please review",
    "> old request @helper\n\n@helper please answer the new one",
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
    "the example was `@helper please review`",
    "```text\n@helper please review\n```",
    "    @helper please review",
    "> @helper please review",
    "- > @helper please review",
    "<!-- @helper -->",
    "<span>@helper</span>",
    "<kbd>**@helper**</kbd>",
    "<details>\n\n@helper\n\n</details>",
    "~~please ask @helper to do this~~",
    "~please ask @helper for help~",
    "~~withdrawn **@helper** request~~",
    "**~withdrawn (@helper) request~**",
    "cc: (@helper-other)",
    "https://example.test/(@helper)",
    "[reference](https://example.test/(@helper))",
    "> " + "> ".repeat(3000) + "@helper",
    "[ping @helper](https://example.test)",
    "https://example.test/@helper",
    "https://example.test/?to=@helper",
    "\\@helper please review",
    "&#64;helper please review",
    "@helper/team",
    "mail**@helper**",
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

test("private lifecycle input requires a closed target in the signed repository scope", async () => {
  const { installation, repository } = event();
  const payload = {
    action: "closed",
    installation,
    repository,
    sender: { id: 7, login: "merge-queue[bot]", type: "Bot" },
    pull_request: {
      number: 5,
      state: "closed",
      closed_at: "2026-11-26T01:00:00Z",
      base: { repo: repository },
    },
  };
  assert.deepEqual(await ingress(payload, "pull_request"), {
    closure: {
      bindingId: "b",
      installationId: 1,
      repositoryId: 2,
      owner: "org",
      repo: "repo",
      target: { kind: "pull_request", number: 5 },
      githubTime: Date.parse(payload.pull_request.closed_at),
    },
  });
  for (const inconsistent of [
    { ...payload, action: "synchronize" },
    { ...payload, installation: { id: 9 } },
    { ...payload, repository: { ...repository, name: "other" } },
    { ...payload, pull_request: { ...payload.pull_request, state: "open" } },
    {
      ...payload,
      pull_request: { ...payload.pull_request, base: { repo: { id: 9 } } },
    },
  ]) {
    assert.equal(await ingress(inconsistent, "pull_request"), null);
  }
});
