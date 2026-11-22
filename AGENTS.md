# GitHub Agent Channel

## Product and implementation boundaries

- This is a general GitHub collaboration channel, not an OpenClaw-only plugin or comment bot. Core owns GitHub ingress, authorization, routing, durable tasks and publication; runtimes own model execution and coding tools.
- Runtime selection is explicit: runtime.type is openclaw or acp. OpenClaw is the read/analysis adapter; ACP uses the official SDK to run an existing administrator-installed coding harness in a prepared workspace. Never add a home-grown coding loop to core.
- The user explicitly requires NO backward compatibility. Delete obsolete contracts/branches rather than add aliases or silent fallbacks. Connector protocol is v2 only; runtime.type and canonical target/source/outcome are required. Old database formats are rejected intact, not migrated or deleted.
- Code implements typed outcomes and opt-in draft PR publication; local fixtures are NOT proof of a live coding harness or real Issue→code→PR acceptance. Current evidence is in docs/capabilities.md.

## Read first

- Read docs/README.md, docs/implementation-map.md, docs/architecture.md and relevant source/tests before feature work or external research. Requirements describe intended scope; source shows what exists. Record any gap.
- docs/setup.md is the OpenClaw adapter guide; docs/acp-setup.md is the native ACP guide. ECS is only an optional server deployment example.
- Dated validation/review files are historical evidence, never current configuration. Superseded V1/direct-call plans were deleted; Git history retains them. Never restore cloud-to-inner-runtime calls or comment-only task aliases.

## Actual call graph and common traps

- src/main.ts loads the cloud config once and wires HTTP, PullCoordinator and publication-only DeliveryWorker. No live configuration-update API exists.
- src/agent.ts is the outbound bridge, not a coding engine. src/runtime-factory.ts selects adapters; src/connector.ts contains OpenClaw Responses specifics only.
- Cloud has connector identity/config; bridge has runtime config. Only bridge initiates cross-network requests. No public runtime address or reverse tunnel is required.
- workerId, runtime agentId and GitHub botLogin are different identities. Admin, connector and runtime/model credentials are not interchangeable.
- Task target is issue/pull_request/repository; source records event/action and optional original comment ID. There are no task-root commentId/issueNumber/result/commentUrl compatibility fields.
- RuntimeResult requires text, artifacts and explicit publication. Accepted execution outcome and confirmed publication receipt are distinct. A model statement is not observed code/test evidence.
- Verification exit 0 alone does not authorize publication: candidate paths/content must match before and after verification. Preserve actual UTF-8 bytes including BOM. Changed verification inputs disable publication; never silently restore or rerun the command.
- Bindings events are opt-in; subscribing all GitHub events does not implement them. PR writes require explicit writePolicy. Core derives the head branch and validates repository, base SHA, paths and actor.
- Cloud Inbox and local journal protect different network boundaries. Startup/expiry uncertainty is not proof execution stopped; no automatic model or GitHub side-effect replay. Unknown execution may only be reconciled to failed, not promoted to success.
- ACP process permissions are not an OS sandbox. Dedicated normal clean clones only; no shared workspaces, symlinks/submodules/alternate Git metadata. The harness and verification subprocesses must not inherit bridge credentials; verification does not receive harness auth envRefs.
- ACP native bridge is supported; ACP Docker render explicitly fails. Do not imply the provided Channel image bundles a coding harness or a workspace sandbox.

## Reuse and maintenance

- Compare pinned SDK/runtime implementations before adding workspace, session or GitHub tooling. Prefer maintained protocol/SDK implementations; keep task policy and auth in Channel.
- Current reuse: Octokit for GitHub App/Git Data/PR APIs, official ACP TypeScript SDK for harness protocol. Adapter-specific APIs must not become requirements on every Runtime.
- Update capabilities, implementation map, relevant guide/examples and evidence with each change. Do not rebrand a partial adapter or mocked test as universal runtime interoperability.
- CLI init templates come from src/examples.ts; keep deploy example files and guide YAML consistent.
- Secret File references and agent stateFile are relative to config; native cloud dataFile is relative to cwd. Container paths are fixed /data. Fresh v2 stores are required for this breaking revision.
- Node24 required. npm run channel uses source CLI; npm start uses compiled cloud main. Docker defaults to cloud, generated bridge command overrides it.
- doctor is offline; healthz is process liveness. Unit/HTTP and Docker smoke use synthetic GitHub/model behavior. smoke:openclaw uses a real model with synthetic read tools. Live outcomes require separate evidence.
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
