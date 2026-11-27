# GitHub Agent Channel

## Check the remote before continuing work

- Before editing or committing, fetch the current remote base and head. For PR work, query the exact repository and PR number on GitHub; verify it is open and its base and head still match the task. A surviving branch is not evidence of an open PR.
- Repeat the check immediately before pushing, requesting a review or posting a comment. If the target changed or cannot be verified, stop that write. Preserve local work; for follow-up after a merge, start from the current authorized base on a fresh branch and carry only changes still missing.
- For Channel delegation, review evidence and publication receipts, use the [GitHub Agent Channel skill](.agents/skills/github-agent-channel/SKILL.md).

## Product and implementation boundaries

- This is a general GitHub collaboration channel, not an OpenClaw-only plugin or comment bot. Core owns GitHub ingress, authorization, routing, durable tasks and publication; runtimes own model execution and coding tools.
- Runtime selection is explicit: runtime.type is openclaw or acp. OpenClaw is the read/analysis adapter; ACP uses the official SDK to run an existing administrator-installed coding harness in a prepared workspace. Never add a home-grown coding loop to core.
- The user explicitly requires NO backward compatibility. Delete obsolete contracts/branches rather than add aliases or silent fallbacks. Connector protocol is v2 only; runtime.type and canonical target/source/outcome are required. Old database formats are rejected intact, not migrated or deleted.
- Code implements typed outcomes and opt-in draft PR publication; local fixtures are NOT proof of a live coding harness or real Issue→code→PR acceptance. Current evidence is in docs/capabilities.md.

## Read first

- [Product contract](docs/product-contract.md) defines the approved scope. Map feature changes to C/W acceptance criteria; current implementation evidence belongs in the capability ledger.

- Read docs/README.md, docs/implementation-map.md, docs/architecture.md and relevant source/tests before feature work or external research. Requirements describe intended scope; source shows what exists. Record any gap.
- docs/setup.md is the OpenClaw adapter guide; docs/acp-setup.md is the native ACP guide. ECS is only an optional server deployment example.
- Dated validation/review files are historical evidence, never current configuration. Superseded V1/direct-call plans were deleted; Git history retains them. Never restore cloud-to-inner-runtime calls or comment-only task aliases.

## Actual call graph and common traps

- src/main.ts loads the cloud config once and wires HTTP, PullCoordinator and publication-only DeliveryWorker. Service configuration is static; repository bindings are dynamic, device-scoped and managed through authenticated registration endpoints.
- OpenClaw tool exposure and invocation validation must share the target-scoped allowlist. Repository tasks allow only read_file and publish none; never offer read_issue without an Issue/PR scope. For repository/Issue tasks read_file still reads the default branch, not the push SHA. On PR tasks, require the pinned same-repository revision and never fall back to the default branch. Deep search uses a task-scoped snapshot and per-read lease/authorization checks.
- src/agent.ts is the outbound bridge, not a coding engine. src/runtime-factory.ts selects adapters; src/connector.ts contains OpenClaw Responses specifics only.
- Cloud has connector identity/config; bridge has runtime config. Only bridge initiates cross-network requests. No public runtime address or reverse tunnel is required.
- The server derives the worker identity from the paired device credential; it is neither a client-selected workerId nor the runtime agentId or GitHub botLogin. Admin, connector and runtime/model credentials are not interchangeable.
- Task target is issue/pull_request/repository; source records event/action and optional original comment ID. There are no task-root commentId/issueNumber/result/commentUrl compatibility fields.
- RuntimeResult requires text, artifacts and explicit publication. Accepted execution outcome and confirmed publication receipt are distinct. A model statement is not observed code/test evidence.
- Verification exit 0 alone does not authorize publication: candidate paths/content must match before and after verification. Preserve actual UTF-8 bytes including BOM. Changed verification inputs disable publication; never silently restore or rerun the command.
- Bindings events are opt-in; subscribing all GitHub events does not implement them. PR writes require a matching server-side writeProfiles entry; device declarations cannot grant write access. Core derives the head branch and validates repository, base SHA, paths and actor.
- Cloud Inbox and local journal protect different network boundaries. Startup/expiry uncertainty is not proof execution stopped; no automatic model or GitHub side-effect replay. Unknown execution may only be reconciled to failed, not promoted to success.
- ACP process permissions are not an OS sandbox. Dedicated normal clean clones only; no shared workspaces, symlinks/submodules/alternate Git metadata. The harness and verification subprocesses must not inherit bridge credentials; verification does not receive harness auth envRefs.
- Reject skip-worktree/assume-unchanged index flags at workspace admission and every change collection; they hide actual edits from Git. The repository target SHA or pinned same-repository PR head must match workspace HEAD before ACP starts; unversioned PR assignments are rejected. Never silently clear flags, reset or switch branches.
- ACP native bridge is supported; ACP Docker render explicitly fails. Do not imply the provided Channel image bundles a coding harness or a workspace sandbox.

