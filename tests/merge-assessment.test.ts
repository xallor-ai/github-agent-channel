import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type MergeFacts,
  assessMerge,
  mergeFactsSchema,
  renderMergeAssessment,
} from "../src/merge-assessment.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const candidate = "c".repeat(40);
function facts(): MergeFacts {
  const repository = "example/project";
  return {
    repository,
    number: 3,
    base: { repository, sha: base, id: 17 },
    head: { repository, sha: head, id: 17 },
    observedAt: "2026-11-27T00:00:00.000Z",
    stable: true,
    state: "open",
    draft: false,
    conflict: "none",
    testMergeSha: null,
    testMergeChecksKnown: true,
    headChecksKnown: true,
    baseRefName: "main",
    observedRevision: { baseSha: base, headSha: head, baseRefName: "main" },
    rules: {
      known: true,
      checks: [],
      reviewRequired: false,
      queueRequired: false,
    },
    checks: [],
    review: "unknown",
    otherGates: "clear",
    queue: { entry: "unknown", candidateSha: null, candidateStatus: "unknown" },
    missing: [],
  };
}
test("verified absence of requirements permits platform readiness but does not establish engineering acceptance", () => {
  const f = facts();
  assert.equal(assessMerge(f).platform, "ready");
  assert.equal(assessMerge(f).recommendation, "insufficient");
  const text = renderMergeAssessment(f);
  for (const s of [
    head,
    base,
    f.observedAt,
    "证据不足",
    "https://github.com/example/project/pull/3",
  ])
    assert.ok(text.includes(s));
  f.rules.known = false;
  assert.equal(assessMerge(f).platform, "unknown");
  f.rules.known = true;
  f.missing.push("rules: HTTP 403");
  assert.equal(assessMerge(f).platform, "unknown");
});
test("closed and merged are distinct terminal observations; mixed snapshots cannot give current gates", () => {
  for (const state of ["merged", "closed"] as const) {
    const f = { ...facts(), state };
    assert.equal(assessMerge(f).platform, "not_applicable");
    assert.equal(assessMerge({ ...f, stable: false }).state, state);
    assert.equal(
      assessMerge({ ...f, stable: false }).platform,
      "not_applicable",
    );
    assert.match(
      renderMergeAssessment(f),
      state === "merged" ? /已合并/ : /已关闭未合并/,
    );
  }
  assert.equal(assessMerge({ ...facts(), stable: false }).platform, "unknown");
  assert.equal(assessMerge({ ...facts(), state: "unknown" }).state, "unknown");
});
test("draft, conflict, failing required checks and required reviews remain visible together", () => {
  const f = facts();
  f.draft = true;
  f.conflict = "conflicting";
  f.rules = {
    ...f.rules,
    checks: [{ name: "lint", appId: 5 }],
    reviewRequired: true,
  };
  f.review = "required";
  f.checks.push({
    name: "lint",
    appId: 5,
    status: "failed",
    scope: "head",
    required: true,
    sha: head,
    url: "https://github.com/example/project/actions/runs/3",
  });
  const text = renderMergeAssessment(f);
  for (const s of ["草稿", "冲突", "lint", "失败", "审核", "actions/runs/3"])
    assert.ok(text.includes(s), s);
  assert.equal(assessMerge(f).platform, "blocked");
  assert.equal(assessMerge(f).recommendation, "against");
});
test("required check uses current source and revision; queue result cannot substitute and pending is distinct from failure", () => {
  const f = facts();
  f.rules.checks = [{ name: "ci", appId: 1 }];
  const check = {
    name: "ci",
    appId: 1,
    scope: "head",
    required: true,
    sha: head,
    status: "passed",
    url: null,
  } as const;
  f.checks = [
    { ...check, sha: base },
    { ...check, appId: 2 },
    { ...check, scope: "queue" },
  ];
  assert.equal(assessMerge(f).platform, "blocked");
  assert.match(renderMergeAssessment(f), /未上报/);
  f.checks.push({ ...check, status: "pending" });
  assert.match(renderMergeAssessment(f), /等待/);
  f.checks[f.checks.length - 1] = { ...check };
  assert.equal(assessMerge(f).platform, "ready");
  f.testMergeSha = candidate;
  f.testMergeChecksKnown = true;
  f.checks.push({ ...check, scope: "test_merge", sha: candidate, appId: 2 });
  assert.equal(assessMerge(f).platform, "blocked");
  f.checks.push({
    ...check,
    scope: "test_merge",
    sha: candidate,
    status: "failed",
  });
  assert.equal(assessMerge(f).platform, "blocked");
});
test("an app-pinned check with an unidentifiable publisher is neither absent nor verified", () => {
  const f = facts();
  f.rules.checks = [{ name: "ci", appId: 7 }];
  const unidentified = {
    name: "ci",
    appId: null,
    scope: "head",
    required: true,
    sha: head,
    status: "passed",
    url: null,
  } as const;
  for (const checks of [
    [unidentified],
    [unidentified, { ...unidentified, appId: 8 }],
    [
      { ...unidentified, status: "failed" as const },
      { ...unidentified, appId: 7 },
    ],
  ]) {
    f.checks = checks;
    assert.equal(assessMerge(f).platform, "unknown");
    assert.match(renderMergeAssessment(f), /来源无法确认/);
    assert.doesNotMatch(renderMergeAssessment(f), /未上报|PR head 通过/);
  }
  f.checks = [unidentified, { ...unidentified, appId: 7, status: "failed" }];
  assert.equal(assessMerge(f).platform, "blocked");
  assert.match(renderMergeAssessment(f), /PR head 失败/);
  f.checks = [
    { ...unidentified, sha: base },
    { ...unidentified, appId: 7 },
  ];
  assert.equal(assessMerge(f).platform, "ready");
  f.checks = [unidentified];
  f.rules.checks = [{ name: "ci", appId: null }];
  assert.equal(assessMerge(f).platform, "ready");
});
test("a nonmandatory request for changes affects engineering advice independently", () => {
  const result = assessMerge({ ...facts(), review: "changes_requested" });
  assert.equal(result.platform, "ready");
  assert.equal(result.recommendation, "against");
});
test("failed test-merge collection never falls back to a head result", () => {
  const f = facts();
  f.rules.checks = [{ name: "ci", appId: 1 }];
  f.checks = [
    {
      name: "ci",
      appId: 1,
      scope: "head",
      required: true,
      sha: head,
      status: "failed",
      url: null,
    },
  ];
  f.testMergeSha = candidate;
  f.testMergeChecksKnown = false;
  assert.equal(assessMerge(f).platform, "unknown");
  assert.match(renderMergeAssessment(f), /测试合并提交的检查取证不完整/);
  f.testMergeChecksKnown = true;
  assert.equal(assessMerge(f).platform, "blocked");
  assert.match(renderMergeAssessment(f), /PR head 失败/);
  f.checks[0].status = "passed";
  assert.equal(assessMerge(f).platform, "ready");
  f.testMergeChecksKnown = false;
  assert.equal(assessMerge(f).platform, "unknown");
  f.checks.push({ ...f.checks[0], scope: "test_merge", sha: candidate });
  assert.equal(assessMerge(f).platform, "unknown");
  f.checks[1].status = "failed";
  assert.equal(assessMerge(f).platform, "blocked");
});
test("no required check observation under insufficient visibility is unknown rather than unreported", () => {
  const f = facts();
  f.rules.checks = [{ name: "ci", appId: 1 }];
  f.headChecksKnown = false;
  assert.equal(assessMerge(f).platform, "unknown");
  assert.doesNotMatch(renderMergeAssessment(f), /未上报/);
});
test("a missing candidate SHA permits head fallback only after the absence was observed", () => {
  const f = facts();
  f.rules.checks = [{ name: "ci", appId: 1 }];
  f.checks = [
    {
      name: "ci",
      appId: 1,
      required: true,
      scope: "head",
      sha: head,
      status: "failed",
      url: null,
    },
  ];
  f.testMergeChecksKnown = false;
  assert.equal(assessMerge(f).platform, "unknown");
  assert.doesNotMatch(renderMergeAssessment(f), /PR head 失败|尚未上报/);
  f.testMergeChecksKnown = true;
  assert.equal(assessMerge(f).platform, "blocked");
  assert.match(renderMergeAssessment(f), /PR head 失败/);
  f.testMergeChecksKnown = false;
  f.headChecksKnown = false;
  f.rules.checks = [];
  assert.equal(assessMerge(f).platform, "ready");
  assert.deepEqual(assessMerge(f).missing, []);
});
test("review decision cannot be inferred from historic approvals; queue entry and candidate are distinct", () => {
  const f = facts();
  f.rules.reviewRequired = true;
  assert.equal(assessMerge(f).platform, "unknown");
  f.review = "required";
  assert.equal(assessMerge(f).platform, "blocked");
  f.review = "approved";
  f.rules.queueRequired = true;
  f.queue.entry = "queued";
  assert.equal(assessMerge(f).platform, "queue");
  assert.match(renderMergeAssessment(f), /已入队.*候选.*未知/s);
  f.queue.candidateSha = candidate;
  f.queue.candidateStatus = "passed";
  assert.equal(assessMerge(f).platform, "queue");
});
test("strict evidence rejects malformed, over-budget or hostile public links", () => {
  const f = facts();
  assert.ok(mergeFactsSchema.safeParse(f).success);
  for (const value of [
    { ...f, junk: true },
    { ...f, missing: Array(33).fill("missing") },
    { ...f, base: { ...f.base, sha: "latest" } },
  ])
    assert.ok(!mergeFactsSchema.safeParse(value).success);
  for (const url of [
    "javascript:alert(1)",
    "https://user:password@example.test/path",
    "https://example.test/?token=value",
  ]) {
    assert.ok(
      !mergeFactsSchema.safeParse({
        ...f,
        checks: [
          {
            name: "ci",
            appId: null,
            scope: "head",
            required: true,
            sha: head,
            status: "passed",
            url,
          },
        ],
      }).success,
    );
  }
});

