import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { OpenClawConnector } from "../src/connector.js";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/agent.js";
import { AgentStore } from "../src/agent-store.js";
import type { AgentConfig } from "../src/agent-config.js";
import type { Task, RuntimeResult } from "../src/contracts.js";

const task: Task = {
  id: "a0000000-0000-4000-8000-000000000001",
  deliveryId: "d",
  source: { event: "issue_comment", action: "created", commentId: 1 },
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "alice",
  target: { kind: "issue", number: 4 },
  prompt: "read",
  status: "running",
  deliveryStatus: "pending",
  outcome: null,
  error: null,
  createdAt: 1,
  runtime: null,
  publicationReceipt: null,
};
function config(baseUrl: string): AgentConfig {
  return {
    channel: { baseUrl, tokenEnv: "CLOUD" },
    runtime: {
      type: "openclaw",
      baseUrl: "http://127.0.0.1:18789",
      tokenEnv: "LOCAL",
      agentId: "github",
      timeoutMs: 2000,
      maxToolRounds: 3,
    },
    stateFile: "",
    pollIntervalMs: 100,
    requestTimeoutMs: 1000,
  };
}
async function fixture(
  t: any,
  handler: (path: string, body: any, res: any) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "agent-http-"));
  const server = createServer(async (req, res) => {
    assert.ok(req.url?.startsWith("/connector/v2/"));
    assert.equal(req.headers.authorization, "Bearer dedicated-cloud-token");
    let body = "";
    for await (const chunk of req) body += chunk;
    handler(req.url!, JSON.parse(body), res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const stores: AgentStore[] = [];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "state.db");
  return {
    base,
    path,
    store: () => {
      const store = new AgentStore(path);
      stores.push(store);
      return store;
    },
  };
}
const outcome = (text: string): RuntimeResult => ({
  text,
  artifacts: [],
  publication: { kind: "comment" },
});
const assignment = () => ({
  task,
  leaseToken: "lease-value",
  expiresAt: Date.now() + 10000,
});
const respond = (res: any, value: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

test("lost result acknowledgement retries identical payload and never reruns model", async (t) => {
  const received: any[] = [];
  let claims = 0;
  let models = 0;
  const f = await fixture(t, (path, body, res) => {
    if (path.endsWith("/claim")) {
      claims++;
      respond(res, assignment());
    } else if (path.endsWith("/tool")) {
      assert.equal(body.name, "read_issue");
      respond(res, { title: "source" });
    } else {
      received.push(body);
      if (received.length === 1) res.destroy();
      else respond(res, { accepted: true, duplicate: false });
    }
  });
  const store = f.store();
  t.after(() => store.close());
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async (_task, invoke) => {
        models++;
        assert.deepEqual(await invoke("read_issue", {}), { title: "source" });
        return outcome("summary");
      },
    },
    "dedicated-cloud-token",
  );
  await assert.rejects(agent.once());
  assert.equal(models, 1);
  assert.equal(store.pending()?.phase, "pending");
  await agent.once();
  assert.equal(models, 1);
  assert.deepEqual(received[0], received[1]);
  assert.deepEqual(received[0], {
    leaseToken: "lease-value",
    status: "succeeded",
    outcome: outcome("summary"),
  });
  await agent.once();
  assert.equal(models, 1);
  assert.equal(claims, 2);
});

test("reboot after execution began reports unknown without running model", async (t) => {
  let result: any;
  let modelCalls = 0;
  const f = await fixture(t, (path, body, res) => {
    assert.ok(path.endsWith("/result"));
    result = body;
    respond(res, { accepted: true, duplicate: false });
  });
  let store = f.store();
  store.begin(assignment());
  store.close();
  store = f.store();
  t.after(() => store.close());
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        modelCalls++;
        return outcome("bad");
      },
    },
    "dedicated-cloud-token",
  );
  await agent.once();
  assert.equal(result.status, "unknown");
  assert.equal(modelCalls, 0);
});

test("cloud redirects are refused without forwarding connector credentials", async (t) => {
  let leaked = 0;
  const destination = createServer((_req, res) => {
    leaked++;
    res.end("{}");
  });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  t.after(() => {
    destination.closeAllConnections();
    destination.close();
  });
  const f = await fixture(t, (_path, _body, res) => {
    res.writeHead(307, {
      location:
        "http://127.0.0.1:" + (destination.address() as any).port + "/steal",
    });
    res.end();
  });
  const store = f.store();
  t.after(() => store.close());
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        throw Error("must not execute");
      },
    },
    "dedicated-cloud-token",
  );
  await assert.rejects(agent.once());
  assert.equal(leaked, 0);
});

