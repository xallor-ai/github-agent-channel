import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import {
  ActivityInbox,
  activityInboxStatus,
  readActivityInbox,
  rememberActivityBinding,
} from "../src/agent-inbox.js";
import { runAgent } from "../src/agent.js";
import type { RuntimeProfile } from "../src/runtime-profile.js";

const profile: RuntimeProfile = {
  type: "openclaw",
  id: "reviewer",
  deepReview: true,
  nativeReview: true,
};
const connection = {
  baseUrl: "https://channel.example",
  token: "local-token",
  timeout: 5000,
};
const binding = {
  owner: "org",
  repo: "repo",
  deviceId: "worker",
  installationId: 1,
  repositoryId: 2,
  revision: 1,
  enabled: true,
};
function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "channel-agent-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "agent.db");
}
function feedNext(revision: number, bindingId = `1:2:worker:${revision}`) {
  return Response.json({
    bindingId,
    activities: [
      {
        cursor: 10,
        receivedAt: 123,
        deliveryId: "a",
        bindingId,
        installationId: 1,
        repositoryId: 2,
        owner: "org",
        repo: "repo",
        actorLogin: "comment-author",
        target: { kind: "issue", number: 1 },
        source: { event: "issue_comment", action: "created", commentId: 77 },
        reason: "observed",
        taskId: null,
        excerpt: "bounded comment excerpt",
        truncated: false,
      },
    ],
    nextCursor: 10,
    hasMore: false,
    truncated: false,
  });
}

test("local receipt survives restart and a lost acknowledgement is retried before consuming another page", async (t) => {
  const stateFile = fixture(t);
  rememberActivityBinding(stateFile, connection.baseUrl, profile, binding);
  const inbox = new ActivityInbox(stateFile);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await inbox.pollOne(connection, profile, signal, async (url, init) => {
      assert.equal(
        String(url),
        connection.baseUrl + "/connector/v2/activities",
      );
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: "org",
        repo: "repo",
        runtime: profile,
        after: 0,
        limit: 25,
      });
      return feedNext(1);
    }),
    { received: 1, truncated: false },
  );
  inbox.close();
  const local = () =>
    readActivityInbox(stateFile, connection.baseUrl, profile, binding)!;
  assert.equal(
    local().activities[0].activity.excerpt,
    "bounded comment excerpt",
  );
  assert.equal(local().activities[0].activity.source.commentId, 77);
  assert.equal(local().activities[0].ack, "pending");
  assert.doesNotMatch(JSON.stringify(local()), /local-token/);
  const failed = new ActivityInbox(stateFile);
  const calls: unknown[] = [];
  try {
    await assert.rejects(
      failed.pollOne(connection, profile, signal, async (url, init) => {
        assert.equal(
          new URL(String(url)).pathname,
          "/connector/v2/activities/received",
        );
        calls.push(JSON.parse(String(init?.body)));
        throw Error("ack reply lost");
      }),
      /lost/,
    );
  } finally {
    failed.close();
  }
  const reopened = new ActivityInbox(stateFile);
  try {
    await reopened.pollOne(connection, profile, signal, async (url, init) => {
      assert.equal(
        new URL(String(url)).pathname,
        "/connector/v2/activities/received",
      );
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, calls[0]);
      assert.deepEqual(body.entries, [{ cursor: 10, deliveryId: "a" }]);
      return Response.json({
        bindingId: body.bindingId,
        entries: body.entries,
      });
    });
    assert.equal(local().activities[0].ack, "confirmed");
    assert.equal(local().activities.length, 1);
    await reopened.pollOne(connection, profile, signal, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).after, 10);
      return Response.json({
        bindingId: "1:2:worker:1",
        activities: [],
        nextCursor: 10,
        hasMore: false,
        truncated: false,
      });
    });
  } finally {
    reopened.close();
  }
});

