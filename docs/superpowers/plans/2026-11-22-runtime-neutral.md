# Runtime-neutral Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Correct runtime/comment coupling and provide a policy-controlled Issue→code→PR path through existing coding runtimes.

**Architecture:** Keep server-side GitHub scope and outbound bridge. Register OpenClaw and official ACP SDK adapters; persist target/source/outcome/run metadata; dispatch typed publication through task-scoped GitHub APIs.

**Tech Stack:** Node24, TypeScript, SQLite, Zod, existing Octokit, ACP SDK 2.9.1.

**Spec:** [runtime-neutral-design.md](../../runtime-neutral-design.md).

## Global Constraints

- Work in existing isolated `codex/outbound-connector`; no deployment, development PR or merge.
- No compatibility: explicit runtime.type, canonical target/source/outcome, v2-only HTTP and fresh schema v2; old formats rejected intact.
- Host configuration owns command/cwd/environment; server owns GitHub identity and write policy.
- No automatic replay of uncertain model or GitHub effects.
- Local fixtures must not be described as live GitHub/ACP model acceptance.

## Task 1: Generic task and outcome persistence

Files: `src/contracts.ts`, `src/outcomes.ts`, `src/store.ts`, `src/webhook.ts`, `src/config.ts`; `tests/generic-tasks.test.ts`.

Produces `Artifact`, `PublicationRequest`, `RuntimeEvent`, required canonical target/source on Task and persisted outcome. Schema accepts bounded structured output; rejects old table formats without mutation. Logical source-comment dedupe remains; other events dedupe by delivery.

- [x] Write failing tests: signed configured issues/push create scoped tasks without fabricated comments; old SQLite rows remain intact after schema rejection; structured outcomes survive restart.
- [x] Run `npx tsx --test tests/generic-tasks.test.ts` and observe expected failures.
- [x] Implement normalization/new schema and outcome validation, rejecting extra identity fields and oversized/unsafe file paths.
- [x] Run new plus store/webhook/config tests.

```ts
assert.equal(task.target.kind, "repository");
assert.equal(task.commentId, undefined);
assert.equal(reopened.get(id)?.outcome?.artifacts?.[0].kind, "change_set");
```

## Task 2: Runtime factory and ACP adapter

Files: `src/agent-config.ts`, `src/runtime-factory.ts`, `src/acp-connector.ts`, `src/runtime-workspace.ts`, `src/agent-deploy.ts`; `tests/acp-connector.test.ts`, `tests/runtime-factory.test.ts`.

Consumes shared types in spec; produces `createRuntime(config,configPath): RuntimeConnector`. Required discriminator; ACP command/cwd map/env references configured locally. Reuse SDK app API; real child-process fixture exercises protocol. Use native Git only to inspect prepared clean workspaces/collect changes, existing Agent edits. Explicit configured verification command records test report.

- [x] Tests fail for ACP selection, workspace scope drift, protocol interruption, result collection and cancellation ambiguity.
- [x] Implement factory/schema and ACP SDK connection with bounded output, no secret logging, no cloud/admin environment leakage.
- [x] Verify real process protocol fixture edits a temporary Git repo, runs configured verification, returns actual change_set and optional PR proposal; reject dirty/wrong-origin workspace.
- [x] Render ACP deployment only when supported; reject unsupported container command setups explicitly rather than generate a broken service.

```ts
assert.equal(
  result.artifacts?.find((a) => a.kind === "change_set")?.files[0].path,
  "src/example.txt",
);
assert.equal(result.publication?.kind, "pull_request");
```

## Task 3: Scoped draft PR publisher

Files: `src/github.ts`, optional `src/github-publication.ts`; `tests/github-publication.test.ts`.

Consumes `Binding.writePolicy`, `PublicationRequest`; produces required `GitHubClient.publishPullRequest(task,request)`. Derive branch `channel/<task UUID>`; match remote base SHA; validate allowed paths and size/count, disallow workflow/git internals; use scoped contents-write installation token only for enabled publication.

- [x] Tests fail for missing policy, stale base, unauthorized actor, path violations, duplicate branch conflict, and expected draft PR result.
- [x] Implement using Octokit Git Data/PR APIs with reauthorization before every mutation; no write retries.
- [x] Simulate lost write response and revoked actor; assert no subsequent/replayed mutation and ambiguity surfaced.
- [x] Run existing GitHub read/comment tests to preserve compatibility.

```ts
await assert.rejects(
  client.publishPullRequest(task, proposal),
  /policy|authorized/i,
);
assert.equal(result.url, "https://github.com/org/repo/pull/7");
```

## Task 4: Bridge, HTTP, delivery integration

Files: `src/agent.ts`, `src/agent-store.ts`, `src/pull.ts`, `src/worker.ts`, `src/server.ts`, `src/connector.ts`; tests `generic-outbound.test.ts` and existing suites.

- [x] Add failing real HTTP/SQLite tests for structured outcome and no-publication targets, PR delivery, replay/conflicting payload, bounded invalid output.
- [x] Persist runtime started handles in local journal, carry outcome through v2 nested outcome ACK protocol; use factory in CLI.
- [x] Dispatch publication by type, expose outcome/publication receipt in the sole publicationReceipt structure; generic URL reconciliation restricted to task repository.
- [x] Validate strict rejection of old assignments, flat results and v1 routes.

## Task 5: Review, docs and verification

- [x] Run final typecheck, all tests, build/format and final Linux Docker smoke.
- [x] Independent review of scope/auth/ambiguity/migration; resolve load-bearing findings before push.
- [x] Update AGENTS, implementation map, capability ledger, current guides and examples; preserve dated history.
- [x] Record final validation and push authorized development branch; no PR/merge.

## Final contract ruling

User explicitly required deletion rather than compatibility. The implementation removes ConfigManager/update, TaskStore.claim/finish and unknown→success repair, DirectRuntimeConfig, root comment aliases, v1 routes and automatic migration. Completed tasks use the new canonical tests; final commit/validation evidence is recorded separately.