test("lease conflict closes local result and does not execute again", async (t) => {
  let runs = 0;
  const f = await fixture(t, (path, _body, res) => {
    if (path.endsWith("/claim")) respond(res, assignment());
    else {
      res.writeHead(409);
      res.end("{}");
    }
  });
  const store = f.store();
  t.after(() => store.close());
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        runs++;
        return outcome("answer");
      },
    },
    "dedicated-cloud-token",
  );
  await agent.once();
  await agent.once();
  assert.equal(runs, 1);
  assert.equal(store.pending(), undefined);
});

test("invalid acknowledgement keeps the exact result pending", async (t) => {
  let calls = 0;
  const f = await fixture(t, (path, _body, res) => {
    if (path.endsWith("/claim")) respond(res, assignment());
    else respond(res, {});
  });
  const store = f.store();
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        calls++;
        return outcome("result");
      },
    },
    "dedicated-cloud-token",
  );
  await assert.rejects(agent.once());
  const payload = store.pending()!.result;
  await assert.rejects(agent.once());
  assert.equal(store.pending()!.result, payload);
  assert.equal(calls, 1);
});

test("aborting execution persists unknown and restart only reports it", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  let reported: any;
  const f = await fixture(t, (path, body, res) => {
    if (path.endsWith("/claim")) respond(res, assignment());
    else {
      reported = body;
      respond(res, { accepted: true, duplicate: false });
    }
  });
  let store = f.store();
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        calls++;
        controller.abort();
        return outcome("uncertain");
      },
    },
    "dedicated-cloud-token",
  );
  await agent.once(controller.signal);
  assert.equal(JSON.parse(store.pending()!.result!).status, "unknown");
  store.close();
  store = f.store();
  const next = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        calls++;
        return outcome("bad");
      },
    },
    "dedicated-cloud-token",
  );
  await next.once();
  assert.equal(reported.status, "unknown");
  assert.equal(calls, 1);
});

test("lost claim response never calls the model", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_path, _body, res) => res.destroy());
  const store = f.store();
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        calls++;
        return outcome("bad");
      },
    },
    "dedicated-cloud-token",
  );
  await assert.rejects(agent.once());
  assert.equal(calls, 0);
  assert.equal(store.pending(), undefined);
});

test("expired assignment reports unknown without starting a model", async (t) => {
  let calls = 0;
  let reported: any;
  const f = await fixture(t, (path, body, res) => {
    if (path.endsWith("/claim"))
      respond(res, { ...assignment(), expiresAt: Date.now() - 100 });
    else {
      reported = body;
      respond(res, { accepted: true, duplicate: false });
    }
  });
  const store = f.store();
  const agent = new Agent(
    config(f.base),
    store,
    {
      run: async () => {
        calls++;
        return outcome("bad");
      },
    },
    "dedicated-cloud-token",
  );
  await agent.once();
  assert.equal(calls, 0);
  assert.equal(reported.status, "unknown");
});

test("assignments with missing canonical fields or obsolete aliases are rejected before runtime", async (t) => {
  for (const invalid of [
    {
      ...task,
      target: undefined,
      source: undefined,
      issueNumber: 4,
      commentId: 1,
    },
    { ...task, result: null, commentUrl: null },
  ]) {
    let calls = 0;
    const f = await fixture(t, (_path, _body, res) =>
      respond(res, { ...assignment(), task: invalid }),
    );
    const journal = f.store();
    const agent = new Agent(
      config(f.base),
      journal,
      {
        run: async () => {
          calls++;
          return outcome("never");
        },
      },
      "dedicated-cloud-token",
    );
    await assert.rejects(agent.once(), /assignment is invalid/);
    assert.equal(calls, 0);
    assert.equal(journal.pending(), undefined);
  }
});
test("text-only runtime results are rejected without fabricating publication or artifacts", async (t) => {
  let reported: any;
  const f = await fixture(t, (path, body, res) => {
    if (path.endsWith("/claim")) respond(res, assignment());
    else {
      reported = body;
      respond(res, { accepted: true, duplicate: false });
    }
  });
  const agent = new Agent(
    config(f.base),
    f.store(),
    { run: async () => ({ text: "obsolete shape" }) as RuntimeResult },
    "dedicated-cloud-token",
  );
  await agent.once();
  assert.equal(reported.leaseToken, "lease-value");
  assert.equal(reported.status, "failed");
  assert.equal(reported.failure, "runtime_response_invalid");
});