test("stale and empty receipts cannot move the cursor; local stop fences an in-flight receipt", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const stateFile = fixture(t);
  rememberActivityBinding(stateFile, connection.baseUrl, profile, binding);
  const inbox = new ActivityInbox(stateFile);
  try {
    const signal = new AbortController().signal;
    await assert.rejects(
      inbox.pollOne(connection, profile, signal, async () =>
        Response.json({
          bindingId: "1:2:worker:2",
          activities: [],
          nextCursor: 100,
          hasMore: false,
          truncated: true,
        }),
      ),
      /binding|receipt/i,
    );
    now += 60_000;
    const result = await inbox.pollOne(
      connection,
      profile,
      signal,
      async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).after, 0);
        rememberActivityBinding(stateFile, connection.baseUrl, profile, {
          ...binding,
          enabled: false,
          revision: 2,
        });
        return feedNext(1);
      },
    );
    assert.equal(result, undefined);
    rememberActivityBinding(stateFile, connection.baseUrl, profile, binding);
    assert.equal(
      await inbox.pollOne(connection, profile, signal, async () => {
        throw Error("stopped binding was polled");
      }),
      undefined,
    );
  } finally {
    inbox.close();
  }
});

test("idle and failed repositories wait independently; healthy progress and new revisions remain eligible", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const stateFile = fixture(t);
  const first = binding;
  const second = { ...binding, repo: "second", repositoryId: 3 };
  const third = { ...binding, repo: "third", repositoryId: 4 };
  for (const registered of [first, second, third])
    rememberActivityBinding(stateFile, connection.baseUrl, profile, registered);
  const inbox = new ActivityInbox(stateFile);
  const signal = new AbortController().signal;
  const visits: string[] = [];
  let secondErrors = true;
  let thirdHasActivity = true;
  let firstRevision = 1;
  const fetcher: typeof fetch = async (_, init) => {
    const { repo, after } = JSON.parse(String(init?.body));
    visits.push(repo);
    if (repo === "second" && secondErrors)
      return new Response(null, { status: 502 });
    const progressed = repo === "third" && thirdHasActivity;
    return Response.json({
      bindingId:
        repo === "repo"
          ? `1:2:worker:${firstRevision}`
          : repo === "second"
            ? "1:3:worker:1"
            : "1:4:worker:1",
      activities: [],
      nextCursor: progressed ? after + 1 : after,
      hasMore: false,
      truncated: progressed,
    });
  };
  const poll = () => inbox.pollOne(connection, profile, signal, fetcher);
  try {
    await poll(); // first: empty
    await poll(); // second: first failure
    await poll(); // third: makes progress
    thirdHasActivity = false;
    now += 59_999;
    await poll(); // third remains eligible and is now idle
    await poll(); // everybody is waiting
    assert.deepEqual(visits, ["repo", "second", "third", "third"]);

    now += 1;
    await poll(); // first can poll after 60 seconds
    await poll(); // second fails again and extends to 120 seconds
    now += 60_000;
    await poll(); // third recovers before second
    await poll(); // first wakes on schedule
    await poll();
    assert.deepEqual(visits.slice(4), ["repo", "second", "third", "repo"]);

    firstRevision = 2;
    inbox.remember(connection.baseUrl, profile, { ...first, revision: 2 });
    await poll(); // new revision is eligible despite prior idle delay
    assert.equal(visits.at(-1), "repo");
    const attempts = visits.length;
    secondErrors = false;
    now += 60_000;
    await poll(); // second recovers
    assert.equal(visits.length, attempts + 1);
    assert.equal(visits.at(-1), "second");
    assert.equal(
      inbox.status(connection.baseUrl, profile, "org", "second")?.pollStatus,
      "synced",
    );
  } finally {
    inbox.close();
  }
});

