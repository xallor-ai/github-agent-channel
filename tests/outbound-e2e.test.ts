import { seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskStore } from "../src/store.js";
import { PullCoordinator } from "../src/pull.js";
import { createChannelServer } from "../src/server.js";
import { DeliveryWorker } from "../src/worker.js";
import { Agent } from "../src/agent.js";
import { AgentStore } from "../src/agent-store.js";
import { OpenClawConnector } from "../src/connector.js";
import type { AgentConfig } from "../src/agent-config.js";
import {
  AccessDenied,
  type ChannelConfig,
  type GitHubClient,
  type Task,
} from "../src/contracts.js";

const hookToken = "fixture-hook-token";
const cloudToken = "fixture-connector-token";
const adminToken = "fixture-admin-token";
const runtimeToken = "fixture-local-openclaw-token";
const cloudConfig: ChannelConfig = {
  server: { host: "127.0.0.1", port: 0, adminTokenEnv: "ADMIN" },
  dataFile: ":memory:",
  github: {
    appId: "1",
    privateKeyEnv: "KEY",
    webhookSecretEnv: "HOOK",
    botLogin: "fixture[bot]",
  },
  connector: {
    timeoutMs: 30000,
  },
};
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "outbound-e2e-"));
  const store = new TaskStore(join(dir, "cloud.db"));
  seedBinding(
    store,
    {
      installationId: 1,
      repositoryId: 2,
      owner: "fixture-org",
      repo: "fixture-repo",
    },
    "fixture-worker",
  );
  const publications: { task: Task; text: string }[] = [];
  const reads: Task[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  let authorized = true;
  const github: GitHubClient = {
    authorize: async (task) => {
      assert.equal(task.owner, "fixture-org");
      assert.equal(task.repo, "fixture-repo");
      assert.equal(task.actorLogin, "alice");
      if (!authorized) throw new AccessDenied();
    },
    readIssue: async (task) => {
      reads.push(task);
      return { title: "fixture issue", body: "source text", untrusted: true };
    },
    readFile: async () => {
      throw new Error("Unexpected read_file");
    },
    publishPullRequest: async () => {
      throw Error("Unexpected PR publication");
    },
    publishComment: async (task, text) => {
      publications.push({ task, text });
      return {
        id: 7,
        url: "https://github.com/fixture-org/fixture-repo/issues/3#issuecomment-7",
      };
    },
  };
  const coordinator = new PullCoordinator(
    store,
    github,
    cloudConfig.connector,
    (value) =>
      value === cloudToken ? { deviceId: "fixture-worker" } : undefined,
  );
  const cloud = createChannelServer(
    cloudConfig,
    store,
    hookToken,
    adminToken,
    coordinator,
  );
  const cloudUrl = await listen(cloud);
  // The cloud is already running before a local Runtime address even exists.
  // Only the outbound Agent receives the Runtime address below.
  let runtimeError: unknown;
  const model = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer " + runtimeToken);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      assert.doesNotMatch(
        raw,
        new RegExp(cloudToken + "|" + adminToken + "|" + hookToken),
      );
      const data = JSON.parse(raw);
      modelRequests.push(data);
      assert.equal(data.model, "openclaw/github");
      res.writeHead(200, { "content-type": "application/json" });
      if (modelRequests.length === 1) {
        assert.equal(data.previous_response_id, undefined);
        assert.deepEqual(data.input, [
          {
            type: "message",
            role: "user",
            content: "@fixture[bot] summarize this issue",
          },
        ]);
        assert.deepEqual(
          data.tools.map((x: { name: string }) => x.name),
          ["read_issue", "read_file"],
        );
        res.end(
          JSON.stringify({
            id: "response-read",
            status: "completed",
            output: [
              {
                type: "function_call",
                name: "read_issue",
                call_id: "call-read",
                arguments: "{}",
              },
            ],
          }),
        );
      } else {
        assert.equal(modelRequests.length, 2);
        assert.equal(data.previous_response_id, "response-read");
        assert.deepEqual(data.input, [
          {
            type: "function_call_output",
            call_id: "call-read",
            output: JSON.stringify({
              title: "fixture issue",
              body: "source text",
              untrusted: true,
            }),
          },
        ]);
        res.end(
          JSON.stringify({
            id: "response-done",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Fixture summary" }],
              },
            ],
          }),
        );
      }
    } catch (error) {
      runtimeError = error;
      res.statusCode = 500;
      res.end("fixture protocol failed");
    }
  });
  const modelUrl = await listen(model);
  const agentConfig: AgentConfig = {
    channel: { baseUrl: cloudUrl, tokenEnv: "CHANNEL_TOKEN" },
    runtime: {
      type: "openclaw",
      baseUrl: modelUrl,
      tokenEnv: "LOCAL_TOKEN",
      agentId: "github",
      timeoutMs: 10000,
      maxToolRounds: 3,
    },
    stateFile: join(dir, "local.db"),
    pollIntervalMs: 100,
    requestTimeoutMs: 5000,
  };
  const journal = new AgentStore(agentConfig.stateFile);
  const runtime = new OpenClawConnector(agentConfig.runtime, runtimeToken);
  const agent = new Agent(agentConfig, journal, runtime, cloudToken);
  const publisher = new DeliveryWorker(store, github);
  t.after(async () => {
    await close(cloud);
    await close(model);
    journal.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const event = JSON.stringify({
    action: "created",
    installation: { id: 1 },
    repository: {
      id: 2,
      name: "fixture-repo",
      owner: { login: "fixture-org" },
    },
    sender: { id: 5, login: "alice", type: "User" },
    comment: {
      id: 11,
      body: "@fixture[bot] summarize this issue",
      user: { id: 5, login: "alice", type: "User" },
    },
    issue: { number: 3 },
  });
  const delivery = randomUUID();
  const webhook = (valid = true) =>
    fetch(cloudUrl + "/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          "sha256=" +
          (valid
            ? createHmac("sha256", hookToken).update(event).digest("hex")
            : "0".repeat(64)),
      },
      body: event,
    });
  return {
    store,
    journal,
    agent,
    publisher,
    modelRequests,
    publications,
    reads,
    webhook,
    cloudUrl,
    setAuthorized: (value: boolean) => {
      authorized = value;
    },
    runtimeError: () => runtimeError,
  };
}