## Pull request review

- Every PR requires two independently identified models reviewing the same verified base/head diff. Record shared findings, single-model findings, disposition and evidence on the open PR. CI is not a model review; changed heads need a new review. Keep the real Channel review and publication receipt.

## Reuse and maintenance

- Compare pinned SDK/runtime implementations before adding workspace, session or GitHub tooling. Prefer maintained protocol/SDK implementations; keep task policy and auth in Channel.
- Current reuse: Octokit for GitHub App/Git Data/PR APIs, official ACP TypeScript SDK for harness protocol. Adapter-specific APIs must not become requirements on every Runtime.
- Update capabilities, implementation map, relevant guide/examples and evidence with each change. Do not rebrand a partial adapter or mocked test as universal runtime interoperability.
- Review changes through the GitHub Agent Channel with an exact commit/base and supplied diff/context; record the real delivery/task/runtime/publication receipt and verify model claims. Local review or fixture success alone does not complete this loop. Repository administrators opt into deepReview/nativeReview on the current binding; these never grant Git Data write permission. A versioned PR task reads its own diff; no tool fetches arbitrary PRs or revisions. Record diff coverage and snapshot omissions. Native Review is a separate opt-in, commit-pinned COMMENT (no inline or approval); an ordinary comment is not a Review receipt.
- Bridge config loading returns separate config and resolved secrets; resolve credentials once, pass only the runtime token to its factory, and render only config. OpenClaw configuration types are inferred from the schema. Do not restore unused capabilities declarations.
- CLI init templates come from src/examples.ts; keep deploy example files and guide YAML consistent.
- Secret File references and agent stateFile are relative to config; native cloud dataFile is relative to cwd. Container paths are fixed /data. Fresh cloud v4 and bridge v3 stores are required for this breaking revision.
- Node24 required. npm run channel uses source CLI; npm start uses compiled cloud main. Docker defaults to cloud, generated bridge command overrides it.
- doctor is offline; healthz is process liveness. Unit/HTTP and Docker smoke use synthetic GitHub/model behavior. smoke:openclaw uses a real model with synthetic read tools. Live outcomes require separate evidence.
- Type checking enables noUnusedLocals and noUnusedParameters. Keep protocol inputs unknown until schema validation; do not reintroduce any-based response parsing.
- CI is .github/workflows/checks.yml. format:check covers src/tests/scripts; validate Markdown, configuration examples and links separately.

## Invariants

- Build a runtime-independent GitHub collaboration channel. OpenClaw is the first connector, not the core runtime.
- Keep secrets in environment variables or secret files outside Git; public config contains references only.
- Verify raw webhook bytes before parsing. Persist accepted tasks before acknowledging. Do not execute long jobs in the webhook handler.
- Task context is constructed server-side. Agent tools cannot override connection, installation, repository, actor or target issue.
- Separate installation access from actor authorization. Re-check authorization before outbound effects.
- Use tests for behavior, including duplicates, unauthorized calls, transport ambiguity, restart and output delivery.
- No automatic replay of ambiguous external side effects. No claims of exactly-once external execution.
- Keep this implementation milestone explicit in docs. Do not describe mocked checks as live GitHub/OpenClaw verification.
- Do not create PRs or merge without user request; commit and push to the authorized development branch.
