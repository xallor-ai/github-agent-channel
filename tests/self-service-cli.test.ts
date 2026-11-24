import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminCommand,
  pairCommand,
  repoCommand,
} from "../src/self-service-cli.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "channel-self-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "agent.yaml"),
    file = join(dir, "repo.yaml"),
    token = join(dir, "device-token");
  writeFileSync(
    config,
    `channel: {baseUrl: https://channel.example, tokenFile: device-token}
runtime: {type: openclaw, baseUrl: 'http://localhost:18789', tokenFile: missing-model-token, agentId: github, timeoutMs: 1000, maxToolRounds: 2}
stateFile: state.db
pollIntervalMs: 500
requestTimeoutMs: 5000`,
  );
  const target = { owner: "xallor-ai", repo: "xallor" };
  const enabled = {
    enabled: true,
    requireMention: true,
    events: ["issue_comment.created"],
  };
  const disabled = { enabled: false, requireMention: true, events: [] };
  const record = {
    ...target,
    ...enabled,
    deviceId: "device1",
    administratorId: 5,
    installationId: 3,
    repositoryId: 7,
    revision: 2,
  };
  const declare = (d: typeof enabled, revision: number) =>
    writeFileSync(
      file,
      JSON.stringify({ ...target, expectedRevision: revision, declaration: d }),
    );
  return {
    dir,
    config,
    file,
    token,
    target,
    enabled,
    disabled,
    record,
    declare,
  };
}
test("read compares local intent against remote effective state and never sends a declaration", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "device-secret");
  let binding: unknown = null;
  const read: typeof fetch = async (url, req) => {
    assert.equal(
      String(url),
      "https://channel.example/connector/v2/bindings/read",
    );
    assert.deepEqual(JSON.parse(String(req?.body)), f.target);
    assert.equal(
      new Headers(req?.headers).get("authorization"),
      "Bearer device-secret",
    );
    assert.equal(req?.redirect, "error");
    return Response.json({ binding });
  };
  f.declare(f.enabled, 0);
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "local_pending",
  );
  binding = f.record;
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "active",
  );
  f.declare(f.disabled, 2);
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "disable_pending",
  );
  binding = { ...f.record, ...f.disabled, revision: 3 };
  assert.equal(
    (await repoCommand("status", f.file, f.config, read)).state,
    "disabled",
  );
});
test("disable submits exactly its declared revision; conflicts, transport and malformed receipts never acknowledge it", async (t) => {
  const f = fixture(t);
  writeFileSync(f.token, "secret");
  f.declare(f.disabled, 2);
  for (const response of [
    () => Response.json({ error: "binding_conflict" }, { status: 409 }),
    () => {
      throw Error("secret");
    },
    () => Response.json({ binding: null }),
    () => Response.json({ error: "leaked-token" }, { status: 401 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      repoCommand("apply", f.file, f.config, async (url, req) => {
        calls++;
        assert.equal(
          String(url),
          "https://channel.example/connector/v2/bindings/apply",
        );
        assert.deepEqual(JSON.parse(String(req?.body)), {
          ...f.target,
          expectedRevision: 2,
          declaration: f.disabled,
        });
        return response();
      }),
      (error: Error) =>
        error.message.startsWith("disable_pending (unconfirmed)") &&
        !/secret|leaked-token/.test(error.message),
    );
    assert.equal(calls, 1);
  }
  rmSync(f.file);
  let requests = 0;
  await assert.rejects(
    repoCommand("apply", f.file, f.config, async () => {
      requests++;
      return Response.json({});
    }),
    /no request sent/,
  );
  assert.equal(requests, 0);
});
test("invitation is written privately, pairing persists the device credential before submission and never returns secrets", async (t) => {
  const f = fixture(t);
  const invite = join(f.dir, "invite");
  const issued = await adminCommand(
    ["invite", "https://channel.example", "5", invite],
    "admin-secret",
    async (url, req) => {
      assert.equal(
        new Headers(req?.headers).get("authorization"),
        "Bearer admin-secret",
      );
      assert.equal(String(url), "https://channel.example/admin/device-invites");
      assert.deepEqual(JSON.parse(String(req?.body)), { githubUserId: 5 });
      return Response.json({ invite: "secret-invitation", expiresAt: 100 });
    },
  );
  assert.doesNotMatch(JSON.stringify(issued), /secret-invitation|admin-secret/);
  assert.equal(readFileSync(invite, "utf8"), "secret-invitation");
  assert.equal(existsSync(f.token), false);
  const paired = await pairCommand(
    invite,
    f.config,
    "github-secret",
    async (url, req) => {
      assert.equal(
        String(url),
        "https://channel.example/connector/v2/devices/pair",
      );
      assert.equal(
        new Headers(req?.headers).get("authorization"),
        "Bearer github-secret",
      );
      const data = JSON.parse(String(req?.body));
      assert.equal(data.invite, "secret-invitation");
      assert.equal(readFileSync(f.token, "utf8"), data.deviceToken);
      assert.match(data.deviceToken, /^[A-Za-z0-9_-]{43}$/);
      return Response.json({
        deviceId: "dev1",
        githubUserId: 5,
        unexpectedSecret: "never-print",
      });
    },
  );
  assert.deepEqual(paired, { deviceId: "dev1", githubUserId: 5 });
});
