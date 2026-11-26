import { fixtureAgent } from "./binding-fixture.js";
import { seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { once } from "node:events";
import { createChannelServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";
import { PullCoordinator } from "../src/pull.js";
import { DeliveryWorker } from "../src/worker.js";
import {
  AccessDenied,
  type GitHubClient,
  type NewTask,
  type ChannelConfig,
} from "../src/contracts.js";
const input: NewTask = {
  deliveryId: "d1",
  source: { event: "issue_comment", action: "created", commentId: 1 },
  bindingId: "1:2:only-worker:1",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "user",
  target: { kind: "issue", number: 4 },
  prompt: "secret issue prompt",
};
async function fixture(t: test.TestContext, timeoutMs = 60000) {
  const store = new TaskStore(":memory:");
  seedBinding(store, input, "only-worker");
  let authorized = true,
    authorizations = 0,
    reads = 0,
    publications = 0;
  const github: GitHubClient = {
    authorize: async () => {
      authorizations++;
      if (!authorized) throw new AccessDenied();
    },
    readIssue: async (task) => {
      reads++;
      return { title: task.owner + "/" + task.repo, untrusted: true };
    },
    readFile: async () => ({ content: "file" }),
    publishPullRequest: async () => {
      throw new Error("Unexpected PR publication");
    },
    publishComment: async () => {
      publications++;
      return {
        id: 1,
        url: "https://github.com/org/repo/issues/4#issuecomment-1",
      };
    },
  };
  const coordinator = new PullCoordinator(
    store,
    github,
    { timeoutMs },
    (credential) =>
      credential === "connector-token"
        ? { deviceId: "only-worker" }
        : credential === "other-token"
          ? { deviceId: "other" }
          : undefined,
  );
  const config: ChannelConfig = {
    server: { host: "127.0.0.1", port: 0, adminTokenEnv: "ADMIN" },
    dataFile: ":memory:",
    github: {
      appId: "1",
      botLogin: "test[bot]",
      privateKeyEnv: "KEY",
      webhookSecretEnv: "HOOK",
    },
    connector: { timeoutMs },
  };
  const server = createChannelServer(
    config,
    store,
    "webhook-token",
    "admin-token",
    coordinator,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const post = (path: string, body: unknown, token = "connector-token") =>
    fetch(base + "/connector/v2/" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    store,
    post,
    github,
    coordinator,
    setAuthorized: (x: boolean) => {
      authorized = x;
    },
    counts: () => ({ authorizations, reads, publications }),
  };
}
test("only successful authenticated claim polls report last seen for an active runtime", async (t) => {
  const f = await fixture(t);
  const last = () => f.store.runtimeLastSeen("only-worker", fixtureAgent);
  assert.equal(last(), null);
  assert.equal(
    (await f.post("claim", { runtime: fixtureAgent }, "no-token")).status,
    401,
  );
  assert.equal((await f.post("claim", {})).status, 400);
  assert.equal(
    (await f.post("claim", { runtime: { ...fixtureAgent, id: "unused" } }))
      .status,
    204,
  );
  assert.equal(last(), null);
  assert.equal(
    f.store.runtimeLastSeen("only-worker", { ...fixtureAgent, id: "unused" }),
    null,
  );
  const before = Date.now();
  const clock = t.mock.method(Date, "now", () => before);
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 204);
  const seen = last();
  assert.ok(seen !== null && seen >= before && seen <= Date.now());
  f.store.accept(input);
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 200);
  assert.equal(last(), seen);
  clock.mock.mockImplementation(() => before + 31_000);
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 204);
  assert.equal(last(), before + 31_000);
  assert.equal(f.store.runtimeLastSeen("other", fixtureAgent), null);
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
    administratorId: 44,
    deviceId: "only-worker",
  };
  f.store.registry.apply(scope, 1, { enabled: false });
  f.store.registry.apply(scope, 2, {
    enabled: true,
    responsibleAgent: fixtureAgent,
  });
  assert.equal(last(), null);
});
test("connector auth precedes claim and caller auth precedes prompt disclosure", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  let r = await f.post("claim", { runtime: fixtureAgent }, "admin-token");
  assert.equal(r.status, 401);
  assert.equal(f.store.get(task.id)?.status, "queued");
  assert.equal(f.counts().authorizations, 0);
  f.setAuthorized(false);
  r = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(r.status, 204);
  assert.doesNotMatch(await r.text(), /secret issue prompt/);
  assert.equal(f.store.get(task.id)?.status, "rejected");
  f.setAuthorized(true);
  const next = f.store.accept({
    ...input,
    deliveryId: "d2",
    source: { ...input.source, commentId: 2 },
  }).task;
  const response = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { task: { id: string } }).task.id,
    next.id,
  );
});
test("claim one assignment, authorize scoped tools, persist idempotent result and publish once", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const r = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(r.status, 200);
  const lease = (await r.json()) as any;
  assert.equal(lease.task.id, task.id);
  assert.ok(lease.leaseToken.length >= 32);
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 204);
  let tool = await f.post(`tasks/${task.id}/tool`, {
    leaseToken: lease.leaseToken,
    name: "read_issue",
    args: { owner: "evil" },
  });
  assert.equal(tool.status, 400);
  assert.equal(f.counts().reads, 0);
  tool = await f.post(`tasks/${task.id}/tool`, {
    leaseToken: lease.leaseToken,
    name: "read_issue",
    args: {},
  });
  assert.equal(tool.status, 200);
  assert.equal(((await tool.json()) as any).title, "org/repo");
  f.setAuthorized(false);
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: lease.leaseToken,
        name: "read_issue",
        args: {},
      })
    ).status,
    403,
  );
  f.setAuthorized(true);
  const body = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    outcome: {
      text: "answer",
      artifacts: [],
      publication: { kind: "comment" },
    },
  };
  assert.equal((await f.post(`tasks/${task.id}/result`, body)).status, 200);
  assert.equal((await f.post(`tasks/${task.id}/result`, body)).status, 200);
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        ...body,
        outcome: { ...body.outcome, text: "other" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: lease.leaseToken,
        name: "read_issue",
        args: {},
      })
    ).status,
    409,
  );
  const worker = new DeliveryWorker(f.store, f.github);
  await worker.tick();
  await worker.tick();
  assert.equal(f.counts().publications, 1);
  assert.equal(f.store.get(task.id)?.deliveryStatus, "sent");
});
test("expiry fences tools and late result without automatic reissue", async (t) => {
  const f = await fixture(t, 100);
  const task = f.store.accept(input).task;
  const lease = (await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json()) as any;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: lease.leaseToken,
        name: "read_issue",
        args: {},
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: lease.leaseToken,
        status: "succeeded",
        outcome: {
          text: "late",
          artifacts: [],
          publication: { kind: "comment" },
        },
      })
    ).status,
    409,
  );
  assert.equal(f.store.get(task.id)?.status, "unknown");
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 204);
});
test("strict and bounded bodies never invoke tools or accept a malformed result", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post("claim", { workerId: "override" })).status, 400);
  assert.equal((await f.post("claim", { x: "a".repeat(5000) })).status, 413);
  const task = f.store.accept(input).task;
  const lease = (await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json()) as any;
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: lease.leaseToken,
        status: "succeeded",
        outcome: {
          text: "x".repeat(18001),
          artifacts: [],
          publication: { kind: "comment" },
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: lease.leaseToken,
        status: "failed",
        outcome: {
          text: "ignored",
          artifacts: [],
          publication: { kind: "comment" },
        },
      })
    ).status,
    400,
  );
  assert.equal(f.store.get(task.id)?.status, "running");
});
test("delivery-only worker never claims queued task", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const worker = new DeliveryWorker(f.store, f.github);
  assert.equal(await worker.tick(), false);
  assert.equal(f.store.get(task.id)?.status, "queued");
});

