import { ActivityInbox } from "../src/agent-inbox.js";
import { fixtureAgent } from "./binding-fixture.js";
import { bindingEvent } from "../src/binding-events.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activitiesCommand,
  inboxCommand,
  adminCommand,
  pairCommand,
  repoCommand,
} from "../src/self-service-cli.js";

const coverage = {
  runtimePoll: { status: "recent", lastPolledAt: 1609459200000 },
  subscriptions: ["issues", "pull_request"],
  permissions: { issues: "read" },
  serverWriteProfile: false,
};
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "channel-self-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "agent.yaml"),
    file = join(dir, "repo.yaml"),
    token = join(dir, "device-token");
  writeFileSync(
    config,
    `channel: {baseUrl: https://channel.example, tokenFile: device-token}
runtime: {type: openclaw, baseUrl: 'http://localhost:18789', tokenFile: missing-model-token, agentId: github, timeoutMs: 1000, maxToolRounds: 2}
stateFile: state.db
pollIntervalMs: 500
requestTimeoutMs: 5000`,
  );
  const target = { owner: "xallor-ai", repo: "xallor" };
  const enabled = {
    enabled: true,
    events: ["issue_comment.created"],
  };
  const disabled = { enabled: false, events: [] };
  const record = {
    ...target,
    ...enabled,
    responsibleAgent: fixtureAgent,
    deviceId: "device1",
    administratorId: 5,
    installationId: 3,
    repositoryId: 7,
    revision: 2,
  };
  const declare = (d: unknown) =>
    writeFileSync(file, JSON.stringify({ ...target, declaration: d }));
  return {
    dir,
    config,
    file,
    token,
    target,
    enabled,
    disabled,
    record,
    declare,
  };
}
test("read compares local intent against remote effective state and never sends a declaration", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "device-secret");
  let binding: unknown = null;
  const read: typeof fetch = async (url, req) => {
    assert.equal(
      String(url),
      "https://channel.example/connector/v2/bindings/read",
    );
    assert.deepEqual(JSON.parse(String(req?.body)), f.target);
    assert.equal(
      new Headers(req?.headers).get("authorization"),
      "Bearer device-secret",
    );
    assert.equal(req?.redirect, "error");
    return Response.json({ coverage, binding });
  };
  f.declare(f.enabled);
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "local_pending",
  );
  binding = f.record;
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "active",
  );
  f.declare(f.disabled);
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "disable_pending",
  );
  binding = {
    ...f.record,
    ...f.disabled,
    responsibleAgent: undefined,
    revision: 3,
  };
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "disabled",
  );
});
test("apply reads revision and injects local agent into minimal desired state", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  writeFileSync(f.file, "owner: xallor-ai\nrepo: xallor\n");
  const calls: string[] = [];
  const result = await repoCommand(
    "apply",
    f.file,
    f.config,
    async (url, req) => {
      calls.push(new URL(String(url)).pathname);
      if (calls.length === 1) return Response.json({ coverage, binding: null });
      assert.deepEqual(JSON.parse(String(req?.body)), {
        ...f.target,
        expectedRevision: 0,
        declaration: { enabled: true, responsibleAgent: fixtureAgent },
      });
      return Response.json({
        coverage,
        binding: { ...f.record, events: undefined, revision: 1 },
      });
    },
  );
  assert.deepEqual(calls, [
    "/connector/v2/bindings/read",
    "/connector/v2/bindings/apply",
  ]);
  assert.equal(result.state, "active");
  assert.ok(existsSync(join(f.dir, "state.db.inbox")));
  assert.ok(
    result.localActivityInbox && result.localActivityInbox !== "unavailable",
  );
  assert.equal(result.localActivityInbox.bindingId, "3:7:device1:1");
  assert.equal(result.effective.responsibleAgent, "openclaw/github");
  assert.deepEqual(result.effective.channelEventFilter, bindingEvent.options);
  assert.deepEqual(result.effective.runtimePoll, coverage.runtimePoll);
  assert.deepEqual(
    result.effective.eventCoverage.find(
      (v) => v.event === "pull_request.opened",
    ),
    {
      event: "pull_request.opened",
      eligible: false,
      subscription: true,
      permission: false,
    },
  );
  assert.deepEqual(
    result.effective.eventCoverage.find(
      (v) => v.event === "issue_comment.created",
    ),
    {
      event: "issue_comment.created",
      eligible: false,
      subscription: false,
      permission: true,
    },
  );
  assert.equal(
    result.effective.eventCoverage.find((v) => v.event === "issues.opened")
      ?.eligible,
    true,
  );
  writeFileSync(
    f.file,
    JSON.stringify({
      ...f.target,
      expectedRevision: 2,
      declaration: f.enabled,
    }),
  );
  await assert.rejects(
    repoCommand("apply", f.file, f.config, async () =>
      assert.fail("must not send"),
    ),
    /no request sent/,
  );
});

