# GitHub Agent Channel

## Product intent and current milestone

- This is a **general GitHub collaboration channel**, independent of any one agent runtime. OpenClaw is the first adapter, not the product definition. Issue → code changes → tests → PR is the next requested acceptance scenario, not the only eventual use case.
- Do not redefine the product as an OpenClaw plugin, a comment bot, or a home-grown coding agent. Separate GitHub ingress, authorization, routing and publication from runtime-owned model execution, workspace tools and sessions.
- Current implementation is narrower than the goal: signed `issue_comment.created` mentions → read Issue/file → text comment. Code editing, project tests, branches, commits and PR creation are **not implemented**. Treat this as a milestone gap to address, not a permanent product prohibition.
- An installed App, enabled permission or subscribed event does not prove implemented behavior. A `RuntimeConnector` interface does not prove multiple runtimes are wired or tested. Check [capabilities](docs/capabilities.md) before making capability claims.

## Read before changing or researching architecture

- Read [documentation index](docs/README.md), [implementation map](docs/implementation-map.md), [current architecture](docs/architecture.md), and the relevant source/tests before comparing external designs. Verify the actual branch and commit; a remote default-branch README may describe older code.
- [setup.md](docs/setup.md) is the **currently implemented OpenClaw adapter** guide. It is not a runtime-neutral protocol specification. [ecs-setup.md](docs/ecs-setup.md) is optional self-hosting; ECS is a deployment example, not a required product dependency.
- `implementation-plan.md`, `deployment-design.md`, and `deployment-plan.md` preserve superseded plans. `progress.md` and dated validation files are historical evidence, not current configuration or live status. Never restore cloud-to-runtime direct calls from those documents.
- Source is authoritative for what runs; this file and approved requirements define intended scope. When they differ, record the gap rather than silently changing the requirement or claiming the implementation is complete.

## Runtime and network facts that are easy to misread

- Cloud entry is `src/main.ts`: HTTP server + `PullCoordinator` + **publication-only** `DeliveryWorker`. The cloud never invokes the inner-network runtime. `src/worker.ts` does not execute models.
- `src/agent.ts` is the outbound bridge process, not a coding agent or an OpenClaw-native channel plugin. `Agent` accepts a `RuntimeConnector`, but `runAgent()` currently constructs `OpenClawConnector` directly; there is no provider registry or capability negotiation yet.
- `src/connector.ts` is specifically the OpenClaw Responses adapter. Its read-only prompt and two client tools are current adapter behavior, not the universal Channel capability contract. `DirectRuntimeConfig` is a legacy name for the bridge-to-runtime config, not evidence of supported cloud direct mode.
- Cloud config uses `connector`; only the bridge config has `runtime`. Public GitHub webhooks arrive at the Channel server; the bridge makes outbound HTTPS requests. The runtime need not have a public address. TLS is handled by an existing HTTPS edge or optional Caddy.
- Three different identities exist: cloud `workerId`, runtime `agentId`, and GitHub `botLogin`. Three different tokens exist: cloud admin, bridge connector, and runtime Gateway token. Do not interchange them.
- A task's `status=succeeded` means execution returned an accepted text result. `deliveryStatus=sent` separately records the comment publication. Neither proves code changes, tests or PR creation.
- Cloud Inbox/assignment storage and local bridge journal cover different failure boundaries. Do not remove one merely because both persist tasks. Expiry/restart currently becomes `unknown`; it is not proof the remote run stopped.
- `TaskStore.claim()` is used by lower-level tests, not the current production execution path, which uses `claimAssignment()`. `ConfigManager.update()` exists but is not wired as live configuration reload or an HTTP settings API. Store-level reconciliation possibilities are broader than the exposed HTTP contract; check `server.ts`.

## Reuse and documentation discipline

- Before adding execution/workspace/session/GitHub tool infrastructure, compare maintained SDKs, runtime APIs and existing products at pinned revisions. Record reuse, adaptation cost, missing policy guarantees, and evidence level. Do not build a second coding runtime inside Channel by default.
- Keep runtime-specific APIs and policy in adapters; do not make all runtimes implement OpenClaw Responses or depend on an OpenClaw plugin SDK. Verify more than one real adapter before claiming runtime interoperability.
- Track each capability in `docs/capabilities.md`: implemented subset, source, automated evidence, real-environment evidence, and outstanding work. Plans and comparison findings must be labeled proposals until approved/implemented.
- Follow the document states and ownership in `docs/README.md`. Preserve dated evidence; annotate its applicability instead of rewriting old failures or test counts as if they happened later.

## Build, configuration and validation facts

- Use Node.js 24. `npm run channel` runs `src/cli.ts` through tsx; `npm start` runs the cloud's compiled `dist/main.js`. Docker defaults to the cloud; the rendered agent service overrides its command.
- CLI init templates come from `src/examples.ts`, not directly from `deploy/*.example.yaml`. Keep both copies and guide examples consistent when changing configuration.
- Secret file references and agent `stateFile` are relative to the config file; native cloud `dataFile` is relative to process cwd. Generated containers use fixed `/data` paths.
- `doctor` is offline config/secret-reference/Compose validation; `/healthz` is process liveness; Compose `ps` is container status. None proves GitHub/model/PR functionality.
- `npm test` uses fixtures for GitHub/model effects. `smoke:deployment` uses actual Docker/HTTP/TLS with synthetic external behavior. `smoke:openclaw` calls a real model with synthetic read tools. A real GitHub → runtime → outcome test needs its own dated evidence.
- CI is `.github/workflows/checks.yml`. `npm run format:check` covers `src`, `tests`, `scripts`; validate Markdown/JSON examples and links separately for documentation changes.

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