test("returned result cannot publish after actor loses permission", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const lease = (await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json()) as {
    leaseToken: string;
  };
  const body = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    outcome: {
      text: "result before revoke",
      artifacts: [],
      publication: { kind: "comment" },
    },
  };
  assert.equal((await f.post(`tasks/${task.id}/result`, body)).status, 200);
  f.setAuthorized(false);
  await new DeliveryWorker(f.store, f.github).tick();
  assert.equal(f.counts().publications, 0);
  assert.equal(f.store.get(task.id)?.deliveryStatus, "failed");
});

test("lease token scopes every tool and result; canonical retry ignores JSON key order", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const lease = (await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json()) as {
    leaseToken: string;
  };
  const wrong = "a".repeat(64);
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: wrong,
        name: "read_issue",
        args: {},
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: wrong,
        status: "succeeded",
        outcome: {
          text: "wrong",
          artifacts: [],
          publication: { kind: "comment" },
        },
      })
    ).status,
    409,
  );
  assert.equal(f.counts().reads, 0);
  const first = await f.post(`tasks/${task.id}/result`, {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    outcome: {
      text: "correct",
      responseId: "r",
      artifacts: [],
      publication: { kind: "comment" },
    },
  });
  assert.deepEqual(await first.json(), { accepted: true, duplicate: false });
  const second = await f.post(`tasks/${task.id}/result`, {
    outcome: {
      publication: { kind: "comment" },
      artifacts: [],
      responseId: "r",
      text: "correct",
    },
    status: "succeeded",
    leaseToken: lease.leaseToken,
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, duplicate: true });
});
test("cloud tool audit classifies admitted failures without recording arguments or upstream error text", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const { leaseToken } = await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json();
  const read = (args: unknown) =>
    f.post(`tasks/${task.id}/tool`, { leaseToken, name: "read_issue", args });
  assert.equal((await read({ path: "private-path" })).status, 400);
  assert.deepEqual(f.store.toolAudit(task.id), []);
  const invalid = z.string().safeParse({ secret: "private-body" });
  assert.ok(!invalid.success);
  for (const [error, code, http] of [
    [new AccessDenied("private-actor"), "scope", 403],
    [
      Object.assign(Error("private-token"), { status: 404 }),
      "github_permission_or_resource",
      503,
    ],
    [invalid.error, "invalid_evidence", 503],
    [new SyntaxError("private-body"), "invalid_evidence", 503],
    [
      Object.assign(Error("private-token"), { status: 502 }),
      "upstream_unavailable",
      503,
    ],
    [Object.assign(Error("private-path"), { status: 422 }), "unknown", 503],
  ] as const) {
    f.github.readIssue = async () => {
      throw error;
    };
    const r = await read({});
    assert.equal(r.status, http);
    assert.doesNotMatch(await r.text(), /private-/);
    const ledger = f.store.toolAudit(task.id);
    assert.equal(ledger[0].lastFailure, code);
    assert.doesNotMatch(JSON.stringify(ledger), /private-/);
  }
  f.github.readIssue = async () => {
    f.store.expireTasks(Date.now() + 120000);
    return {};
  };
  assert.equal((await read({})).status, 409);
  assert.equal(f.store.toolAudit(task.id)[0].lastFailure, "lease");
});