test("a mismatched or impossible apply receipt never creates an activity subscription", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  f.declare(f.enabled);
  for (const binding of [
    { ...f.record, revision: 5 },
    {
      ...f.record,
      revision: 1,
      responsibleAgent: { ...fixtureAgent, id: "other" },
    },
  ]) {
    await assert.rejects(
      repoCommand("apply", f.file, f.config, async (url) =>
        Response.json({
          binding: String(url).endsWith("/read") ? null : binding,
          coverage,
        }),
      ),
      /does not confirm/,
    );
    assert.equal(existsSync(join(f.dir, "state.db.inbox")), false);
  }
});
test("status shows changed local agent and a requested feature unsupported by the bound runtime", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  f.declare({ ...f.enabled, deepReview: true });
  const result = await repoCommand("status", f.file, f.config, async () =>
    Response.json({
      coverage,
      binding: {
        ...f.record,
        deepReview: true,
        responsibleAgent: {
          type: "acp",
          id: "assistant",
          deepReview: false,
          nativeReview: false,
        },
      },
    }),
  );
  assert.equal(result.state, "local_pending");
  assert.equal(result.effective.responsibleAgent, "acp/assistant");
  assert.deepEqual(result.effective.reviewCapabilities, []);
  assert.deepEqual(result.effective.missingCapabilities, ["deepReview"]);
});

test("concurrent change is displayed from a verified read, without retrying apply", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  f.declare(f.disabled);
  const calls: string[] = [];
  await assert.rejects(
    repoCommand("apply", f.file, f.config, async (url, req) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith("/apply")) {
        assert.deepEqual(JSON.parse(String(req?.body)), {
          ...f.target,
          expectedRevision: 2,
          declaration: f.disabled,
        });
        return Response.json({ error: "binding_conflict" }, { status: 409 });
      }
      return Response.json({
        coverage,
        binding:
          calls.length === 1
            ? f.record
            : { ...f.record, revision: 3, autoTriage: true },
      });
    }),
    (error: Error) =>
      /Binding conflict/.test(error.message) &&
      error.message.includes('"revision":3') &&
      error.message.includes('"desired":{"enabled":false'),
  );
  assert.deepEqual(
    calls.map((v) => v.split("/").pop()),
    ["read", "apply", "read"],
  );
});

test("disable never treats ambiguous delivery or malformed receipt as acknowledgment", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  f.declare(f.disabled);
  for (const response of [
    () => {
      throw Error("secret");
    },
    () => Response.json({ coverage, binding: null }),
    () => Response.json({ error: "leaked-token" }, { status: 401 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      repoCommand("apply", f.file, f.config, async (url) => {
        calls++;
        return String(url).endsWith("/read")
          ? Response.json({ coverage, binding: f.record })
          : response();
      }),
      (error: Error) =>
        error.message.startsWith("disable_pending (unconfirmed)") &&
        !/secret|leaked-token/.test(error.message),
    );
    assert.equal(calls, 2);
  }
  rmSync(f.file);
  let requests = 0;
  await assert.rejects(
    repoCommand("apply", f.file, f.config, async () => {
      requests++;
      return Response.json({});
    }),
    /no request sent/,
  );
  assert.equal(requests, 0);
});
test("activity CLI requests one page for the configured repo/agent without runtime credentials", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  writeFileSync(f.file, JSON.stringify(f.target));
  const page = {
    bindingId: "3:7:device1:2",
    activities: [],
    nextCursor: 7,
    hasMore: false,
    truncated: false,
  };
  assert.deepEqual(
    await activitiesCommand(f.file, f.config, 7, 3, async (url, req) => {
      assert.equal(new URL(String(url)).pathname, "/connector/v2/activities");
      assert.deepEqual(JSON.parse(String(req?.body)), {
        ...f.target,
        runtime: fixtureAgent,
        after: 7,
        limit: 3,
      });
      return Response.json(page);
    }),
    page,
  );
  await assert.rejects(
    activitiesCommand(f.file, f.config, 7, 3, async () =>
      Response.json({ ...page, nextCursor: 6 }),
    ),
    /Invalid activity/,
  );
});

