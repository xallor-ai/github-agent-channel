import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
const revision = z.strictObject({
  repository,
  sha,
  id: z.number().int().positive().safe(),
});
const label = (n: number) =>
  z
    .string()
    .min(1)
    .max(n)
    .regex(/^[^\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/u);
const source = z.number().int().positive().safe().nullable();
const context = label(128);
const status = z.enum(["passed", "failed", "pending", "unknown"]);
const publicLink = z
  .string()
  .max(2048)
  .refine((s) => {
    if (!/^https:\/\//.test(s) || /[\s<>"\\?#]/u.test(s)) return false;
    try {
      const url = new URL(s);
      return !url.username && !url.password && url.href === s;
    } catch {
      return false;
    }
  });

export const mergeFactsSchema = z.strictObject({
  repository,
  number: z.number().int().positive().safe(),
  observedAt: z.iso.datetime({ offset: true }),
  base: revision,
  head: revision,
  state: z.enum(["open", "closed", "merged", "unknown"]),
  stable: z.boolean(),
  draft: z.boolean().nullable(),
  conflict: z.enum(["none", "conflicting", "unknown"]),
  testMergeSha: sha.nullable(),
  rules: z.strictObject({
    known: z.boolean(),
    checks: z.array(z.strictObject({ name: context, appId: source })).max(100),
    reviewRequired: z.boolean().nullable(),
    queueRequired: z.boolean().nullable(),
  }),
  checks: z
    .array(
      z.strictObject({
        name: context,
        appId: source,
        scope: z.enum(["head", "test_merge", "queue"]),
        sha,
        status,
        url: publicLink.nullable(),
      }),
    )
    .max(200),
  review: z.enum(["approved", "required", "changes_requested", "unknown"]),
  otherGates: z.enum(["clear", "blocked", "unknown"]),
  queue: z.strictObject({
    entry: z.enum(["eligible", "queued", "blocked", "unknown"]),
    candidateSha: sha.nullable(),
    candidateStatus: status,
  }),
  missing: z.array(label(200)).max(32),
});
export type MergeFacts = z.infer<typeof mergeFactsSchema>;

interface MergeAssessment {
  state: MergeFacts["state"];
  platform: "ready" | "blocked" | "queue" | "unknown" | "not_applicable";
  recommendation: "against" | "insufficient" | "not_applicable";
  details: string[];
  missing: string[];
}

// Keep untrusted labels inert inside a Markdown code span, even if they contain backticks.
function literal(s: string) {
  const fence = "`".repeat(
    1 + Math.max(0, ...Array.from(s.matchAll(/`+/g), (m) => m[0].length)),
  );
  return fence + " " + s + " " + fence;
}
const statusText = {
  passed: "通过",
  failed: "失败",
  pending: "等待完成",
  unknown: "未知",
} as const;
export function assessMerge(f: MergeFacts): MergeAssessment {
  const a: MergeAssessment = {
    state: f.state,
    platform: "unknown",
    recommendation: "insufficient",
    details: [],
    missing: f.missing.map(literal),
  };
  if (f.state === "closed" || f.state === "merged") {
    a.platform = "not_applicable";
    a.recommendation = "not_applicable";
    return a;
  }
  if (!f.stable) {
    a.missing.push("未取得稳定的 base/head 快照；请重新查询当前版本");
    return a;
  }
  if (f.state === "unknown") a.missing.push("未确认 PR 开放或关闭及合并状态");
  let blocked = false;
  const block = (reason: string) => {
    blocked = true;
    a.details.push(reason);
  };
  if (f.conflict === "conflicting") block("代码有合并冲突，需解决冲突");
  else if (f.conflict === "unknown")
    a.missing.push("GitHub 尚未确认代码冲突状态");
  else a.details.push("代码无已知合并冲突");
  if (f.draft === true) block("PR 仍是草稿，需标记为 ready");
  if (f.draft === null) a.missing.push("草稿状态未知");
  if (!f.rules.known) a.missing.push("未完整确认适用于目标分支的规则");
  if (f.rules.known && !f.rules.checks.length)
    a.details.push("没有必需状态检查");
  // When the current test merge commit reports checks, GitHub evaluates that
  // commit. Never assemble a passing set from two different subjects.
  const test = f.checks.filter(
    (c) => c.scope === "test_merge" && c.sha === f.testMergeSha,
  );
  const checks = test.length
    ? test
    : f.checks.filter((c) => c.scope === "head" && c.sha === f.head.sha);
  for (const rule of f.rules.checks) {
    const matches = checks.filter(
      (c) =>
        c.name === rule.name && (rule.appId === null || c.appId === rule.appId),
    );
    const expected =
      "必需检查 " +
      literal(rule.name) +
      (rule.appId === null ? "（任意来源）" : "（App " + rule.appId + "）");
    if (!matches.length) {
      if (f.missing.length) a.missing.push(expected + "：当前结果不可确认");
      else block(expected + "：当前版本及来源尚未上报，等待检查");
      continue;
    }
    const subject = test.length ? "测试合并 " + f.testMergeSha : "PR head";
    const observed = (s: (typeof matches)[number]) =>
      (s.appId === null ? "" : ", App " + s.appId) +
      (s.url ? " <" + s.url + ">" : "");
    if (matches.some((c) => c.status === "failed")) {
      block(
        expected +
          "：" +
          subject +
          " 失败" +
          observed(matches.find((c) => c.status === "failed")!),
      );
    } else if (matches.some((c) => c.status === "pending")) {
      block(
        expected +
          "：" +
          subject +
          " 等待完成" +
          observed(matches.find((c) => c.status === "pending")!),
      );
    } else if (matches.some((c) => c.status === "unknown")) {
      a.missing.push(expected + "：" + subject + " 状态未知");
    } else
      a.details.push(
        expected + "：" + subject + " 通过" + observed(matches[0]),
      );
  }
  if (f.review === "changes_requested") {
    if (f.rules.reviewRequired) block("当前必需审核要求修改");
    else a.details.push("当前审核要求修改，需要维护者处理");
  }
  if (f.rules.reviewRequired === false && f.review === "required")
    a.missing.push("平台审核决定与已读规则不一致，需重新核对审核要求");
  if (f.rules.reviewRequired && f.review === "required")
    block("当前规则所需的有效审核尚不足，需在本版补齐审核");
  if (f.rules.reviewRequired && f.review === "approved")
    a.details.push("当前规则所需审核已满足");
  if (f.rules.reviewRequired && f.review === "unknown")
    a.missing.push("当前版本的有效审核决定未知");
  if (f.rules.reviewRequired === null) a.missing.push("是否需要审核未知");
  if (f.otherGates === "unknown") a.missing.push("其他平台门禁未确认");
  if (f.otherGates === "blocked") block("GitHub 报告其他合并门禁未满足");
  if (f.rules.queueRequired === null) a.missing.push("是否必须经合并队列未知");
  if (f.rules.queueRequired) {
    const entry = {
      eligible: "可入队",
      queued: "已入队",
      blocked: "当前不能入队",
      unknown: "入队资格未知",
    }[f.queue.entry];
    const candidate = f.queue.candidateSha
      ? f.queue.candidateSha + "：" + statusText[f.queue.candidateStatus]
      : "未知";
    a.details.push("必须经合并队列：" + entry + "；队列候选验证：" + candidate);
    if (
      f.queue.entry === "blocked" ||
      (f.queue.candidateSha && f.queue.candidateStatus === "failed")
    )
      blocked = true;
  }
  a.platform = blocked
    ? "blocked"
    : f.state !== "open"
      ? "unknown"
      : f.rules.queueRequired
        ? "queue"
        : a.missing.length
          ? "unknown"
          : "ready";
  if (blocked || a.platform === "queue" || f.review === "changes_requested")
    a.recommendation = "against";
  return a;
}

const lifecycle = {
  open: "仍开放未合并",
  closed: "已关闭未合并",
  merged: "已合并",
  unknown: "无法确认",
};
const platform = {
  ready: "本版已确认的平台条件满足",
  blocked: "当前被门禁阻挡",
  queue: "必须经过合并队列，不能立即合入",
  unknown: "证据不足，无法确认当前能否合入",
  not_applicable: "不适用",
};
const advice = {
  against: "不建议现在合并；请复核下列门禁并在状态变化后重新查询。",
  insufficient: "证据不足；未确认本版的工程评审范围、阻断项处理和维护者验收。",
  not_applicable: "不适用",
};
export function renderMergeAssessment(f: MergeFacts): string {
  const a = assessMerge(f);
  const lines = [
    "PR：https://github.com/" +
      f.repository +
      "/pull/" +
      f.number +
      " · 查询时间：" +
      f.observedAt,
    "base：" +
      f.base.repository +
      " @ " +
      f.base.sha +
      "；head：" +
      f.head.repository +
      " @ " +
      f.head.sha,
    "1. 是否已合并：" + lifecycle[a.state] + "。",
    "2. 当前能否合入：" + platform[a.platform] + "。",
    "3. 工程建议：" + advice[a.recommendation],
  ];
  // Keep the three decisions, revision and time regardless of the evidence budget.
  const notes = [...a.missing.map((m) => "缺项：" + m), ...a.details];
  let chars = lines.join("\n").length;
  for (const [i, note] of notes.entries()) {
    if (chars + note.length > 17_800) {
      lines.push(
        "其余 " +
          (notes.length - i) +
          " 条依据超出回帖长度，见 PR 检查与分支规则。",
      );
      break;
    }
    lines.push("- " + note);
    chars += note.length + 3;
  }
  return lines.join("\n");
}
