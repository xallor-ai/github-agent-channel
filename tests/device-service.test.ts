import { fixtureAgent } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceService } from "../src/device-service.js";
import { TaskStore } from "../src/store.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const random = () => randomBytes(32).toString("base64url");
const base = "/connector/v2";

test("pairing is bound to an expiring one-use invitation and a GitHub numeric identity; secrets never enter storage", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-device-"));
  const dbPath = join(dir, "devices.db");
  const tasks = new TaskStore(":memory:");
  let githubUserId = 99;
  let now = 1000;
  let gate: (() => Promise<void>) | undefined;
  const selection = { owner: "org", repo: "project" };
  const repository = { id: 12, name: "project", owner: { login: "org" } };
  const user = { id: 99, login: "person" };
  const githubToken = "github_user_token_fixture";
  let lastPoll: number | null = null;
  const options = {
    runtimeLastSeen: () => lastPoll,
    registry: tasks.registry,
    dbPath,
    appId: "1",
    privateKey,
    adminToken: "admin-test",
    now: () => now,
    fetchImpl: (async (url, init) => {
      const { origin, pathname } = new URL(String(url));
      assert.equal(origin, "https://api.github.com");
      const route: Record<string, unknown> = {
        "/user": { id: githubUserId },
        "/repos/org/project/installation": {
          id: 56,
          suspended_at: null,
          events: ["issues"],
          permissions: { issues: "read", metadata: "read" },
        },
        "/app/installations/56/access_tokens": {
          token: "ghs_test",
          repository_selection: "selected",
          repositories: [repository],
          permissions: { metadata: "read" },
        },
        "/user/99": user,
        "/repos/org/project/collaborators/person/permission": {
          permission: "admin",
          user,
        },
        "/repos/org/project": repository,
      };
      if (pathname === "/user") {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer " + githubToken,
        );
        assert.equal(init?.redirect, "error");
      }
      if (pathname === "/repos/org/project" && gate) await gate();
      assert.ok(Object.hasOwn(route, pathname));
      return Response.json(route[pathname]);
    }) satisfies typeof fetch,
  };
  let device = new DeviceService(options);
  const server = createServer(async (req, res) => {
    if (!(await device.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    device.close();
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const post = (path: string, token: string, payload: unknown) =>
    fetch("http://127.0.0.1:" + addr.port + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  const invitePath = "/admin/device-invites";
  const issue = async () => {
    const r = await post(invitePath, "admin-test", { githubUserId: 99 });
    assert.equal(r.status, 201);
    return String((await r.json()).invite);
  };
  const pair = (invite: string, deviceToken: string) =>
    post(base + "/devices/pair", githubToken, { invite, deviceToken });
  const token = random();
  assert.equal(
    (await post(invitePath, token, { githubUserId: 99 })).status,
    401,
  );
  const old = await issue();
  now += 600000;
  assert.equal((await pair(old, token)).status, 403);
  const invite = await issue();
  githubUserId = 20;
  assert.equal((await pair(invite, token)).status, 403);
  githubUserId = 99;
  const duplicate = await Promise.all([
    pair(invite, token),
    pair(invite, random()),
  ]);
  assert.deepEqual(duplicate.map((r) => r.status).sort(), [201, 403]);
  const ownToken = random();
  const ownInvite = await issue();
  const paired = await pair(ownInvite, ownToken);
  assert.equal(paired.status, 201);
  const who = await paired.json();
  assert.deepEqual(device.authenticate(ownToken), who);
  device.close();
  device = new DeviceService(options);
  assert.deepEqual(device.authenticate(ownToken), who);
  for (const secret of [githubToken, ownToken, ownInvite])
    assert.equal(readFileSync(dbPath).includes(Buffer.from(secret)), false);
  const read = () => post(base + "/bindings/read", ownToken, selection);
  assert.deepEqual(await (await read()).json(), {
    binding: null,
    coverage: {
      runtimePoll: { status: "unbound", lastPolledAt: null },
      subscriptions: ["issues"],
      permissions: { issues: "read" },
      serverWriteProfile: null,
    },
  });
  const write = () =>
    post(base + "/bindings/apply", ownToken, {
      ...selection,
      expectedRevision: 0,
      declaration: {
        enabled: true,
        responsibleAgent: fixtureAgent,
        events: ["issues.opened"],
      },
    });
  const applied = await write();
  assert.equal(applied.status, 200);
  assert.deepEqual((await applied.json()).coverage.runtimePoll, {
    status: "never_seen",
    lastPolledAt: null,
  });
  lastPoll = now;
  assert.deepEqual((await (await read()).json()).coverage.runtimePoll, {
    status: "recent",
    lastPolledAt: lastPoll,
  });
  now += 120001;
  assert.deepEqual((await (await read()).json()).coverage.runtimePoll, {
    status: "last_seen",
    lastPolledAt: lastPoll,
  });
  const otherToken = random();
  await pair(await issue(), otherToken);
  assert.equal(
    (await post(base + "/bindings/read", otherToken, selection)).status,
    403,
  );
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r));
  gate = () => {
    entered();
    return new Promise<void>((r) => (resume = r));
  };
  const pending = write();
  await waiting;
  const revoke = () =>
    post("/admin/device-revoke", "admin-test", { deviceId: who.deviceId });
  // Fail the second database write: credential denial is already durable,
  // and the next startup must fence the binding before serving requests.
  const failure = t.mock.method(tasks.registry, "revokeDevice", () => {
    throw Error("simulated task DB failure");
  });
  assert.equal((await revoke()).status, 500);
  resume();
  assert.equal((await pending).status, 401);
  assert.equal((await read()).status, 401);
  failure.mock.restore();
  device.close();
  device = new DeviceService(options);
  assert.equal(device.authenticate(ownToken), undefined);
  assert.equal(
    tasks.registry.get({ installationId: 56, repositoryId: 12 })?.enabled,
    false,
  );
  assert.equal((await revoke()).status, 200);
});

test("device database refuses an unrelated SQLite file without changing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-device-layout-"));
  const dbPath = join(dir, "devices.db");
  const store = new TaskStore(":memory:");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated(value INTEGER)");
    db.close();
    const before = readFileSync(dbPath);
    assert.throws(
      () =>
        new DeviceService({
          dbPath,
          adminToken: "admin",
          appId: "1",
          privateKey,
          registry: store.registry,
        }),
    );
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
