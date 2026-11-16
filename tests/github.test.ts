import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubClient } from "../src/github.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type ChannelConfig,
  type Task,
} from "../src/contracts.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  github: { appId: "123", botLogin: "helper[bot]" },
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
} as ChannelConfig;
const task = {
  id: "task-1",
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "reader",
  issueNumber: 5,
} as Task;
function fixture(
  options: {
    permission?: string;
    repoId?: number;
    failWrite?: boolean;
    writeStatus?: number;
    failRead?: boolean;
    revokeOnSecondCheck?: boolean;
    comments?: unknown[];
    directory?: boolean;
    size?: number;
  } = {},
) {
  const calls: { path: string; method: string; body: any }[] = [];
  let authChecks = 0;
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    let data: unknown;
    if (url.pathname === "/app/installations/1/access_tokens")
      data = {
        token: "fake-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
        repository_selection: "selected",
        repositories: [{ id: 2 }],
      };
    else if (url.pathname === "/repos/org/repo") {
      if (options.failRead) throw new Error("network failed");
      data = { id: options.repoId ?? 2, name: "repo", owner: { login: "org" } };
    } else if (url.pathname.endsWith("/collaborators/reader/permission")) {
      authChecks++;
      data = {
        permission:
          options.revokeOnSecondCheck && authChecks > 1
            ? "read"
            : (options.permission ?? "write"),
        user: { id: 3, login: "reader" },
      };
    } else if (url.pathname.endsWith("/comments") && method === "POST") {
      if (options.failWrite || options.writeStatus)
        return new Response("{}", { status: options.writeStatus ?? 502 });
      data = {
        id: 9,
        html_url: "https://github.com/org/repo/issues/5#issuecomment-9",
      };
    } else if (url.pathname.endsWith("/comments"))
      data = options.comments ?? [];
    else if (url.pathname.includes("/contents/"))
      data = options.directory
        ? []
        : {
            type: "file",
            size: options.size ?? 5,
            encoding: "base64",
            content: Buffer.from("hello").toString("base64"),
          };
    else if (url.pathname === "/repos/org/repo/issues/5")
      data = { number: 5, title: "untrusted", body: "body" };
    else throw new Error("unexpected request " + url);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    client: new OctokitGitHubClient(config, privateKey, fetchImpl),
    calls,
  };
}
test("installation token is repository and permission scoped", async () => {
  const { client, calls } = fixture();
  await client.authorize(task);
  assert.deepEqual(calls[0]?.body.repository_ids, [2]);
  assert.deepEqual(calls[0]?.body.permissions, {
    metadata: "read",
    contents: "read",
    issues: "write",
    pull_requests: "write",
  });
});
test("authorization rejects repository drift and weak actor role", async () => {
  await assert.rejects(
    fixture({ repoId: 8 }).client.authorize(task),
    AccessDenied,
  );
  await assert.rejects(
    fixture({ permission: "read" }).client.authorize(task),
    AccessDenied,
  );
  await assert.rejects(
    fixture().client.authorize({ ...task, repo: "other" }),
    AccessDenied,
  );
});
test("reads are scoped, marked untrusted and bounded", async () => {
  const { client, calls } = fixture();
  assert.equal(((await client.readIssue(task)) as any).untrusted, true);
  assert.equal(
    ((await client.readFile(task, "README.md")) as any).content,
    "hello",
  );
  for (const path of [
    "",
    "../secret",
    "/secret",
    "a/../b",
    "a\\b",
    "C:/a",
    "%2e%2e/secret",
  ])
    await assert.rejects(client.readFile(task, path));
  await assert.rejects(
    fixture({ directory: true }).client.readFile(task, "folder"),
  );
  await assert.rejects(
    fixture({ size: 131073 }).client.readFile(task, "large"),
  );
  assert.ok(calls.some((x) => x.path === "/repos/org/repo/issues/5"));
});
test("publish reconciles only bot marker and posts once on ambiguous failure", async () => {
  const existing = {
    id: 8,
    html_url: "url",
    body: "<!-- github-agent-channel:task-1 -->",
    user: { login: "helper[bot]" },
  };
  const a = fixture({ comments: [existing] });
  assert.equal((await a.client.publish(task, "result")).id, 8);
  assert.equal(a.calls.filter((x) => x.method === "POST").length, 1);
  const b = fixture({
    comments: [{ ...existing, user: { login: "attacker" } }],
  });
  assert.equal((await b.client.publish(task, "result")).id, 9);
  const c = fixture({ failWrite: true });
  await assert.rejects(c.client.publish(task, "result"), AmbiguousExecution);
  assert.equal(
    c.calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
      .length,
    1,
  );
});
test("comment scan bound refuses creation and excessive response is refused", async () => {
  const a = fixture({
    comments: Array.from({ length: 100 }, () => ({
      body: "other",
      user: { login: "x" },
    })),
  });
  await assert.rejects(a.client.publish(task, "result"), AmbiguousExecution);
  assert.equal(
    a.calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
      .length,
    0,
  );
  await assert.rejects(fixture().client.publish(task, "x".repeat(20001)));
});
test("network authorization failure and revoked permission never permit writes", async () => {
  for (const option of [{ failRead: true }, { revokeOnSecondCheck: true }]) {
    const { client, calls } = fixture(option);
    await assert.rejects(client.publish(task, "result"));
    assert.equal(
      calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
        .length,
      0,
    );
  }
});
test("expired static scoped token never retries the comment write", async () => {
  const { client, calls } = fixture({ writeStatus: 401 });
  await assert.rejects(client.publish(task, "result"));
  assert.equal(
    calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
      .length,
    1,
  );
});
