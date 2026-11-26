import type { Octokit } from "@octokit/core";
import { z } from "zod";
import { AccessDenied, type Task } from "./contracts.js";
import { mergeFactsSchema, type MergeFacts } from "./merge-assessment.js";

// Projection and page limits bound the evidence shape. Cap actual (decoded) bytes too:
// ruleset parameters and error bodies are not under the Channel administrator's control.
export function boundedMergeFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const deadline = AbortSignal.timeout(15_000);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline;
    const response = await fetchImpl(input, {
      ...init,
      signal,
      redirect: "error",
    });
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 512 * 1024)
            throw Error("Merge evidence response exceeded byte limit");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const id = z.number().int().positive().safe();
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/u);
const gqlRepo = z.object({ databaseId: id, nameWithOwner: z.string() });
const repoFields = "databaseId nameWithOwner";
const prIdentity = `number baseRefName baseRefOid headRefOid baseRepository { ${repoFields} } headRepository { ${repoFields} }`;
const identity = z.object({
  number: id,
  baseRefName: z.string().min(1).max(255),
  baseRefOid: sha,
  headRefOid: sha,
  baseRepository: gqlRepo,
  headRepository: gqlRepo,
});
const lifecycle = identity.extend({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  merged: z.boolean(),
  isDraft: z.boolean(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
});
const lifecycleFields = prIdentity + " state merged isDraft mergeable";
const gateFields =
  prIdentity +
  " reviewDecision mergeStateStatus mergeQueue { id } mergeQueueEntry { id } potentialMergeCommit { oid }";
const gates = identity.extend({
  reviewDecision: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
    .nullable(),
  mergeStateStatus: z.string(),
  mergeQueue: z.object({ id: z.string() }).nullable(),
  mergeQueueEntry: z.object({ id: z.string() }).nullable(),
  potentialMergeCommit: z.object({ oid: sha }).nullable(),
});
const classicRule = z.object({
  requiresStatusChecks: z.boolean(),
  requiredStatusChecks: z
    .array(
      z.object({ context: name, app: z.object({ databaseId: id }).nullable() }),
    )
    .max(100)
    .nullable(),
  requiresApprovingReviews: z.boolean(),
  requiresCodeOwnerReviews: z.boolean(),
  requireLastPushApproval: z.boolean(),
  requiredApprovingReviewCount: z.number().int().nonnegative().nullable(),
  requiresDeployments: z.boolean(),
  requiresConversationResolution: z.boolean(),
  requiresCommitSignatures: z.boolean(),
  requiresLinearHistory: z.boolean(),
  restrictsPushes: z.boolean(),
  lockBranch: z.boolean(),
});
const classicFields =
  "requiresStatusChecks requiredStatusChecks { context app { databaseId } } requiresApprovingReviews requiresCodeOwnerReviews requireLastPushApproval requiredApprovingReviewCount requiresDeployments requiresConversationResolution requiresCommitSignatures requiresLinearHistory restrictsPushes lockBranch";
const ruleset = z
  .array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
  .max(100);
const rulesetChecks = z.object({
  required_status_checks: z
    .array(z.object({ context: name, integration_id: id.nullish() }))
    .max(100),
});
const reviews = z.object({
  required_approving_review_count: z.number().int().nonnegative(),
  require_code_owner_review: z.boolean(),
  require_last_push_approval: z.boolean(),
  required_review_thread_resolution: z.boolean(),
  required_reviewers: z.array(z.unknown()).optional(),
  allowed_merge_methods: z.array(z.string()).optional(),
});
const checkNode = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name,
    status: z.string(),
    conclusion: z.string().nullable(),
    permalink: z.string(),
    checkSuite: z.object({
      commit: z.object({ oid: sha }),
      app: z.object({ databaseId: id }).nullable(),
    }),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    context: name,
    state: z.string(),
    commit: z.object({ oid: sha }),
  }),
]);
const rollup = z.object({
  oid: sha,
  statusCheckRollup: z
    .object({
      contexts: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(checkNode).max(100),
      }),
    })
    .nullable(),
});
const checkQuery = `query MergeChecks($owner:String!,$repo:String!,$oid:GitObjectID!) {
 repository(owner:$owner,name:$repo) { ${repoFields} object(oid:$oid) { ... on Commit {
 oid statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes { __typename
 ... on CheckRun { name status conclusion permalink checkSuite { commit { oid } app { databaseId } } }
 ... on StatusContext { context state commit { oid } } } } } } } } }`;