test("runtime cannot request a repository grant through its tool invoker", async (t) => {
  const paths: string[] = [];
  const f = await fixture(t, (path, _body, res) => {
    paths.push(path);
    respond(
      res,
      path.endsWith("/claim")
        ? assignment()
        : { accepted: true, duplicate: false },
    );
  });
  const agent = new Agent(
    config(f.base),
    f.store(),
    {
      run: async (_task, invoke) => {
        await assert.rejects(invoke("read_source_grant", {}), {
          code: "tool_call_invalid",
        });
        return outcome("summary");
      },
    },
    "dedicated-cloud-token",
  );
  await agent.once();
  assert.deepEqual(
    paths.map((p) => p.split("/").pop()),
    ["claim", "result"],
  );
});
test("pinned review grants stay in the cache preparer, outside model requests, journal and results", async (t) => {
  const token = "installation-read-fixture";
  let sha = "",
    grants = 0,
    requests = 0;
  const revision = () => ({
    baseRepoId: 2,
    headRepoId: 2,
    baseSha: sha,
    headSha: sha,
  });
  const reports: unknown[] = [];
  const f = await fixture(t, (path, body, res) => {
    assert.ok(!JSON.stringify(body).includes(token));
    if (path.endsWith("/claim"))
      return respond(res, {
        ...assignment(),
        expiresAt: Date.now() + 60000,
        task: {
          ...task,
          target: { kind: "pull_request", number: 4, revision: revision() },
        },
      });
    if (path.endsWith("/source-grant")) {
      grants++;
      assert.deepEqual(body, { leaseToken: "lease-value" });
      return respond(res, {
        token,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    }
    if (path.endsWith("/tool")) {
      if (body.name === "read_pull_diff")
        return respond(res, {
          untrusted: true,
          revision: revision(),
          changedFiles: 0,
          files: [],
          limitations: [],
        });
      assert.equal(body.name, "review_access");
      return respond(res, { authorized: true });
    }
    if (path.endsWith("/execution")) return respond(res, { accepted: true });
    reports.push(body);
    respond(res, { accepted: true, duplicate: false });
  });
  const bare = join(realpathSync.native(dirname(f.path)), "fixture.git");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      input: "",
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git(["init", "--bare", "-q", bare]);
  git([
    "--git-dir",
    bare,
    "config",
    "remote.origin.url",
    "https://github.com/org/repo.git",
  ]);
  const tree = git(["--git-dir", bare, "mktree"]);
  sha = git([
    "--git-dir",
    bare,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=test@example.org",
    "commit-tree",
    tree,
    "-m",
    "fixture",
  ]);
  const cfg = config(f.base);
  assert.ok(cfg.runtime.type === "openclaw");
  cfg.stateFile = f.path;
  cfg.runtime.deepReview = true;
  cfg.runtime.timeoutMs = 60000;
  const runtime = new OpenClawConnector(
    cfg.runtime,
    "model-token",
    async (_url, init) => {
      requests++;
      assert.ok(!JSON.stringify(init).includes(token));
      return Response.json({
        id: "r1",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Reviewed." }],
          },
        ],
      });
    },
  );
  const agent = new Agent(
    cfg,
    f.store(),
    runtime,
    "dedicated-cloud-token",
    fetch,
    async (root, assigned, grant) => {
      assert.equal(root, join(dirname(f.path), "review-cache"));
      assert.equal(assigned.id, task.id);
      assert.equal((await grant()).token, token);
      return bare;
    },
  );
  await agent.once();
  assert.match(JSON.stringify(reports), /"status":"succeeded"/);
  assert.equal(grants, 1);
  assert.equal(requests, 1);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM journal WHERE id=?").get(task.id);
    assert.ok(row);
    assert.ok(!JSON.stringify(row).includes(token));
  } finally {
    db.close();
  }
});