test("storage failure returns retryable 503 and same result is persisted once on retry", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const lease = (await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json()) as {
    leaseToken: string;
  };
  const finish = f.store.finishAssignment.bind(f.store);
  let failed = false;
  t.mock.method(
    f.store,
    "finishAssignment",
    (...args: Parameters<TaskStore["finishAssignment"]>) => {
      if (!failed) {
        failed = true;
        throw new Error("SQLITE_BUSY fixture private detail");
      }
      return finish(...args);
    },
  );
  const payload = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    outcome: {
      text: "retained result",
      artifacts: [],
      publication: { kind: "comment" },
    },
  };
  const first = await f.post(`tasks/${task.id}/result`, payload);
  assert.equal(first.status, 503);
  assert.doesNotMatch(await first.text(), /SQLITE_BUSY|private detail/);
  assert.equal(f.store.get(task.id)?.status, "running");
  const second = await f.post(`tasks/${task.id}/result`, payload);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, duplicate: false });
  const third = await f.post(`tasks/${task.id}/result`, payload);
  assert.deepEqual(await third.json(), { accepted: true, duplicate: true });
  await new DeliveryWorker(f.store, f.github).tick();
  assert.equal(f.counts().publications, 1);
});

test("another authenticated device cannot claim, read, or submit a result with the actual owner's lease", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  assert.equal(
    (await f.post("claim", { runtime: fixtureAgent }, "other-token")).status,
    204,
  );
  const r = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(r.status, 200);
  const { leaseToken } = (await r.json()) as { leaseToken: string };
  for (const [action, data] of [
    ["tool", { leaseToken, name: "read_issue", args: {} }],
    ["result", { leaseToken, status: "failed" }],
    [
      "execution",
      { leaseToken, event: { kind: "started", provider: "acp", runId: "run" } },
    ],
  ] as const) {
    assert.equal(
      (await f.post("tasks/" + task.id + "/" + action, data, "other-token"))
        .status,
      409,
    );
  }
  assert.equal(f.counts().reads, 0);
  assert.equal(f.store.get(task.id)?.status, "running");
});

