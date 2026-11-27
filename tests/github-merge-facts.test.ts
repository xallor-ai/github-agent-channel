import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubClient } from "../src/github.js";
import {
  AccessDenied,
  type Task,
  type ChannelConfig,
} from "../src/contracts.js";
import { assessMerge } from "../src/merge-assessment.js";

const base = "1".repeat(40),
  head = "2".repeat(40),
  candidate = "3".repeat(40);
const ident = { databaseId: 8, nameWithOwner: "org/example" };
const pin = {
  number: 7,
  baseRefName: "main",
  baseRefOid: base,
  headRefOid: head,
  baseRepository: ident,
  headRepository: ident,
};
const task = {
  id: "task",
  status: "succeeded",
  installationId: 9,
  repositoryId: 8,
  bindingId: "b",
  owner: "org",
  repo: "example",
  actorId: 6,
  actorLogin: "author",
  target: {
    kind: "pull_request",
    number: 7,
    revision: { baseSha: base, headSha: head, baseRepoId: 8, headRepoId: 8 },
  },
} as Task;
const life = {
  ...pin,
  state: "OPEN",
  merged: false,
  isDraft: false,
  mergeable: "MERGEABLE",
};
const gates = {
  ...pin,
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  mergeQueue: null,
  mergeQueueEntry: null,
  potentialMergeCommit: { oid: candidate },
};
const classic = {
  requiresStatusChecks: true,
  requiresStrictStatusChecks: false,
  requiredStatusChecks: [{ context: "build", app: { databaseId: 9 } }],
  requiresApprovingReviews: true,
  requiredApprovingReviewCount: 1,
  requiresCodeOwnerReviews: false,
  requireLastPushApproval: false,
  requiresDeployments: false,
  requiresConversationResolution: false,
  requiresCommitSignatures: false,
  requiresLinearHistory: false,
  restrictsPushes: false,
  lockBranch: false,
};
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const run = (
  oid: string,
  status = "COMPLETED",
  conclusion: string | null = "SUCCESS",
) => ({
  __typename: "CheckRun",
  isRequired: true,
  name: "build",
  status,
  conclusion,
  permalink: "https://github.com/org/example/runs/7",
  checkSuite: { app: { databaseId: 9 }, commit: { oid } },
});
const check = (oid: string, state: string, context = "test") => ({
  __typename: "StatusContext",
  isRequired: context === "test",
  state,
  context,
  commit: { oid },
});
type Scenario = {
  lifecycle?: (count: number) => unknown;
  detail?: (count: number) => unknown;
  classic?: unknown;
  rules?: unknown[];
  runs?: (oid: string) => unknown[];
  truncated?: boolean;
  failRead?: string;
  denyGates?: boolean;
  emptyRollup?: string;
  deny?: string;
  revoke?: boolean;
  disable?: boolean;
};
function setup(s: Scenario = {}) {
  let lifeCount = 0,
    details = 0,
    actorReads = 0,
    managerReads = 0;
  const requests: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      u = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { "content-type": "application/json" },
      });
    requests.push(u);
    if (u === "/app/installations/9/access_tokens") {
      assert.deepEqual(body.repository_ids, [8]);
      assert.ok(
        Object.values(body.permissions).every((value) => value === "read"),
      );
      if (s.deny && s.deny in body.permissions) return json({}, 403);
      return json({
        token: "ghs_fake",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
      });
    }
    if (u === "/repos/org/example")
      return json({ id: 8, name: "example", owner: { login: "org" } });
    if (u.endsWith("/permission")) {
      actorReads++;
      return json({
        permission: s.revoke && actorReads > 1 ? "read" : "write",
        user: { id: 6, login: "author" },
      });
    }
    if (u === "/repos/org/example/rules/branches/main") {
      assert.equal(url.searchParams.get("per_page"), "100");
      return json(
        s.rules ?? [
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: false,
              required_status_checks: [{ context: "test" }],
            },
          },
        ],
      );
    }
    assert.equal(u, "/graphql");
    const query = String(body.query),
      vars = body.variables;
    assert.equal(vars.owner, "org");
    assert.equal(vars.repo, "example");
    assert.match(query, /^query /);
    assert.doesNotMatch(query, /\b(title|body|description|mutation)\b/);
    let fields: object;
    if (query.includes("query MergeLifecycle")) {
      assert.equal(vars.number, 7);
      fields = { pullRequest: s.lifecycle?.(++lifeCount) ?? life };
    } else if (query.includes("query MergeGates")) {
      if (s.denyGates) return json({}, 403);
      assert.equal(vars.number, 7);
      fields = { pullRequest: s.detail?.(++details) ?? gates };
    } else if (query.includes("query MergeClassic")) {
      assert.equal(vars.ref, "refs/heads/main");
      fields = {
        ref: {
          name: "main",
          target: { oid: base },
          branchProtectionRule: "classic" in s ? s.classic : classic,
        },
      };
    } else {
      assert.match(query, /query MergeChecks/);
      assert.ok([candidate, head].includes(vars.oid));
      assert.equal(vars.number, 7);
      assert.equal(
        query.split("isRequired(pullRequestNumber:$number)").length - 1,
        2,
      );
      if (vars.oid === s.failRead) return json({}, 403);
      fields = {
        object: {
          oid: vars.oid,
          statusCheckRollup:
            vars.oid === s.emptyRollup
              ? null
              : {
                  contexts: {
                    nodes: s.runs?.(vars.oid) ?? [
                      run(vars.oid),
                      check(
                        vars.oid,
                        vars.oid === head ? "SUCCESS" : "FAILURE",
                      ),
                    ],
                    pageInfo: { hasNextPage: s.truncated ?? false },
                  },
                },
        },
      };
    }
    return json({ data: { repository: { ...ident, ...fields } } });
  };
  const client = new OctokitGitHubClient(
    { github: { appId: "345" } } as ChannelConfig,
    key,
    () => ({
      id: "b",
      owner: "org",
      repo: "example",
      installationId: 9,
      repositoryId: 8,
      events: [],
      enabled: !(s.disable && managerReads >= 2),
    }),
    async () => {
      managerReads++;
    },
    f,
    () => false,
  );
  return {
    read: (t = task) => client.readMergeFacts(t),
    requests,
    actorReads: () => actorReads,
  };
}

