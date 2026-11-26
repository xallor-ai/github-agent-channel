import { fixtureAgent } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHmac,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TaskStore } from "../src/store.js";
import { DeviceService } from "../src/device-service.js";
import { createChannelServer } from "../src/server.js";
import { BindingPrincipalVerifier } from "../src/binding-principal.js";
import { DeliveryWorker } from "../src/worker.js";
import { PullCoordinator } from "../src/pull.js";
import { OctokitGitHubClient } from "../src/github.js";
import { AccessDenied, type ChannelConfig } from "../src/contracts.js";

test("two paired devices on two repositories: signed ingress, offline recovery, scoped claims, expiry, revision fencing and one confirmed comment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-two-repos-"));
  const config: ChannelConfig = {
    dataFile: join(dir, "tasks.db"),
    server: { host: "127.0.0.1", port: 0, adminTokenEnv: "ADMIN" },
    github: { appId: "1", botLogin: "robot[bot]" },
    connector: { timeoutMs: 60000 },
  };
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const repos = [
    { id: 11, name: "alpha", owner: { login: "example" } },
    { id: 12, name: "beta", owner: { login: "example" } },
  ];
  const githubUsers = [
    { id: 81, login: "first" },
    { id: 82, login: "second" },
  ];
  const actor = { id: 99, login: "author", type: "User" };
  const publication: string[] = [];
  let actorAllowed = true,
    secondAdmin = true;
  // Only external GitHub transport is synthetic. Octokit authenticates managers,
  // scopes installation tokens, checks actor access and issues the actual API calls.
  const gitFetch: typeof fetch = async (url, init) => {
    const { pathname, origin } = new URL(String(url));
    assert.equal(origin, "https://api.github.com");
    if (pathname === "/user") {
      const n = githubUsers.find(
        (u) =>
          new Headers(init?.headers).get("authorization") ===
          "Bearer user-" + u.id,
      );
      return Response.json(n ?? {}, { status: n ? 200 : 401 });
    }
    if (pathname.startsWith("/user/"))
      return Response.json(
        githubUsers.find((u) => pathname === "/user/" + u.id),
      );
    for (const [i, r] of repos.entries()) {
      const prefix = "/repos/example/" + r.name,
        installationId = 700 + i;
      if (pathname === prefix + "/installation")
        return Response.json({ id: installationId, suspended_at: null });
      if (
        pathname ===
        "/app/installations/" + installationId + "/access_tokens"
      ) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(
          body.repositories ?? body.repository_ids,
          body.repositories ? [r.name] : [r.id],
        );
        return Response.json({
          token: "ghs_fixture_" + r.name,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: body.permissions,
          repository_selection: "selected",
          repositories: [r],
        });
      }
      if (pathname === prefix) return Response.json(r);
      if (pathname.startsWith(prefix + "/collaborators/")) {
        const login = pathname.split("/").at(-2);
        if (login === actor.login)
          return Response.json({
            permission: actorAllowed ? "write" : "read",
            user: actor,
          });
        const user = githubUsers.find((u) => u.login === login);
        return Response.json({
          permission:
            user?.id === githubUsers[i].id && (i === 0 || secondAdmin)
              ? "admin"
              : "read",
          user,
        });
      }
      if (pathname === prefix + "/issues/1")
        return Response.json({ number: 1, state: "open" });
      if (pathname === prefix + "/issues/1/comments") {
        if (init?.method === "POST") {
          publication.push(r.name + ":" + JSON.parse(String(init.body)).body);
          return Response.json({
            id: 333,
            html_url:
              "https://github.com/example/" +
              r.name +
              "/issues/1#issuecomment-333",
          });
        }
        return Response.json([]);
      }
    }
    throw Error("Unexpected GitHub route: " + pathname);
  };
  async function start() {
    const store = new TaskStore(config.dataFile);
    store.recover();
    const devices = new DeviceService({
      dbPath: config.dataFile + ".devices",
      adminToken: "admin",
      registry: store.registry,
      runtimeLastSeen: store.runtimeLastSeen.bind(store),
      recentActivities: store.activitiesForDevice.bind(store),
      appId: "1",
      privateKey: key,
      fetchImpl: gitFetch,
    });
    const lookup = (i: number, r: number) => {
      const b = store.activeBinding(i, r);
      return b && devices.isActive(b.deviceId) ? b : undefined;
    };
    const verifier = new BindingPrincipalVerifier(
      "1",
      key,
      async (token) => devices.authenticate(token),
      gitFetch,
    );
    const github = new OctokitGitHubClient(
      config,
      key,
      lookup,
      async (task) => {
        const b = lookup(task.installationId, task.repositoryId),
          who = b && devices.principalForDevice(b.deviceId);
        if (
          !who ||
          b?.id !== task.bindingId ||
          who.githubUserId !== b.administratorId
        )
          throw new AccessDenied("binding unavailable");
        const { who: checked } = await verifier.verifyPaired(who, {
          owner: task.owner,
          repo: task.repo,
        });
        if (
          checked.installationId !== task.installationId ||
          checked.repositoryId !== task.repositoryId
        )
          throw new AccessDenied("scope changed");
      },
      gitFetch,
    );
    const coordinator = new PullCoordinator(
      store,
      github,
      config.connector,
      (token) => devices.authenticate(token),
    );
    const worker = new DeliveryWorker(store, github);
    const server = createChannelServer(
      config,
      store,
      "webhook",
      "admin",
      {
        async handle(req, res) {
          return (
            (await devices.handle(req, res)) ||
            (await coordinator.handle(req, res))
          );
        },
      },
      lookup,
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    return {
      store,
      worker,
      url: "http://127.0.0.1:" + addr.port,
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        devices.close();
        store.close();
      },
    };
  }
  let cloud = await start();
  t.after(async () => {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = async (path: string, token: string, input: unknown) =>
    fetch(cloud.url + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  const v = "/connector/v2";
  const tokens = githubUsers.map(() => randomBytes(32).toString("base64url"));
  const declare = (
    i: number,
    repo: number,
    revision: number,
    enabled: boolean,
  ) =>
    post(v + "/bindings/apply", tokens[i], {
      owner: "example",
      repo: repos[repo].name,
      expectedRevision: revision,
      declaration: {
        enabled,
        ...(enabled
          ? { responsibleAgent: fixtureAgent, autoTriage: true }
          : {}),
        events: enabled ? ["issues.opened"] : [],
      },
    });
  const claim = (i: number) =>
    post(v + "/claim", tokens[i], { runtime: fixtureAgent });
  const hook = (i: number, delivery = randomUUID(), signature = true) => {
    const body = JSON.stringify({
      installation: { id: 700 + i },
      repository: repos[i],
      sender: actor,
      action: "opened",
      issue: { number: 1, title: "inspect", body: "hello", state: "open" },
    });
    return fetch(cloud.url + "/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", signature ? "webhook" : "incorrect")
            .update(body)
            .digest("hex"),
      },
      body,
    });
  };
  const accept = async (i: number, delivery = randomUUID()) => {
    const response = await hook(i, delivery);
    assert.equal(response.status, 202);
    return (await response.json()).taskId as string;
  };
  const result = (i: number, id: string, leaseToken: string) =>
    post(v + "/tasks/" + id + "/result", tokens[i], {
      leaseToken,
      status: "succeeded",
      outcome: {
        text: "report",
        artifacts: [],
        publication: { kind: "comment" },
      },
    });
  assert.equal((await hook(0, randomUUID(), false)).status, 400);
  assert.deepEqual(await (await hook(0)).json(), { ignored: true });
  for (const [i, u] of githubUsers.entries()) {
    const invitation = await post("/admin/device-invites", "admin", {
      githubUserId: u.id,
    });
    assert.equal(invitation.status, 201);
    const paired = await post(v + "/devices/pair", "user-" + u.id, {
      invite: (await invitation.json()).invite,
      deviceToken: tokens[i],
    });
    assert.equal(paired.status, 201);
    assert.equal((await declare(i, i, 0, true)).status, 200);
  }
  assert.equal((await declare(1, 0, 1, false)).status, 403);
  const delivery = randomUUID(),
    id = await accept(0, delivery);
  assert.equal(await accept(0, delivery), id);
  assert.equal((await claim(1)).status, 204);
  const second = await accept(1);
  await cloud.close();
  cloud = await start();
  const feed = (
    user: number,
    repository: number,
    after = 0,
    agent = fixtureAgent.id as string,
  ) =>
    post(v + "/activities", tokens[user], {
      owner: "example",
      repo: repos[repository].name,
      runtime: { ...fixtureAgent, id: agent },
      after,
      limit: 1,
    });
  const pageResponse = await feed(0, 0);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.bindingId, cloud.store.get(id)?.bindingId);
  assert.equal(page.activities.length, 1);
  assert.equal(page.activities[0].deliveryId, delivery);
  assert.equal(page.activities[0].taskId, id);
  assert.equal(page.activities[0].reason, "triage");
  const emptyPage = await (await feed(0, 0, page.nextCursor)).json();
  assert.equal(emptyPage.bindingId, page.bindingId);
  assert.deepEqual(emptyPage.activities, []);
  assert.equal((await feed(0, 0, 0, "different-agent")).status, 403);
  assert.equal((await feed(1, 0)).status, 403);
  const pollEvidence = async (i: number) =>
    (
      await (
        await post(v + "/bindings/read", tokens[i], {
          owner: "example",
          repo: repos[i].name,
        })
      ).json()
    ).coverage.runtimePoll;
  assert.deepEqual(await pollEvidence(0), {
    status: "never_seen",
    lastPolledAt: null,
  });
  assert.equal((await pollEvidence(1)).status, "recent");
  const alpha = await claim(0);
  assert.equal(alpha.status, 200);
  assert.equal((await pollEvidence(0)).status, "recent");
  const firstAssignment = await alpha.json();
  assert.equal(firstAssignment.task.id, id);
  assert.equal((await result(1, id, firstAssignment.leaseToken)).status, 409);
  assert.equal((await result(0, id, firstAssignment.leaseToken)).status, 200);
  assert.deepEqual(
    await (await result(0, id, firstAssignment.leaseToken)).json(),
    { accepted: true, duplicate: true },
  );
  assert.equal(await cloud.worker.tick(), true);
  assert.equal(await cloud.worker.tick(), false);
  assert.deepEqual(publication, [
    "alpha:report\n\n<!-- github-agent-channel:" + id + " -->",
  ]);
  assert.equal(cloud.store.get(id)?.publicationReceipt?.id, 333);
  // A manager losing admin and a requester losing write each deny a dispatch.
  secondAdmin = false;
  assert.equal((await claim(1)).status, 204);
  assert.equal(cloud.store.get(second)?.status, "rejected");
  secondAdmin = true;
  actorAllowed = false;
  const denied = await accept(1);
  assert.equal((await claim(1)).status, 204);
  assert.equal(cloud.store.get(denied)?.status, "rejected");
  actorAllowed = true;
  const timedOut = await accept(1);
  cloud.store.expireTasks(Date.now() + 86400000);
  assert.equal((await claim(1)).status, 204);
  assert.equal(cloud.store.get(timedOut)?.status, "rejected");
  const old = await accept(1),
    queued = await accept(1);
  const active = await (await claim(1)).json();
  assert.equal(active.task.id, old);
  assert.equal((await declare(1, 1, 1, false)).status, 200);
  assert.equal((await feed(1, 1)).status, 403);
  assert.equal(cloud.store.get(queued)?.status, "rejected");
  assert.equal((await result(1, old, active.leaseToken)).status, 409);
  assert.equal(cloud.store.get(old)?.status, "unknown");
  assert.deepEqual(await (await hook(1)).json(), { ignored: true });
  assert.equal((await declare(1, 1, 1, true)).status, 409);
  assert.equal(await cloud.worker.tick(), false);
  assert.equal(publication.length, 1);
});