test("a denied repository publishes no old metadata and does not starve another repository", async (t) => {
  const stateFile = fixture(t);
  rememberActivityBinding(stateFile, connection.baseUrl, profile, binding);
  rememberActivityBinding(stateFile, connection.baseUrl, profile, {
    ...binding,
    repositoryId: 3,
    repo: "second",
  });
  const inbox = new ActivityInbox(stateFile);
  const signal = new AbortController().signal;
  const visited: string[] = [];
  const fetcher: typeof fetch = async (_, init) => {
    const { repo } = JSON.parse(String(init?.body));
    visited.push(repo);
    if (repo === "repo") return new Response("{}", { status: 403 });
    return Response.json({
      bindingId: "1:3:worker:1",
      activities: [],
      nextCursor: 15,
      hasMore: false,
      truncated: true,
    });
  };
  try {
    await inbox.pollOne(connection, profile, signal, fetcher);
    await inbox.pollOne(connection, profile, signal, fetcher);
    assert.deepEqual(visited, ["repo", "second"]);
    assert.deepEqual(inbox.status(connection.baseUrl, profile, "org", "repo"), {
      bindingId: "1:2:worker:1",
      cursor: null,
      totalReceived: null,
      retentionTruncated: null,
      lastSyncedAt: null,
      pollStatus: "denied",
    });
    assert.equal(
      inbox.status(connection.baseUrl, profile, "org", "second")?.cursor,
      15,
    );
    assert.equal(
      inbox.status(connection.baseUrl, profile, "org", "second")
        ?.retentionTruncated,
      true,
    );
  } finally {
    inbox.close();
  }
});

test(
  "the running bridge receives observations while claim is in flight without calling its runtime",
  { timeout: 8000 },
  async (t) => {
    const stateFile = fixture(t);
    const config = stateFile + ".yaml";
    writeFileSync(stateFile + ".secret", "fake-private-token");
    writeFileSync(
      config,
      JSON.stringify({
        channel: {
          baseUrl: connection.baseUrl,
          tokenFile: stateFile + ".secret",
        },
        runtime: {
          type: "openclaw",
          baseUrl: "http://127.0.0.1:7000",
          agentId: profile.id,
          tokenFile: stateFile + ".secret",
          timeoutMs: 1000,
          maxToolRounds: 2,
        },
        stateFile,
        pollIntervalMs: 100,
        requestTimeoutMs: 5000,
      }),
    );
    rememberActivityBinding(stateFile, connection.baseUrl, profile, binding);
    const claimEntered = Promise.withResolvers<void>();
    const finishClaim = Promise.withResolvers<void>();
    let claims = 0;
    let runtimeCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/claim")) {
        claims++;
        claimEntered.resolve();
        await finishClaim.promise;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/activities")) {
        await claimEntered.promise;
        return feedNext(1);
      }
      runtimeCalls++;
      throw Error("Unexpected request");
    });
    const stop = new AbortController();
    const running = runAgent(config, stop.signal);
    try {
      let count = 0;
      for (let i = 0; i < 50 && count === 0; i++) {
        count =
          activityInboxStatus(
            stateFile,
            connection.baseUrl,
            profile,
            "org",
            "repo",
          )?.totalReceived ?? 0;
        if (!count) await pause(20);
      }
      assert.equal(count, 1);
      assert.equal(claims, 1);
      assert.equal(runtimeCalls, 0);
    } finally {
      stop.abort();
      finishClaim.resolve();
      await running;
    }
  },
);