test("scoped queries combine classic and ruleset requirements; checks retain app and subject and test merge failure overrides green head", async () => {
  const fixture = setup(),
    f = await fixture.read();
  assert.equal(f.rules.known, true);
  assert.deepEqual(f.rules.checks, [
    { name: "build", appId: 9 },
    { name: "test", appId: null },
  ]);
  assert.equal(f.rules.reviewRequired, true);
  assert.equal(f.review, "approved");
  assert.equal(f.stable, true);
  assert.equal(f.state, "open");
  assert.equal(fixture.actorReads(), 2);
  assert.equal(f.checks.length, 4);
  assert.equal(assessMerge(f).platform, "blocked");
  assert.ok(
    f.checks.some(
      (x) =>
        x.scope === "test_merge" &&
        x.sha === candidate &&
        x.name === "test" &&
        x.status === "failed",
    ),
  );
  assert.ok(
    f.checks.some(
      (x) =>
        x.scope === "head" &&
        x.sha === head &&
        x.appId === 9 &&
        x.url?.endsWith("/runs/7"),
    ),
  );
});
test("unrelated test-merge check does not let an all-green head satisfy current candidate requirements", async () => {
  const f = await setup({
    runs: (oid) =>
      oid === head
        ? [run(oid), check(oid, "SUCCESS")]
        : [check(oid, "SUCCESS", "other")],
  }).read();
  assert.equal(assessMerge(f).platform, "blocked");
});
test("missing administrative permission retains known ruleset requirements and lifecycle, never implies absence", async () => {
  const f = await setup({
    deny: "administration",
    rules: [{ type: "merge_queue" }],
  }).read();
  assert.equal(f.stable, true);
  assert.equal(f.conflict, "none");
  assert.equal(f.rules.known, false);
  assert.equal(f.rules.queueRequired, true);
  assert.equal(f.rules.reviewRequired, null);
  assert.match(f.missing.join(" "), /administration:read/);
});
test("truncated check coverage, unavailable status scope, and unsupported branch rules cannot generate ready", async () => {
  for (const s of [
    { truncated: true },
    { deny: "statuses" },
    { rules: [{ type: "required_deployments" }] },
  ]) {
    const f = await setup({
      ...s,
      runs: (oid) => [run(oid), check(oid, "SUCCESS")],
    }).read();
    assert.equal(assessMerge(f).platform, "unknown");
    assert.ok(f.missing.length);
  }
});
test("verified absence of classic and ruleset gates yields scoped readiness", async () => {
  const f = await setup({ classic: null, rules: [] }).read();
  assert.deepEqual(f.rules, {
    known: true,
    checks: [],
    reviewRequired: false,
    queueRequired: false,
  });
  assert.equal(assessMerge(f).platform, "ready");
});
test("closed and merged are independent observations on a historical task; no rule, check or publication call", async () => {
  for (const [state, merged, expected] of [
    ["CLOSED", false, "closed"],
    ["MERGED", true, "merged"],
    ["CLOSED", true, "unknown"],
  ] as const) {
    const fixture = setup({ lifecycle: () => ({ ...life, state, merged }) }),
      f = await fixture.read();
    assert.equal(f.state, expected);
    assert.equal(fixture.actorReads(), 2);
    assert.equal(fixture.requests.filter((x) => x === "/graphql").length, 2);
    assert.ok(!fixture.requests.some((x) => x.includes("/rules/")));
  }
});
test("new head/base or changed test merge candidate discards observations", async () => {
  for (const s of [
    {
      lifecycle: (n: number) => ({
        ...life,
        headRefOid: n === 2 ? "a".repeat(40) : head,
      }),
    },
    {
      lifecycle: (n: number) => ({
        ...life,
        baseRefOid: n === 2 ? "b".repeat(40) : base,
      }),
    },
    {
      detail: (n: number) => ({
        ...gates,
        potentialMergeCommit: { oid: n === 2 ? "e".repeat(40) : candidate },
      }),
    },
  ]) {
    const f = await setup(s).read();
    assert.equal(f.stable, false);
    assert.deepEqual(f.checks, []);
    assert.equal(f.rules.known, false);
    assert.equal(f.head.sha, head);
    assert.equal(f.base.sha, base);
    assert.equal(f.testMergeSha, null);
  }
});
test("fork, wrong target, changed binding or revoked actor denies evidence", async () => {
  for (const s of [
    { revoke: true },
    { disable: true },
    {
      lifecycle: () => ({
        ...life,
        headRepository: { ...ident, databaseId: 4 },
      }),
    },
    { detail: () => ({ ...gates, number: 666 }) },
  ]) {
    await assert.rejects(setup(s).read(), AccessDenied);
  }
  for (const target of [
    { kind: "issue", number: 7 },
    { kind: "pull_request", number: 7 },
    { kind: "pull_request", number: 7, revision: { headRepoId: 5 } },
  ]) {
    const fixture = setup();
    await assert.rejects(
      fixture.read({ ...task, target } as Task),
      AccessDenied,
    );
    assert.ok(!fixture.requests.includes("/graphql"));
  }
});
test("oversized ruleset payload remains a gap without losing the independently verified lifecycle", async () => {
  const f = await setup({
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "a".repeat(600 * 1024) }],
        },
      },
    ],
  }).read();
  assert.equal(f.rules.known, false);
  assert.equal(f.state, "open");
  assert.match(f.missing.join(" "), /Effective branch rulesets/);
});
test("head and test-merge coverage distinguish unread, partial, wrong-SHA and verified empty rollups", async () => {
  for (const [s, headKnown, testKnown] of [
    [{ failRead: candidate }, true, false],
    [{ failRead: head }, false, true],
    [{ truncated: true }, false, false],
    [{ emptyRollup: candidate }, true, true],
    [
      { runs: (oid: string) => (oid === candidate ? [run(head)] : []) },
      true,
      false,
    ],
    [{ deny: "statuses" }, false, false],
    [{ rules: [], classic: null }, false, false],
  ] as const) {
    const f = await setup(s).read();
    assert.equal(f.headChecksKnown, headKnown);
    assert.equal(f.testMergeChecksKnown, testKnown);
  }
});