test("only contexts confirmed required for this PR contribute positive or negative evidence", () => {
  const f = facts();
  f.rules.checks = [{ name: "ci", appId: 1 }];
  const ci = {
    name: "ci",
    appId: 1,
    scope: "head",
    sha: head,
    status: "failed",
    url: null,
  } as const;
  f.checks = [{ ...ci, required: null }];
  assert.equal(assessMerge(f).platform, "unknown");
  assert.doesNotMatch(renderMergeAssessment(f), /未上报|PR head 失败/);
  f.checks.push({ ...ci, required: true, status: "passed" });
  assert.equal(assessMerge(f).platform, "unknown");
  f.checks[0].required = false;
  assert.equal(assessMerge(f).platform, "ready");
  f.checks.pop();
  f.missing = ["Cannot read review decision"];
  assert.equal(assessMerge(f).platform, "blocked");
  assert.match(renderMergeAssessment(f), /未上报/);
});

test("lifecycle uncertainty preserves observed conflicts without a definitive current gate decision", () => {
  const f = facts();
  f.conflict = "conflicting";
  f.state = "unknown";
  assert.equal(assessMerge(f).platform, "unknown");
  assert.match(renderMergeAssessment(f), /代码有合并冲突/);
});

test("terminal readback identifies the observed head and branch separately from the assignment", () => {
  const f = facts();
  f.state = "merged";
  f.stable = false;
  f.observedRevision = {
    baseSha: base,
    headSha: candidate,
    baseRefName: "fix/`status`",
  };
  const result = renderMergeAssessment(f);
  assert.match(result, new RegExp("任务版本：[^\\n]+" + head));
  assert.match(
    result,
    new RegExp(
      "实际观察版本：[^\\n]+" + candidate + "[^\\n]+`` fix/`status` ``",
    ),
  );
  assert.match(result, /终态对应实际观察版本/);
  assert.equal(
    mergeFactsSchema.safeParse({ ...f, baseRefName: "evil\n# heading" })
      .success,
    false,
  );
});