test("only a verified lease holder receives target-specific outcome validation", async (t) => {
  const f = await fixture(t);
  const repo = { ...input, repositoryId: 55 };
  const binding = seedBinding(f.store, repo, "only-worker", ["push"]);
  const task = f.store.accept({
    ...repo,
    bindingId: binding.id,
    target: { kind: "repository" },
    source: { event: "push" },
  }).task;
  const lease = (await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json()) as {
    leaseToken: string;
  };
  const body = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    outcome: {
      text: "nonempty",
      artifacts: [],
      publication: { kind: "comment" },
    },
  };
  const path = "tasks/" + task.id + "/result";
  assert.equal((await f.post(path, body, "other-token")).status, 409);
  assert.equal(
    (await f.post(path, { ...body, leaseToken: "x".repeat(32) })).status,
    409,
  );
  assert.equal((await f.post(path, body)).status, 400);
  assert.equal(f.store.get(task.id)?.status, "running");
});

test("denial fencing a reserved but undisclosed claim never freezes healthy work on the same device", async (t) => {
  const f = await fixture(t);
  const { store } = f;
  const denied = store.accept(input).task;
  const other = {
    ...input,
    repositoryId: 6,
    repo: "second",
    deliveryId: "follow",
    source: { ...input.source, commentId: 7 },
  };
  other.bindingId = seedBinding(store, other, "only-worker").id;
  const healthy = store.accept(other).task;
  f.github.authorize = async (task) => {
    if (task.id === denied.id) {
      const b = store.activeBinding(1, 2)!;
      const {
        installationId,
        repositoryId,
        owner,
        repo,
        deviceId,
        administratorId,
      } = b;
      store.registry.apply(
        {
          installationId,
          repositoryId,
          owner,
          repo,
          deviceId,
          administratorId,
        },
        b.revision,
        { enabled: false, events: [] },
      );
      throw new AccessDenied();
    }
  };
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 204);
  assert.equal(store.get(denied.id)?.status, "rejected");
  assert.equal(
    (await (await f.post("claim", { runtime: fixtureAgent })).json()).task.id,
    healthy.id,
  );
});

test("failure codes survive result acknowledgement and never admit arbitrary diagnostics", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const { leaseToken } = await (
    await f.post("claim", { runtime: fixtureAgent })
  ).json();
  const url = "tasks/" + task.id + "/result";
  const result = { leaseToken, status: "failed", failure: "tool_call_failed" };
  assert.equal(
    (await f.post(url, { ...result, detail: "private-value" })).status,
    400,
  );
  assert.equal(
    (await f.post(url, { ...result, failure: "private-value" })).status,
    400,
  );
  assert.equal(
    (await f.post(url, { ...result, failure: "runtime_transport" })).status,
    400,
  );
  assert.equal(
    (await f.post(url, { ...result, status: "unknown" })).status,
    400,
  );
  assert.equal((await f.post(url, result)).status, 200);
  assert.match(f.store.get(task.id)!.error!, /tool_call_failed/);
  assert.equal(
    (await f.post(url, { ...result, failure: "tool_call_invalid" })).status,
    409,
  );
});