test("GraphQL requiredness distinguishes matching check names and does not promote missing data", async () => {
  const f = await setup({
    classic: null,
    runs: (oid) => [
      { ...run(oid), isRequired: false },
      { ...check(oid, "FAILURE"), isRequired: undefined },
    ],
  }).read();
  assert.deepEqual(
    f.checks.map((c) => c.required),
    [false, null, false, null],
  );
  assert.equal(assessMerge(f).platform, "unknown");
});

test("BEHIND blocks only if an applicable strict check policy is proven", async () => {
  const loose = {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: "test" }],
    },
  };
  const strictRule = {
    ...loose,
    parameters: {
      ...loose.parameters,
      strict_required_status_checks_policy: true,
    },
  };
  for (const [s, expected] of [
    [{ classic: null, rules: [loose] }, "unknown"],
    [{ classic: null, rules: [strictRule] }, "blocked"],
    [
      { classic: { ...classic, requiresStrictStatusChecks: true }, rules: [] },
      "blocked",
    ],
    [{ deny: "administration", rules: [] }, "unknown"],
  ] as const) {
    const f = await setup({
      ...s,
      rules: [...s.rules],
      detail: () => ({ ...gates, mergeStateStatus: "BEHIND" }),
      runs: (oid) => [run(oid), check(oid, "SUCCESS")],
    }).read();
    assert.equal(f.otherGates, expected);
    assert.equal(assessMerge(f).platform, expected);
  }
});