test("signed webhook travels through outbound Agent and local Responses tools to one cloud publication", async (t) => {
  const f = await fixture(t);
  const response = await f.webhook();
  assert.equal(response.status, 202);
  const receipt = (await response.json()) as { taskId: string };
  assert.equal(f.store.get(receipt.taskId)?.status, "queued");
  assert.equal(f.modelRequests.length, 0);
  const duplicate = await f.webhook();
  assert.deepEqual(await duplicate.json(), {
    taskId: receipt.taskId,
    duplicate: true,
  });
  assert.equal(await f.agent.once(), true);
  assert.equal(f.runtimeError(), undefined);
  assert.equal(f.modelRequests.length, 2);
  assert.equal(f.reads.length, 1);
  assert.equal(f.store.get(receipt.taskId)?.status, "succeeded");
  assert.deepEqual(f.store.get(receipt.taskId)?.target, {
    kind: "issue",
    number: 3,
  });
  assert.deepEqual(f.store.get(receipt.taskId)?.source, {
    event: "issue_comment",
    action: "created",
    commentId: 11,
  });
  assert.equal(
    f.store.get(receipt.taskId)?.outcome?.responseId,
    "response-done",
  );
  assert.equal(f.publications.length, 0);
  assert.equal(f.journal.pending(), undefined);
  assert.equal(await f.publisher.tick(), true);
  assert.equal(await f.publisher.tick(), false);
  assert.equal(f.publications.length, 1);
  assert.equal(f.publications[0].text, "Fixture summary");
  assert.equal(f.publications[0].task.id, receipt.taskId);
  assert.equal(f.store.get(receipt.taskId)?.deliveryStatus, "sent");
  assert.deepEqual(f.store.get(receipt.taskId)?.publicationReceipt, {
    kind: "comment",
    id: 7,
    url: "https://github.com/fixture-org/fixture-repo/issues/3#issuecomment-7",
  });
  assert.equal((await f.webhook()).status, 202);
  assert.equal(await f.agent.once(), false);
  assert.equal(f.modelRequests.length, 2);
  assert.equal(f.publications.length, 1);
});
test("connector v2 rejects flat results and accepts only explicit structured outcomes", async (t) => {
  const f = await fixture(t);
  const receipt = (await (await f.webhook()).json()) as { taskId: string };
  const post = (path: string, body: unknown) =>
    fetch(f.cloudUrl + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + cloudToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/connector/v1/claim", {})).status, 404);
  const claimed = await post("/connector/v2/claim", {});
  assert.equal(claimed.status, 200);
  const assignment = (await claimed.json()) as { leaseToken: string };
  const path = "/connector/v2/tasks/" + receipt.taskId + "/result";
  assert.equal(
    (
      await post(path, {
        leaseToken: assignment.leaseToken,
        status: "succeeded",
        text: "flat",
        responseId: "old",
      })
    ).status,
    400,
  );
  assert.equal(f.store.get(receipt.taskId)?.status, "running");
  const outcome = {
    text: "structured",
    artifacts: [],
    publication: { kind: "comment" },
  };
  assert.equal(
    (
      await post(path, {
        leaseToken: assignment.leaseToken,
        status: "succeeded",
        outcome,
      })
    ).status,
    200,
  );
  assert.deepEqual(f.store.get(receipt.taskId)?.outcome, outcome);
});

test("bad signature and admin Bearer cannot trigger connector execution", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.webhook(false)).status, 400);
  const id = randomUUID();
  for (const path of ["claim", `tasks/${id}/tool`, `tasks/${id}/result`]) {
    const result = await fetch(f.cloudUrl + "/connector/v2/" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + adminToken,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(result.status, 401);
  }
  assert.equal(await f.agent.once(), false);
  assert.equal(f.modelRequests.length, 0);
  assert.equal(f.publications.length, 0);
});

