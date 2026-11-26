import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createChannelServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";
import { seedBinding } from "./binding-fixture.js";

test("signed ordinary comment is acknowledged after persistence, visible to admins and in the next task's thread", async (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  seedBinding(
    store,
    { owner: "org", repo: "repo", installationId: 1, repositoryId: 2 },
    "device",
  );
  const server = createChannelServer(
    {
      github: { appId: "1", botLogin: "channel[bot]" },
      connector: { timeoutMs: 1000 },
      dataFile: ":memory:",
      server: { host: "localhost", port: 0 },
    },
    store,
    "hook",
    "admin",
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const comment = async (deliveryId: string, id: number, body: string) => {
    const actor = { type: "User", login: "alice", id: 4 };
    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { id: 2, owner: { login: "org" }, name: "repo" },
      sender: actor,
      action: "created",
      issue: { number: 5, state: "open" },
      comment: { user: actor, id, body },
    });
    return fetch(origin + "/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", "hook").update(payload).digest("hex"),
      },
      body: payload,
    });
  };
  const first = randomUUID();
  const observed = await comment(first, 1, "Consider reader permissions");
  assert.equal(observed.status, 200);
  assert.deepEqual(await observed.json(), {
    observed: true,
    reason: "observed",
    taskId: null,
    duplicate: false,
  });
  assert.equal(
    store.claimAssignment("device", "lease", Date.now() + 1000),
    undefined,
  );
  const path = origin + "/activities/" + first;
  assert.equal((await fetch(path)).status, 401);
  const headers = { authorization: "Bearer admin" };
  const receipt = await (await fetch(path, { headers })).json();
  assert.equal(receipt.activity.excerpt, "Consider reader permissions");
  assert.equal(receipt.reason, "observed");
  const delegated = await comment(randomUUID(), 2, "@channel review this");
  assert.equal(delegated.status, 202);
  const task = await delegated.json();
  const thread = await (
    await fetch(origin + "/tasks/" + task.taskId + "/thread", { headers })
  ).json();
  assert.equal(thread.activities.length, 1);
  assert.equal(thread.activities[0].deliveryId, first);
});
