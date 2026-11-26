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
        actorLogin: "do-not-persist-user",
        target: { kind: "issue", number: 1 },
        source: { event: "issue_comment", action: "created" },
        reason: "observed",
        taskId: null,
        excerpt: "do-not-persist-private-text",
        truncated: false,
      },
    ],
    nextCursor: 10,
    hasMore: false,
    truncated: false,
  });
}

test("activity polling resumes a durable cursor and persists no private event data", async (t) => {
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
  const db = new DatabaseSync(stateFile + ".inbox");
  try {
    const rows = db.prepare("SELECT * FROM bindings").all();
    assert.doesNotMatch(JSON.stringify(rows), /do-not-persist|local-token/);
  } finally {
    db.close();
  }
  const reopened = new ActivityInbox(stateFile);
  try {
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