test("a forged expiry or acknowledgement is rejected; only scoped expired entries release a pending page", async (t) => {
  const file = fixture(t);
  const signal = new AbortController().signal;
  rememberActivityBinding(file, connection.baseUrl, profile, binding);
  const poll = async (fn: typeof fetch) => {
    const inbox = new ActivityInbox(file);
    try {
      return await inbox.pollOne(connection, profile, signal, fn);
    } finally {
      inbox.close();
    }
  };
  await poll(async () => {
    const p = await feedNext(1).json();
    p.activities.push({ ...p.activities[0], deliveryId: "b", cursor: 11 });
    p.nextCursor = 11;
    return Response.json(p);
  });
  const id = "1:2:worker:1";
  await assert.rejects(
    poll(async () =>
      Response.json(
        { bindingId: id, expired: [{ cursor: 10, deliveryId: "wrong" }] },
        { status: 410 },
      ),
    ),
    /differs/,
  );
  await assert.rejects(
    poll(async () =>
      Response.json({
        bindingId: id,
        entries: [{ cursor: 10, deliveryId: "a" }],
      }),
    ),
    /differs/,
  );
  const rows = () =>
    readActivityInbox(file, connection.baseUrl, profile, binding)!;
  assert.deepEqual(
    rows().activities.map((a) => a.ack),
    ["pending", "pending"],
  );
  await poll(async () =>
    Response.json(
      { bindingId: id, expired: [{ cursor: 10, deliveryId: "a" }] },
      { status: 410 },
    ),
  );
  assert.equal(rows().retentionTruncated, true);
  assert.deepEqual(
    rows().activities.map((a) => a.ack),
    ["expired", "pending"],
  );
  await poll(async (_, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.entries, [{ cursor: 11, deliveryId: "b" }]);
    return Response.json({ bindingId: id, entries: body.entries });
  });
  assert.deepEqual(
    rows().activities.map((a) => a.ack),
    ["expired", "confirmed"],
  );
  const changed = { ...binding, revision: 2 };
  rememberActivityBinding(file, connection.baseUrl, profile, changed);
  assert.equal(
    readActivityInbox(file, connection.baseUrl, profile, binding),
    null,
  );
  assert.deepEqual(
    readActivityInbox(file, connection.baseUrl, profile, changed)?.activities,
    [],
  );
});
test("old cursor-only stores are rejected intact without inventing receipts", (t) => {
  const file = fixture(t);
  const old = new DatabaseSync(file + ".inbox");
  try {
    old.exec(
      "CREATE TABLE bindings(cursor INTEGER); INSERT INTO bindings VALUES(19); PRAGMA user_version=1",
    );
  } finally {
    old.close();
  }
  assert.throws(() => new ActivityInbox(file), /version 2 required/);
  const check = new DatabaseSync(file + ".inbox", { readOnly: true });
  try {
    assert.equal(
      check.prepare("SELECT cursor FROM bindings").get()?.cursor,
      19,
    );
    assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
  } finally {
    check.close();
  }
});

test("bounded receipt history evicts confirmed entries, exposes the gap, and paginates the local evidence", async (t) => {
  const file = fixture(t);
  const inbox = new ActivityInbox(file);
  const signal = new AbortController().signal;
  const sample = (await feedNext(1).json()).activities[0];
  try {
    inbox.remember(connection.baseUrl, profile, binding);
    for (let i = 0; i < 22; i++) {
      await inbox.pollOne(connection, profile, signal, async (url, init) => {
        const req = JSON.parse(String(init?.body));
        if (String(url).endsWith("/received"))
          return Response.json({
            bindingId: req.bindingId,
            entries: req.entries,
          });
        const activities = Array.from({ length: 25 }, (_, j) => ({
          ...sample,
          deliveryId: "d" + (req.after + j + 1),
          cursor: req.after + j + 1,
        }));
        return Response.json({
          bindingId: sample.bindingId,
          activities,
          nextCursor: req.after + 25,
          hasMore: true,
          truncated: false,
        });
      });
    }
    const page = inbox.records(connection.baseUrl, profile, binding, 0, 100)!;
    assert.equal(page.retentionTruncated, true);
    assert.equal(page.activities[0].activity.cursor, 20);
    assert.equal(page.nextCursor, 119);
    assert.equal(page.hasMore, true);
    assert.equal(
      page.activities.every((a) => a.ack === "confirmed"),
      true,
    );
    assert.equal(
      inbox.records(connection.baseUrl, profile, binding, 219, 100)!.activities
        .length,
      56,
    );
  } finally {
    inbox.close();
  }
});
