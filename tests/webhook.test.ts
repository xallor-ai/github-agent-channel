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
  issue: { number: 5 },
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
  assert.equal(result?.repositoryId, 2);
  assert.equal(result?.actorId, 3);
  assert.deepEqual(result?.target, { kind: "issue", number: 5 });
  assert.equal(result?.source.commentId, 4);
});

test("accepts bot slug mentions while rejecting lookalike names", async () => {
  for (const body of [
    "@helper please analyze",
    "@HELPER[bot] please analyze",
  ]) {
    const payload = event();
    payload.comment.body = body;
    assert.equal((await run(payload))?.actorId, 3);
  }
  for (const body of [
    "@helper-other",
    "@helper[bot]-other",
    "mail@helper",
    "@helper_name",
  ]) {
    const payload = event();
    payload.comment.body = body;
    assert.equal(await run(payload), null);
  }
});
test("a signed mention on a closed PR does not start a task", async () => {
  assert.deepEqual(
    (
      await run({
        ...event(),
        issue: { number: 5, state: "open", pull_request: {} },
      })
    )?.target,
    { kind: "pull_request", number: 5 },
  );
  assert.equal(
    await run({
      ...event(),
      issue: { number: 5, state: "closed", pull_request: {} },
    }),
    null,
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
test("unsupported, edited, bot, mismatched identities/scope and partial mentions ignored", async () => {
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
    (x: ReturnType<typeof event>) => {
      x.comment.body = "mail@helper[bot]";
    },
    (x: ReturnType<typeof event>) => {
      x.comment.body = "@helper[bot]-other";
    },
    (x: ReturnType<typeof event>) => {
      x.comment.body += "x".repeat(16000);
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

test("mention-free binding accepts open human comments and opened issues, not bot or closed traffic", async () => {
  const c = {
    ...config,
    bindings: config.bindings.map((b) => ({
      ...b,
      requireMention: false,
      events: ["issue_comment.created", "issues.opened"],
    })),
  };
  const p = event();
  p.comment.body = "ordinary request";
  assert.equal((await run(p, "issue_comment", c))?.prompt, "ordinary request");
  assert.equal(
    await run(
      { ...p, issue: { number: 5, state: "closed" } },
      "issue_comment",
      c,
    ),
    null,
  );
  assert.equal(
    await run(
      { ...p, sender: { ...p.sender, type: "Bot" } },
      "issue_comment",
      c,
    ),
    null,
  );
  const opened = {
    ...p,
    action: "opened",
    issue: { number: 5, title: "Investigate", body: "details" },
  };
  assert.equal((await run(opened, "issues", c))?.target.kind, "issue");
  assert.equal(await run({ ...opened, action: "edited" }, "issues", c), null);
});