function checkStatus(
  node: z.infer<typeof checkNode>,
): MergeFacts["checks"][number]["status"] {
  if (node.__typename === "StatusContext") {
    switch (node.state) {
      case "SUCCESS":
        return "passed";
      case "FAILURE":
      case "ERROR":
        return "failed";
      case "EXPECTED":
      case "PENDING":
        return "pending";
      default:
        return "unknown";
    }
  }
  if (node.status !== "COMPLETED")
    return [
      "QUEUED",
      "IN_PROGRESS",
      "PENDING",
      "REQUESTED",
      "WAITING",
    ].includes(node.status)
      ? "pending"
      : "unknown";
  if (["SUCCESS", "SKIPPED", "NEUTRAL"].includes(node.conclusion ?? ""))
    return "passed";
  if (
    [
      "FAILURE",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "STALE",
    ].includes(node.conclusion ?? "")
  )
    return "failed";
  return "unknown";
}

export async function collectMergeFacts(
  client: Octokit,
  task: Task,
  scoped: (purpose: "classic" | "checks") => Promise<Octokit>,
): Promise<MergeFacts> {
  const { target, owner, repo, repositoryId } = task;
  if (
    target.kind !== "pull_request" ||
    !id.safeParse(target.number).success ||
    !target.revision ||
    target.revision.baseRepoId !== repositoryId ||
    target.revision.headRepoId !== repositoryId ||
    ![target.revision.baseSha, target.revision.headSha].every(
      (s) => sha.safeParse(s).success,
    )
  )
    throw new AccessDenied("Pinned same-repository pull request required");
  const {
    number,
    revision: { headSha, baseSha },
  } = target;
  const repository = owner + "/" + repo;
  const blank = (): MergeFacts => ({
    repository,
    number,
    observedAt: new Date().toISOString(),
    base: { repository, id: repositoryId, sha: baseSha },
    head: { repository, id: repositoryId, sha: headSha },
    state: "unknown",
    stable: false,
    draft: null,
    conflict: "unknown",
    testMergeSha: null,
    rules: {
      known: false,
      checks: [],
      queueRequired: null,
      reviewRequired: null,
    },
    checks: [],
    review: "unknown",
    otherGates: "unknown",
    queue: { entry: "unknown", candidateSha: null, candidateStatus: "unknown" },
    missing: [],
  });
  let f = blank();
  function sameRepo(r: z.infer<typeof gqlRepo>) {
    if (r.databaseId !== repositoryId || r.nameWithOwner !== repository)
      throw new AccessDenied("Repository identity changed");
  }
  async function readPR<
    S extends typeof identity | typeof lifecycle | typeof gates,
  >(fields: string, schema: S, operation: string) {
    const raw = await client.graphql<unknown>(
      `query ${operation}($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ ${repoFields} pullRequest(number:$number){ ${fields} } } }`,
      { owner, repo, number },
    );
    const r = z
      .object({ repository: gqlRepo.extend({ pullRequest: z.unknown() }) })
      .parse(raw).repository;
    sameRepo(r);
    const p = schema.parse(r.pullRequest) as z.infer<S>;
    sameRepo(p.baseRepository);
    sameRepo(p.headRepository);
    if (p.number !== number)
      throw new AccessDenied("Pull request identity changed");
    return p;
  }
  const matches = (p: z.infer<typeof identity>) =>
    p.headRefOid === headSha && p.baseRefOid === baseSha;
  const state = (p: z.infer<typeof lifecycle>) =>
    p.merged
      ? p.state === "MERGED"
        ? "merged"
        : "unknown"
      : p.state === "OPEN"
        ? "open"
        : p.state === "CLOSED"
          ? "closed"
          : "unknown";
  const first = await readPR(lifecycleFields, lifecycle, "MergeLifecycle");
  const miss = (s: string) => {
    if (!f.missing.includes(s)) f.missing.push(s);
  };
  async function optional<T>(
    description: string,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof AccessDenied) throw e;
      const code = z.object({ status: z.number() }).safeParse(e);
      miss(
        description +
          (code.success && [401, 403, 404, 422].includes(code.data.status)
            ? " (permission or resource unavailable)"
            : " (unavailable or incomplete)"),
      );
      return undefined;
    }
  }
  let changed = false;
  if (matches(first) && state(first) === "open") {
    const ref = first.baseRefName;
    const details = await optional("PR review/queue/merge gates", () =>
      readPR(gateFields, gates, "MergeGates"),
    );
    if (details && (!matches(details) || details.baseRefName !== ref))
      changed = true;
    if (details && !changed) {
      f.review =
        details.reviewDecision === "APPROVED"
          ? "approved"
          : details.reviewDecision === "CHANGES_REQUESTED"
            ? "changes_requested"
            : details.reviewDecision === "REVIEW_REQUIRED"
              ? "required"
              : "unknown";
      f.testMergeSha = details.potentialMergeCommit?.oid ?? null;
      if (details.mergeQueueEntry) f.queue.entry = "queued";
    }
    const rs = await optional(
      "Effective branch rulesets (metadata:read)",
      async () => {
        const r = await client.request(
          "GET /repos/{owner}/{repo}/rules/branches/{branch}",
          { owner, repo, branch: ref, per_page: 100, page: 1 },
        );
        if (r.headers.link?.includes('rel="next"')) throw Error();
        return ruleset.parse(r.data);
      },
    );
    const classic = await optional(
      "Classic branch protection (administration:read)",
      async () => {
        const c = await scoped("classic");
        const raw = await c.graphql<unknown>(
          `query MergeClassic($owner:String!,$repo:String!,$ref:String!) {repository(owner:$owner,name:$repo){ ${repoFields} ref(qualifiedName:$ref){ name target {oid} branchProtectionRule { ${classicFields} } } } }`,
          { owner, repo, ref: "refs/heads/" + ref },
        );
        const r = z
          .object({
            repository: gqlRepo.extend({
              ref: z.object({
                name: z.string(),
                target: z.object({ oid: sha }),
                branchProtectionRule: classicRule.nullable(),
              }),
            }),
          })
          .parse(raw).repository;
        sameRepo(r);
        if (r.ref.name !== ref || r.ref.target.oid !== baseSha) {
          changed = true;
          throw Error();
        }
        return r.ref.branchProtectionRule;
      },
    );
    let review = false,
      queue = !!details?.mergeQueue || !!details?.mergeQueueEntry,
      unsupported = false,
      parsed = true;
    function requireCheck(n: string, appId: number | null) {
      if (!f.rules.checks.some((x) => x.name === n && x.appId === appId)) {
        if (f.rules.checks.length >= 100) {
          miss("Required check limit reached");
          parsed = false;
        } else f.rules.checks.push({ name: n, appId });
      }
    }
    if (classic) {
      if (classic.requiresStatusChecks) {
        if (!classic.requiredStatusChecks?.length) {
          parsed = false;
          miss("Classic required check sources unavailable");
        }
        for (const c of classic.requiredStatusChecks ?? [])
          requireCheck(c.context, c.app?.databaseId ?? null);
      }
      review =
        classic.requiresApprovingReviews &&
        ((classic.requiredApprovingReviewCount ?? 1) > 0 ||
          classic.requiresCodeOwnerReviews ||
          classic.requireLastPushApproval);
      unsupported =
        classic.requiresDeployments ||
        classic.requiresConversationResolution ||
        classic.requiresCommitSignatures ||
        classic.requiresLinearHistory ||
        classic.restrictsPushes ||
        classic.lockBranch;
    }
    for (const r of rs ?? []) {
      if (r.type === "merge_queue") {
        queue = true;
        continue;
      }
      if (r.type === "required_status_checks") {
        const p = rulesetChecks.safeParse(r.parameters);
        if (!p.success) {
          parsed = false;
          miss("Ruleset required check sources unavailable");
          continue;
        }
        for (const c of p.data.required_status_checks)
          requireCheck(c.context, c.integration_id ?? null);
      } else if (r.type === "pull_request") {
        const p = reviews.safeParse(r.parameters);
        if (!p.success) {
          parsed = false;
          miss("Ruleset review requirements unavailable");
          continue;
        }
        review ||=
          p.data.required_approving_review_count > 0 ||
          p.data.require_code_owner_review ||
          p.data.require_last_push_approval ||
          !!p.data.required_reviewers?.length;
        unsupported ||=
          p.data.required_review_thread_resolution ||
          (!!p.data.allowed_merge_methods &&
            !["merge", "squash", "rebase"].every((m) =>
              p.data.allowed_merge_methods!.includes(m),
            ));
      } else if (
        !["deletion", "creation", "non_fast_forward"].includes(r.type)
      ) {
        unsupported = true;
      }
    }
    f.rules.known = rs !== undefined && classic !== undefined && parsed;
    f.rules.reviewRequired = review || (f.rules.known ? false : null);
    f.rules.queueRequired =
      queue || (f.rules.known && !!details ? false : null);
    if (queue) miss("Merge queue candidate validation unavailable");
    if (unsupported)
      miss("Additional applicable branch gates were not evaluated");
    f.otherGates =
      details &&
      ["BLOCKED", "BEHIND", "DIRTY", "DRAFT"].includes(details.mergeStateStatus)
        ? "blocked"
        : details?.mergeStateStatus === "CLEAN" && !unsupported && f.rules.known
          ? "clear"
          : "unknown";
    if (f.rules.checks.length > 0) {
      if (!f.testMergeSha) miss("Current test merge commit unavailable");
      const checks = await optional(
        "Commit checks and statuses (checks:read, statuses:read)",
        () => scoped("checks"),
      );
      if (checks)
        for (const [scope, oid] of [
          ["head", headSha],
          ["test_merge", f.testMergeSha],
        ] as const) {
          if (!oid) continue;
          await optional(scope + " check rollup", async () => {
            const raw = await checks.graphql<unknown>(checkQuery, {
              owner,
              repo,
              oid,
            });
            const r = z
              .object({ repository: gqlRepo.extend({ object: rollup }) })
              .parse(raw).repository;
            sameRepo(r);
            if (r.object.oid !== oid) throw Error();
            const contexts = r.object.statusCheckRollup?.contexts;
            if (!contexts) return;
            if (contexts.pageInfo.hasNextPage)
              miss(scope + " check coverage truncated at 100");
            for (const n of contexts.nodes) {
              const isRun = n.__typename === "CheckRun";
              if ((isRun ? n.checkSuite.commit : n.commit).oid !== oid) {
                miss(scope + " check returned a different SHA");
                continue;
              }
              const label = isRun ? n.name : n.context;
              // Even a non-required context identifies which test commit GitHub evaluates.
              // Permalink is GitHub-generated. Never persist external detailsUrl/targetUrl,
              // caller-provided query parameters, or URLs containing credentials.
              const prefix = "https://github.com/" + repository + "/";
              const path =
                isRun && n.permalink.startsWith(prefix)
                  ? n.permalink.slice(prefix.length)
                  : "";
              const url =
                /^(?:runs\/[0-9]+|actions\/runs\/[0-9]+\/job\/[0-9]+)$/.test(
                  path,
                )
                  ? prefix + path
                  : prefix + "commit/" + oid + "/checks";
              f.checks.push({
                scope,
                sha: oid,
                name: label,
                appId: isRun ? (n.checkSuite.app?.databaseId ?? null) : null,
                status: checkStatus(n),
                url,
              });
            }
          });
        }
    }
    // The test-merge commit and effective review/queue verdict can change with the same head.
    if (details) {
      const endDetails = await optional("Final PR gate verification", () =>
        readPR(gateFields, gates, "MergeGates"),
      );
      if (!endDetails || JSON.stringify(endDetails) !== JSON.stringify(details))
        changed = true;
    }
  }
  const last = await readPR(lifecycleFields, lifecycle, "MergeLifecycle");
  if (
    changed ||
    !matches(first) ||
    !matches(last) ||
    JSON.stringify(first) !== JSON.stringify(last)
  ) {
    f = blank();
    f.state = state(last);
    miss("PR revision or merge snapshot changed; obtain a fresh assessment");
  } else {
    f.stable = true;
    f.state = state(last);
    f.draft = last.isDraft;
    f.conflict =
      last.mergeable === "MERGEABLE"
        ? "none"
        : last.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown";
  }
  f.observedAt = new Date().toISOString();
  return mergeFactsSchema.parse(f);
}