test("caller denial skips task without stopping agent from executing the next authorized task", async (t) => {
  const f = await fixture(t);
  f.setAuthorized(false);
  const receipt = (await (await f.webhook()).json()) as { taskId: string };
  assert.equal(await f.agent.once(), false);
  assert.equal(f.store.get(receipt.taskId)?.status, "rejected");
  assert.equal(f.modelRequests.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.publications.length, 0);
  f.setAuthorized(true);
  const rejected = f.store.get(receipt.taskId)!;
  const next = f.store.accept({
    ...rejected,
    deliveryId: randomUUID(),
    source: { ...rejected.source, commentId: 12 },
  }).task;
  assert.equal(await f.agent.once(), true);
  assert.equal(f.modelRequests.length, 2);
  assert.equal(f.store.get(next.id)?.status, "succeeded");
  await f.publisher.tick();
  assert.equal(f.publications.length, 1);
  assert.equal(f.publications[0].task.id, next.id);
});

test("cloud result storage outage preserves local journal and retry does not rerun model", async (t) => {
  const f = await fixture(t);
  const receipt = (await (await f.webhook()).json()) as { taskId: string };
  const finish = f.store.finishAssignment.bind(f.store);
  let failed = false;
  t.mock.method(
    f.store,
    "finishAssignment",
    (...args: Parameters<TaskStore["finishAssignment"]>) => {
      if (!failed) {
        failed = true;
        throw new Error("SQLITE_IOERR synthetic failure");
      }
      return finish(...args);
    },
  );
  await assert.rejects(f.agent.once());
  assert.equal(f.modelRequests.length, 2);
  assert.equal(f.store.get(receipt.taskId)?.status, "running");
  assert.equal(f.journal.pending()?.phase, "pending");
  assert.equal(await f.agent.once(), true);
  assert.equal(f.modelRequests.length, 2);
  assert.equal(f.journal.pending(), undefined);
  assert.equal(f.store.get(receipt.taskId)?.status, "succeeded");
  await f.publisher.tick();
  await f.publisher.tick();
  assert.equal(f.publications.length, 1);
});