test("final observed revision distinguishes a changed destination with unchanged SHAs, and a merged newer head", async () => {
  for (const [label, oid] of [
    ["release", head],
    ["main", "7".repeat(40)],
  ]) {
    const f = await setup({
      lifecycle: (n) =>
        n === 1
          ? life
          : {
              ...life,
              baseRefName: label,
              headRefOid: oid,
              merged: true,
              state: "MERGED",
            },
    }).read();
    assert.equal(f.baseRefName, "main");
    assert.equal(f.stable, false);
    assert.equal(f.state, "merged");
    assert.equal(f.head.sha, head);
    assert.deepEqual(f.observedRevision, {
      baseSha: base,
      headSha: oid,
      baseRefName: label,
    });
    assert.deepEqual(f.checks, []);
    assert.equal(f.headChecksKnown, false);
    assert.equal(f.testMergeChecksKnown, false);
  }
  const stale = await setup({
    lifecycle: () => ({
      ...life,
      state: "MERGED",
      merged: true,
      headRefOid: "9".repeat(40),
    }),
  }).read();
  assert.equal(stale.baseRefName, null);
  assert.equal(stale.observedRevision?.headSha, "9".repeat(40));
});
test("retargeting an open PR mid-read at identical SHAs invalidates its old branch rules", async () => {
  const f = await setup({
    lifecycle: (n) => ({ ...life, baseRefName: n === 1 ? "main" : "release" }),
  }).read();
  assert.equal(f.state, "open");
  assert.equal(f.stable, false);
  assert.equal(f.rules.known, false);
  assert.equal(f.baseRefName, "main");
  assert.deepEqual(f.observedRevision, {
    headSha: head,
    baseSha: base,
    baseRefName: "release",
  });
});

test("verified absence of a test merge commit allows head evidence; denied gate reads do not establish absence", async () => {
  const scenario = { runs: (oid: string) => [run(oid), check(oid, "FAILURE")] };
  const absent = await setup({
    ...scenario,
    detail: () => ({ ...gates, potentialMergeCommit: null }),
  }).read();
  assert.equal(absent.testMergeSha, null);
  assert.equal(absent.testMergeChecksKnown, true);
  assert.equal(absent.headChecksKnown, true);
  assert.equal(assessMerge(absent).platform, "blocked");
  const denied = await setup({ ...scenario, denyGates: true }).read();
  assert.equal(denied.testMergeSha, null);
  assert.equal(denied.testMergeChecksKnown, false);
  assert.equal(denied.headChecksKnown, true);
  assert.equal(assessMerge(denied).platform, "unknown");
});