test("invitation is written privately, pairing persists the device credential before submission and never returns secrets", async (t) => {
  const f = fixture(t);
  const invite = join(f.dir, "invite");
  const issued = await adminCommand(
    ["invite", "https://channel.example", "5", invite],
    "admin-secret",
    async (url, req) => {
      assert.equal(
        new Headers(req?.headers).get("authorization"),
        "Bearer admin-secret",
      );
      assert.equal(String(url), "https://channel.example/admin/device-invites");
      assert.deepEqual(JSON.parse(String(req?.body)), { githubUserId: 5 });
      return Response.json({ invite: "secret-invitation", expiresAt: 100 });
    },
  );
  assert.doesNotMatch(JSON.stringify(issued), /secret-invitation|admin-secret/);
  assert.equal(readFileSync(invite, "utf8"), "secret-invitation");
  assert.equal(existsSync(f.token), false);
  const paired = await pairCommand(
    invite,
    f.config,
    "github-secret",
    async (url, req) => {
      assert.equal(
        String(url),
        "https://channel.example/connector/v2/devices/pair",
      );
      assert.equal(
        new Headers(req?.headers).get("authorization"),
        "Bearer github-secret",
      );
      const data = JSON.parse(String(req?.body));
      assert.equal(data.invite, "secret-invitation");
      assert.equal(readFileSync(f.token, "utf8"), data.deviceToken);
      assert.match(data.deviceToken, /^[A-Za-z0-9_-]{43}$/);
      return Response.json({
        deviceId: "dev1",
        githubUserId: 5,
        unexpectedSecret: "never-print",
      });
    },
  );
  assert.deepEqual(paired, { deviceId: "dev1", githubUserId: 5 });
});

test("local inbox requires a live matching binding before exposing the persisted comment", async (t) => {
  const f = fixture(t);
  f.declare(f.enabled);
  writeFileSync(f.token, "device-secret");
  const connection = {
    baseUrl: "https://channel.example",
    token: "device-secret",
    timeout: 1000,
  };
  const inbox = new ActivityInbox(join(f.dir, "state.db"));
  const excerpt = "repo-scoped private excerpt";
  const bindingId = "3:7:device1:2";
  try {
    inbox.remember(connection.baseUrl, fixtureAgent, f.record);
    await inbox.pollOne(
      connection,
      fixtureAgent,
      new AbortController().signal,
      async () =>
        Response.json({
          bindingId,
          activities: [
            {
              ...f.target,
              installationId: 3,
              repositoryId: 7,
              bindingId,
              cursor: 4,
              deliveryId: "d",
              receivedAt: 5000,
              actorLogin: "author",
              target: { kind: "issue", number: 2 },
              source: {
                event: "issue_comment",
                action: "created",
                commentId: 12,
              },
              reason: "observed",
              taskId: null,
              excerpt,
              truncated: false,
            },
          ],
          nextCursor: 4,
          hasMore: false,
          truncated: false,
        }),
    );
  } finally {
    inbox.close();
  }
  const read =
    (binding: unknown): typeof fetch =>
    async (url, init) => {
      assert.equal(
        new URL(String(url)).pathname,
        "/connector/v2/bindings/read",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), f.target);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer device-secret",
      );
      return Response.json({ binding, coverage });
    };
  const view = (fetcher: typeof fetch) =>
    inboxCommand(f.file, f.config, 0, 25, fetcher);
  const current = await view(read(f.record));
  assert.equal(current?.activities[0].activity.excerpt, excerpt);
  assert.equal(current?.activities[0].activity.source.commentId, 12);
  // The local file still exists; a new revision/device cannot see its old page.
  for (const changed of [
    { revision: 3 },
    { deviceId: "device2" },
    { repositoryId: 8 },
  ])
    assert.equal(await view(read({ ...f.record, ...changed })), null);
  for (const fetcher of [
    read(null),
    read({ ...f.record, enabled: false }),
    read({ ...f.record, repo: "unrelated" }),
    read({ ...f.record, responsibleAgent: { ...fixtureAgent, id: "other" } }),
    read({
      ...f.record,
      responsibleAgent: { ...fixtureAgent, deepReview: false },
    }),
    async () => new Response(null, { status: 403 }),
    async () => {
      throw Error("network unavailable");
    },
  ])
    await assert.rejects(
      view(fetcher),
      (e) => e instanceof Error && !e.message.includes(excerpt),
    );
});
