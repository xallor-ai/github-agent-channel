import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { BindingPrincipalVerifier } from "../src/binding-principal.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const selection = { owner: "org", repo: "project" };
const repo = { id: 12, name: "project", owner: { login: "org" } };
const user = { id: 34, login: "new-login" };
const install = "/repos/org/project/installation",
  mint = "/app/installations/56/access_tokens",
  who = "/user/34",
  admin = "/repos/org/project/collaborators/new-login/permission",
  repository = "/repos/org/project";
const token = {
  token: "ghs_test",
  repository_selection: "selected",
  repositories: [repo],
  permissions: { metadata: "read" },
};
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    [install]: { id: 56, suspended_at: null },
    [mint]: token,
    [who]: user,
    [admin]: { permission: "admin", user },
    [repository]: repo,
    ...overrides,
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const auth = new Headers(init?.headers).get("authorization");
    if ([install, mint].includes(path))
      assert.match(auth ?? "", /^bearer [^.]+\.[^.]+\.[^.]+$/i);
    else assert.match(auth ?? "", /^(token|bearer) ghs_test$/i);
    if (path === mint) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        repositories: ["project"],
        permissions: { metadata: "read" },
      });
    }
    assert.ok(Object.hasOwn(responses, path), path);
    const response = responses[path];
    return response instanceof Response ? response : Response.json(response);
  };
  const verifier = new BindingPrincipalVerifier(
    "123",
    privateKey,
    async (credential) =>
      credential === "paired"
        ? { deviceId: "laptop", githubUserId: 34 }
        : undefined,
    fetchImpl,
  );
  return {
    calls,
    verify: (credential = "paired", input: unknown = selection) =>
      verifier.verify(credential, input),
  };
}
test("binding principal uses App installation and metadata-only repo token, resolves a paired user by immutable id", async () => {
  const { verify, calls } = fixture();
  assert.deepEqual((await verify()).who, {
    deviceId: "laptop",
    administratorId: 34,
    owner: repo.owner.login,
    repo: repo.name,
    installationId: 56,
    repositoryId: 12,
  });
  assert.deepEqual(calls, [install, mint, who, admin, repository]);
});
test("rejects unauthenticated devices and client scope or identity claims before GitHub", async () => {
  const { verify, calls } = fixture();
  await assert.rejects(verify("unpaired"));
  for (const field of [
    "deviceId",
    "githubUserId",
    "administratorId",
    "installationId",
    "repositoryId",
    "login",
  ]) {
    await assert.rejects(verify("paired", { ...selection, [field]: 34 }));
  }
  await assert.rejects(verify("paired", { ...selection, repo: ".." }));
  assert.deepEqual(calls, []);
});
test("rejects suspended or unavailable installations, wrong token scope, changed identities, and insufficient privileges", async () => {
  for (const [path, response] of [
    [install, { id: 56, suspended_at: "today" }],
    [install, new Response("{}", { status: 404 })],
    [mint, { ...token, repositories: [] }],
    [mint, { ...token, repositories: [repo, repo] }],
    [mint, { ...token, permissions: { contents: "write", metadata: "read" } }],
    [mint, { ...token, repositories: [{ ...repo, name: "other" }] }],
    [who, { ...user, id: 70 }],
    [admin, { permission: "write", user }],
    [admin, { permission: "maintain", user }],
    [admin, { permission: "admin", user: { ...user, id: 90 } }],
    [admin, new Response("{}", { status: 503 })],
    [repository, { ...repo, id: 91 }],
  ] as const) {
    await assert.rejects(fixture({ [path]: response }).verify());
  }
});
