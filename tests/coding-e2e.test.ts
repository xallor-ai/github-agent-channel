import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskStore } from "../src/store.js";
import { PullCoordinator } from "../src/pull.js";
import { createChannelServer } from "../src/server.js";
import { Agent } from "../src/agent.js";
import { AgentStore } from "../src/agent-store.js";
import { AcpConnector } from "../src/acp-connector.js";
import { DeliveryWorker } from "../src/worker.js";
import { OctokitGitHubClient } from "../src/github.js";
import type { AcpRuntimeConfig, AgentConfig } from "../src/agent-config.js";
import type { ChannelConfig } from "../src/contracts.js";

// Real local HTTP, SQLite, Git, ACP SDK subprocess and Octokit. Only GitHub's
// remote transport and the coding harness's model behavior are fixtures.
const hookToken = "coding-hook";
const connectorToken = "coding-connector";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
async function fixture(t: test.TestContext, verificationExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "coding-e2e-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "core.autocrlf", "false");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  git("remote", "add", "origin", "https://github.com/org/repo.git");
  writeFileSync(join(workspace, "file.txt"), "before\n");
  git("add", "file.txt");
  git("commit", "-m", "fixture baseline");
  const baseSha = git("rev-parse", "HEAD");
  const treeSha = git("rev-parse", "HEAD^{tree}");
  const fileSha = git("rev-parse", "HEAD:file.txt");
  const config: ChannelConfig = {
    server: { host: "127.0.0.1", port: 0, adminTokenEnv: "ADMIN" },
    dataFile: join(dir, "cloud.db"),
    github: {
      appId: "123",
      botLogin: "helper[bot]",
      privateKeyEnv: "KEY",
      webhookSecretEnv: "HOOK",
    },
    connector: {
      workerId: "coding-worker",
      tokenEnv: "CONNECTOR",
      timeoutMs: 60000,
    },
    bindings: [
      {
        id: "coding",
        installationId: 1,
        repositoryId: 2,
        owner: "org",
        repo: "repo",
        enabled: true,
        events: ["issue_comment.created"],
        writePolicy: {
          baseBranch: "main",
          allowedPaths: ["file.txt"],
          maxFiles: 1,
          maxBytes: 1024,
        },
      },
    ],
  };
  const apiCalls: { path: string; method: string; body: any }[] = [];
  const githubTransport = (async (input: any, init: any) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    apiCalls.push({ path, method, body });
    let data: unknown;
    if (path === "/app/installations/1/access_tokens")
      data = {
        token: "fixture-installation",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
        repository_selection: "selected",
        repositories: [{ id: 2 }],
      };
    else if (method === "GET" && path === "/repos/org/repo")
      data = { id: 2, name: "repo", owner: { login: "org" } };
    else if (
      method === "GET" &&
      path === "/repos/org/repo/collaborators/alice/permission"
    )
      data = { permission: "write", user: { id: 3, login: "alice" } };
    else if (method === "GET" && path === "/repos/org/repo/issues/5")
      data = {
        number: 5,
        title: "Implement file change",
        body: "Change file.txt to after.",
      };
    else if (method === "GET" && path === "/repos/org/repo/git/ref/heads/main")
      data = { object: { sha: baseSha } };
    else if (
      method === "GET" &&
      path.startsWith("/repos/org/repo/git/ref/heads/channel/")
    )
      return new Response("{}", { status: 404 });
    else if (
      method === "GET" &&
      path === `/repos/org/repo/git/commits/${baseSha}`
    )
      data = { sha: baseSha, tree: { sha: treeSha } };
    else if (
      method === "GET" &&
      path === `/repos/org/repo/git/trees/${treeSha}`
    )
      data = {
        truncated: false,
        tree: [
          { path: "file.txt", type: "blob", mode: "100644", sha: fileSha },
        ],
      };
    else if (
      method === "POST" &&
      [
        "/repos/org/repo/git/blobs",
        "/repos/org/repo/git/trees",
        "/repos/org/repo/git/commits",
      ].includes(path)
    )
      data = { sha: "d".repeat(40) };
    else if (method === "POST" && path === "/repos/org/repo/git/refs")
      data = { object: { sha: "d".repeat(40) } };
    else if (method === "POST" && path === "/repos/org/repo/pulls")
      data = { id: 77, html_url: "https://github.com/org/repo/pull/7" };
    else throw Error(`Unexpected fixture API ${method} ${path}`);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const github = new OctokitGitHubClient(config, key, githubTransport);
  const store = new TaskStore(config.dataFile);
  const journal = new AgentStore(join(dir, "agent.db"));
  const coordinator = new PullCoordinator(
    store,
    github,
    config.connector,
    connectorToken,
  );
  const server = createChannelServer(
    config,
    store,
    hookToken,
    "coding-admin",
    coordinator,
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    journal.close();
    store.close();
    const actual = realpathSync.native(dir);
    assert.equal(dirname(actual), realpathSync.native(tmpdir()));
    assert.ok(basename(actual).startsWith("coding-e2e-"));
    rmSync(actual, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtimeConfig: AcpRuntimeConfig = {
    type: "acp",
    command: process.execPath,
    args: [resolve("tests/fixtures/acp-peer.mjs"), "edit"],
    timeoutMs: 30000,
    workspaces: { "2": workspace },
    envRefs: {},
    permissionPolicy: "deny",
    verification: {
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');if(fs.readFileSync('file.txt','utf8')!=='after\\n')process.exit(9);console.log('verified actual file');process.exit(${verificationExit})`,
      ],
      timeoutMs: 10000,
    },
    publication: { kind: "pull_request", baseBranch: "main" },
  };
  const agentConfig: AgentConfig = {
    channel: { baseUrl: origin, tokenEnv: "CONNECTOR" },
    runtime: runtimeConfig,
    stateFile: join(dir, "agent.db"),
    pollIntervalMs: 100,
    requestTimeoutMs: 10000,
  };
  const outbound: { url: string; body: any }[] = [];
  const localTransport = (async (input: any, init: any) => {
    const url = String(input);
    assert.equal(new URL(url).origin, origin);
    outbound.push({ url, body: JSON.parse(init.body) });
    return fetch(input, init);
  }) as typeof fetch;
  const agent = new Agent(
    agentConfig,
    journal,
    new AcpConnector(runtimeConfig, join(dir, "agent.yaml")),
    connectorToken,
    localTransport,
  );
  const publisher = new DeliveryWorker(store, github);
  const event = JSON.stringify({
    action: "created",
    installation: { id: 1 },
    repository: { id: 2, name: "repo", owner: { login: "org" } },
    sender: { id: 3, login: "alice", type: "User" },
    comment: {
      id: 11,
      body: "@helper[bot] implement this issue",
      user: { id: 3, login: "alice", type: "User" },
    },
    issue: { number: 5 },
  });
  const delivery = randomUUID();
  const webhook = () =>
    fetch(origin + "/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", hookToken).update(event).digest("hex"),
      },
      body: event,
    });
  return {
    store,
    journal,
    agent,
    publisher,
    workspace,
    git,
    baseSha,
    apiCalls,
    outbound,
    webhook,
  };
}

