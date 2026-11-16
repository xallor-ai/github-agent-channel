import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/store.js";
import { Worker } from "../src/worker.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type NewTask,
  type GitHubClient,
} from "../src/contracts.js";
const input: NewTask = {
  deliveryId: "d1",
  commentId: 1,
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "alice",
  issueNumber: 4,
  prompt: "review",
};
function github(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    authorize: async () => {},
    readIssue: async () => ({ title: "issue" }),
    readFile: async () => ({ text: "code" }),
    publish: async () => ({ id: 10, url: "https://github.com/comment/10" }),
    ...overrides,
  };
}
test("task executes allowed read and final delivery separately", async () => {
  const store = new TaskStore(":memory:");
  const { task } = store.accept(input);
  let publications = 0;
  const w = new Worker(
    store,
    github({
      publish: async () => {
        publications++;
        return { id: 10, url: "url" };
      },
    }),
    {
      run: async (t, invoke) => {
        assert.deepEqual(await invoke("read_issue", {}), { title: "issue" });
        return { text: "done" };
      },
    },
  );
  assert.equal(await w.tick(), true);
  assert.equal(store.get(task.id)?.status, "succeeded");
  assert.equal(publications, 0);
  await w.tick();
  assert.equal(store.get(task.id)?.deliveryStatus, "sent");
  assert.equal(publications, 1);
  await w.tick();
  assert.equal(publications, 1);
  store.close();
});
test("unauthorized actor never reaches runtime", async () => {
  const s = new TaskStore(":memory:");
  const { task } = s.accept(input);
  let runs = 0;
  await new Worker(
    s,
    github({
      authorize: async () => {
        throw new AccessDenied();
      },
    }),
    {
      run: async () => {
        runs++;
        return { text: "bad" };
      },
    },
  ).tick();
  assert.equal(runs, 0);
  assert.equal(s.get(task.id)?.status, "rejected");
  s.close();
});
test("re-checks authorization on each tool call and rejects target overrides", async () => {
  const s = new TaskStore(":memory:");
  const { task } = s.accept(input);
  let reads = 0;
  await new Worker(
    s,
    github({
      readIssue: async () => {
        reads++;
      },
    }),
    {
      run: async (_, invoke) => {
        await invoke("read_issue", { repo: "other" });
        return { text: "bad" };
      },
    },
  ).tick();
  assert.equal(reads, 0);
  assert.equal(s.get(task.id)?.status, "failed");
  s.close();
});
test("runtime timeout becomes unknown and blocks queued same binding", async () => {
  const s = new TaskStore(":memory:");
  const { task } = s.accept(input);
  s.accept({ ...input, deliveryId: "d2", commentId: 2 });
  const w = new Worker(s, github(), {
    run: async () => {
      throw new AmbiguousExecution();
    },
  });
  await w.tick();
  assert.equal(s.get(task.id)?.status, "unknown");
  assert.equal(await w.tick(), false);
  s.close();
});
test("lost publication response becomes unknown and is not replayed", async () => {
  const s = new TaskStore(":memory:");
  const { task } = s.accept(input);
  let attempts = 0;
  const w = new Worker(
    s,
    github({
      publish: async () => {
        attempts++;
        throw new AmbiguousExecution();
      },
    }),
    { run: async () => ({ text: "done" }) },
  );
  await w.tick();
  await w.tick();
  await w.tick();
  assert.equal(attempts, 1);
  assert.equal(s.get(task.id)?.deliveryStatus, "unknown");
  s.close();
});

test("HTTP timeout and in-progress Responses block the next task", async () => {
  const { OpenClawConnector } = await import("../src/connector.js");
  for (const mode of ["timeout", "in-progress"]) {
    const s = new TaskStore(":memory:");
    const { task } = s.accept(input);
    const second = s.accept({ ...input, deliveryId: "d2", commentId: 2 }).task;
    let requests = 0;
    const connector = new OpenClawConnector(
      {
        baseUrl: "http://localhost:18789",
        agentId: "github",
        tokenEnv: "TOKEN",
        timeoutMs: 100,
        maxToolRounds: 2,
      },
      "secret",
      (async () => {
        requests++;
        return mode === "timeout"
          ? new Response("", { status: 408 })
          : Response.json({ status: "in_progress", output: [] });
      }) as typeof fetch,
    );
    const w = new Worker(s, github(), connector);
    await w.tick();
    assert.equal(await w.tick(), false);
    assert.equal(s.get(task.id)?.status, "unknown");
    assert.equal(s.get(second.id)?.status, "queued");
    assert.equal(requests, 1);
    s.close();
  }
});
