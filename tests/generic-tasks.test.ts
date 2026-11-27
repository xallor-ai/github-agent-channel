import { seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Webhooks } from "@octokit/webhooks";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeWebhook } from "../src/webhook.js";
import { TaskStore } from "../src/store.js";
import type { Binding } from "../src/contracts.js";

const scope = {
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "alice",
};
const config = {
  github: { botLogin: "helper[bot]" },
  bindings: [
    {
      ...scope,
      id: "b",
      enabled: true,
      events: [
        "issues.opened",
        "issues.labeled",
        "issues.closed",
        "push",
        "pull_request.opened",
        "pull_request.synchronize",
        "pull_request.closed",
      ],
      triggerLabel: "agent",
    },
  ],
} as { github: { botLogin: string }; bindings: Binding[] };
const envelope = {
  installation: { id: 1 },
  repository: { id: 2, name: "repo", owner: { login: "org" } },
  sender: { id: 3, login: "alice", type: "User" },
};
async function receive(event: string, payload: unknown, settings = config) {
  const raw = Buffer.from(JSON.stringify(payload));
  const decision = await normalizeWebhook(
    {
      github: settings.github,
      lookup: (i, r) =>
        settings.bindings.find(
          (b) => b.installationId === i && b.repositoryId === r,
        ),
    },
    raw,
    {
      event,
      delivery: "12345678-1234-1234-1234-123456789abc",
      signature: await new Webhooks({ secret: "test" }).sign(raw.toString()),
    },
    "test",
  );
  assert.ok(!decision || !("closure" in decision));
  return decision;
}
test("opted-in Issue and repository events produce scoped targets without invented comments", async () => {
  const issue = await receive("issues", {
    ...envelope,
    action: "opened",
    issue: {
      number: 5,
      state: "open",
      title: "Fix bug",
      body: "@helper fix it",
    },
  });
  assert.ok(issue);
  assert.equal(issue.reason, "mention");
  assert.deepEqual(issue.input.target, { kind: "issue", number: 5 });
  assert.equal(issue.input.source.commentId, undefined);
  assert.deepEqual(issue.input.source, { event: "issues", action: "opened" });
  const push = await receive("push", {
    ...envelope,
    ref: "refs/heads/main",
    after: "a".repeat(40),
    deleted: false,
  });
  assert.ok(push);
  assert.equal(push.execute, false);
  assert.deepEqual(push.input.target, {
    kind: "repository",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
  });
});
test("opted-in labels and PR events preserve activation and sender boundaries", async () => {
  const created = "2026-11-24T00:00:00Z",
    updated = "2026-11-25T00:00:00Z",
    closedAt = "2026-11-26T00:00:00Z";
  const payload = {
    ...envelope,
    action: "labeled",
    label: { name: "other" },
    issue: {
      number: 5,
      state: "open",
      title: "Fix bug",
      body: "details",
      created_at: created,
      updated_at: updated,
    },
  };
  assert.equal((await receive("issues", payload))?.reason, "observed");
  const accepted = await receive("issues", {
    ...payload,
    label: { name: "agent" },
  });
  assert.ok(accepted);
  assert.equal(accepted.input.actorId, 3);
  assert.equal(accepted.reason, "label");
  assert.equal(accepted.githubTime, Date.parse(updated));
  assert.equal(
    await receive("issues", {
      ...payload,
      label: { name: "agent" },
      sender: { ...envelope.sender, type: "Bot" },
    }),
    null,
  );
  const update = {
    ...envelope,
    action: "opened",
    pull_request: {
      number: 9,
      state: "open",
      base: { sha: "a".repeat(40), repo: { id: 2 } },
      head: { sha: "b".repeat(40), repo: { id: 2 } },
      created_at: created,
      updated_at: updated,
      title: "Review",
      body: "changes",
    },
  };
  const pr = await receive("pull_request", update);
  assert.equal(pr?.execute, false);
  assert.deepEqual(pr?.input.target, {
    kind: "pull_request",
    number: 9,
    revision: {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      baseRepoId: 2,
      headRepoId: 2,
    },
  });
  const enabled = {
    ...config,
    bindings: config.bindings.map((b) => ({
      ...b,
      autoReview: true,
      autoTriage: true,
    })),
  };
  for (const action of ["opened", "synchronize"]) {
    assert.equal(
      (await receive("pull_request", { ...update, action }, enabled))?.reason,
      "review",
    );
  }
  assert.equal(
    (await receive("pull_request", update, enabled))?.githubTime,
    Date.parse(created),
  );
  assert.equal(
    (
      await receive(
        "pull_request",
        { ...update, action: "synchronize" },
        enabled,
      )
    )?.githubTime,
    Date.parse(updated),
  );
  const closed = {
    ...update,
    action: "closed",
    pull_request: {
      ...update.pull_request,
      state: "closed",
      closed_at: closedAt,
    },
  };
  assert.equal(
    (await receive("pull_request", closed, enabled))?.githubTime,
    Date.parse(closedAt),
  );
  assert.equal(
    (await receive("pull_request", closed, enabled))?.reason,
    "closed",
  );
  assert.equal(
    await receive("pull_request", { ...update, action: "closed" }, enabled),
    null,
  );
  const opened = { ...payload, action: "opened" };
  assert.equal((await receive("issues", opened))?.reason, "observed");
  assert.equal((await receive("issues", opened, enabled))?.reason, "triage");
  assert.equal(
    (
      await receive(
        "issues",
        {
          ...opened,
          action: "closed",
          issue: { ...opened.issue, state: "closed" },
        },
        enabled,
      )
    )?.reason,
    "closed",
  );
  const defaults = {
    ...config,
    bindings: config.bindings.map((b) => ({
      ...b,
      events: ["issue_comment.created"],
    })),
  };
  assert.equal(
    await receive("issues", { ...payload, label: { name: "agent" } }, defaults),
    null,
  );
});
test("structured outcomes persist across restart and validate untrusted paths before acceptance", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-outcome-"));
  const path = join(dir, "tasks.db");
  let store = new TaskStore(path);
  try {
    const bindingId = seedBinding(store, scope, "worker").id;
    const task = store.accept({
      ...scope,
      bindingId,
      deliveryId: "d",
      source: { event: "issue_comment", action: "created", commentId: 4 },
      target: { kind: "issue", number: 5 },
      prompt: "fix",
    }).task;
    store.claimAssignment("worker", "hash", Date.now() + 100000);
    const result = {
      status: "succeeded" as const,
      outcome: {
        text: "Change prepared",
        artifacts: [
          {
            kind: "change_set" as const,
            name: "code",
            baseSha: "a".repeat(40),
            files: [{ path: "src/a.txt", content: "new" }],
          },
        ],
        publication: { kind: "none" as const },
      },
    };
    store.finishAssignment(task.id, "worker", "hash", result, "digest");
    store.close();
    store = new TaskStore(path);
    assert.deepEqual(
      store.get(task.id)?.outcome?.artifacts,
      result.outcome.artifacts,
    );
    assert.equal(store.get(task.id)?.deliveryStatus, "skipped");
    const next = store.accept({
      ...scope,
      bindingId,
      deliveryId: "e",
      source: { event: "issue_comment", action: "created", commentId: 6 },
      target: { kind: "issue", number: 5 },
      prompt: "fix",
    }).task;
    store.claimAssignment("worker", "hash2", Date.now() + 100000);
    assert.throws(() =>
      store.finishAssignment(
        next.id,
        "worker",
        "hash2",
        {
          ...result,
          outcome: {
            ...result.outcome,
            artifacts: [
              {
                ...result.outcome.artifacts[0],
                files: [{ path: "../escape", content: "bad" }],
              },
            ],
          },
        },
        "invalid",
      ),
    );
    assert.equal(store.get(next.id)?.status, "running");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