test("signed Issue to ACP file edit, observed verification, nested HTTP outcome and one Octokit draft PR", async (t) => {
  const f = await fixture(t);
  const response = await f.webhook();
  assert.equal(response.status, 202);
  const receipt = (await response.json()) as { taskId: string };
  assert.equal(f.store.get(receipt.taskId)?.status, "queued");
  assert.deepEqual(await (await f.webhook()).json(), {
    taskId: receipt.taskId,
    duplicate: true,
  });
  assert.equal(await f.agent.once(), true);
  const task = f.store.get(receipt.taskId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.deliveryStatus, "pending");
  assert.deepEqual(task.runtime, {
    kind: "started",
    provider: "acp",
    runId: "fixture-session",
  });
  assert.equal(readFileSync(join(f.workspace, "file.txt"), "utf8"), "after\n");
  assert.equal(f.git("rev-parse", "HEAD"), f.baseSha);
  const change = task.outcome?.artifacts.find((a) => a.kind === "change_set");
  assert.equal(change?.baseSha, f.baseSha);
  assert.deepEqual(change?.files, [{ path: "file.txt", content: "after\n" }]);
  const report = task.outcome?.artifacts.find((a) => a.kind === "test_report");
  assert.equal(report?.exitCode, 0);
  assert.match(report?.summary ?? "", /verified actual file/);
  const prompt = readFileSync(
    join(f.workspace, ".git", "received-prompt.json"),
    "utf8",
  );
  assert.match(prompt, /Implement file change/);
  assert.match(prompt, /untrusted/i);
  assert.equal(f.journal.pending(), undefined);
  const submitted = f.outbound.find((c) => c.url.endsWith("/result"))!;
  assert.deepEqual(submitted.body.outcome, task.outcome);
  assert.deepEqual(Object.keys(submitted.body).sort(), [
    "leaseToken",
    "outcome",
    "status",
  ]);
  assert.equal(await f.publisher.tick(), true);
  assert.equal(await f.publisher.tick(), false);
  const writes = f.apiCalls.filter(
    (c) => c.method === "POST" && !c.path.endsWith("access_tokens"),
  );
  assert.deepEqual(
    writes.map((c) => c.path.split("/").at(-1)),
    ["blobs", "trees", "commits", "refs", "pulls"],
  );
  assert.equal(
    Buffer.from(writes[0].body.content, "base64").toString("utf8"),
    "after\n",
  );
  assert.deepEqual(writes[2].body.parents, [f.baseSha]);
  assert.equal(writes[3].body.ref, `refs/heads/channel/${task.id}`);
  assert.equal(writes[4].body.head, `channel/${task.id}`);
  assert.equal(writes[4].body.draft, true);
  assert.equal(writes[4].body.base, "main");
  assert.match(writes[4].body.body, /exitCode=0/);
  assert.match(writes[4].body.body, /Related issue: #5/);
  assert.deepEqual(f.store.get(task.id)?.publicationReceipt, {
    kind: "pull_request",
    id: 77,
    url: "https://github.com/org/repo/pull/7",
  });
  assert.equal(f.store.get(task.id)?.deliveryStatus, "sent");
  const duplicate = await fetch(submitted.url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + connectorToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(submitted.body),
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true });
  assert.equal(
    ((await (await f.webhook()).json()) as { duplicate: boolean }).duplicate,
    true,
  );
  assert.equal(await f.agent.once(), false);
  assert.equal(await f.publisher.tick(), false);
  assert.equal(
    f.apiCalls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"))
      .length,
    1,
  );
  assert.equal(
    f.apiCalls.filter((c) => c.path.endsWith("/comments")).length,
    0,
  );
  assert.equal(
    f.outbound.filter((c) => c.url.endsWith("/execution")).length,
    1,
  );
});

test("failed observed verification preserves code artifacts but suppresses all GitHub publication", async (t) => {
  const f = await fixture(t, 7);
  const receipt = (await (await f.webhook()).json()) as { taskId: string };
  assert.equal(await f.agent.once(), true);
  const task = f.store.get(receipt.taskId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.deliveryStatus, "skipped");
  assert.equal(
    task.outcome?.artifacts.find((a) => a.kind === "test_report")?.exitCode,
    7,
  );
  assert.deepEqual(task.outcome?.publication, { kind: "none" });
  assert.deepEqual(
    task.outcome?.artifacts.find((a) => a.kind === "change_set")?.files,
    [{ path: "file.txt", content: "after\n" }],
  );
  assert.equal(readFileSync(join(f.workspace, "file.txt"), "utf8"), "after\n");
  assert.equal(await f.publisher.tick(), false);
  assert.equal(task.publicationReceipt, null);
  assert.equal(
    f.apiCalls.filter(
      (c) => c.method === "POST" && !c.path.endsWith("access_tokens"),
    ).length,
    0,
  );
});
