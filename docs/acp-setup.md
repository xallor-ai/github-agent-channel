# ACP runtime adapter (native bridge)

`runtime.type` is required and must be `acp` or `openclaw`. Configurations without
the discriminator are rejected; there is no implicit OpenClaw selection.

The bridge can launch an existing ACP coding harness using the official
`@agentclientprotocol/sdk` 2.9.1 stable v1 app API. The harness owns model execution,
editing and its own tools. Channel does not implement a coding loop. Only native
bridge execution is supported initially: Docker rendering rejects ACP configuration
before writing a deployment bundle.

Prepare a dedicated clean local Git checkout with `origin` pointing to the task's
`https://github.com/OWNER/REPO.git` (GitHub SSH forms also work). Configure the
numeric repository ID and absolute checkout path. Relative workspace paths resolve
against the agent configuration file. Do not share a checkout between bridge
processes. This adapter does not clone, reset, clean, commit or push the checkout.

```yaml
channel:
  baseUrl: https://channel.example.com
  tokenEnv: CHANNEL_CONNECTOR_TOKEN
runtime:
  type: acp
  command: /absolute/path/to/acp-harness
  args: ["--acp"] # replace with the installed harness's actual ACP invocation
  timeoutMs: 600000
  workspaces:
    "123456": /srv/workspaces/my-repo
  envRefs:
    MODEL_API_KEY: CHANNEL_MODEL_API_KEY
  permissionPolicy: deny
  verification:
    command: /usr/bin/node
    args: ["--test"]
    timeoutMs: 120000
  publication:
    kind: pull_request
    baseBranch: main
stateFile: agent.db
pollIntervalMs: 1000
requestTimeoutMs: 10000
```

Launch with `npm run channel -- agent run /path/to/agent.yaml` using Node 24.
The command and arguments above are placeholders for an administrator-installed
ACP-compatible harness, not a bundled executable. Authenticate/configure that
harness according to its own documentation. A runtime Gateway token is not needed.
Windows commands must be native executables (or `node.exe` with a script argument),
because commands run without a shell; `.cmd` launchers are not supported directly.

The subprocess receives PATH, Windows system-directory variables and temporary
directory variables, plus only the named `envRefs`. It does not inherit the whole
bridge environment, HOME, NODE_OPTIONS or cloud tokens. Add HOME or other variables
explicitly if the chosen harness needs them; this gives the harness access to the
corresponding user configuration. Never map bridge/admin secrets to the harness.

`permissionPolicy: deny` rejects ACP permission requests. `allow-once` selects only
an offered `allow_once` option; it never grants persistent permission. This is ACP
request handling, not an OS sandbox: the installed harness has native process
access and may use its own filesystem/terminal tools without asking the client.
Use a dedicated OS identity/container boundary outside this initial native adapter
when isolation is required. Client-provided filesystem/terminal tools and MCP
servers are not advertised. Harnesses requiring those services are unsupported.

Git inspections use a separate minimal OS environment, excluding all inherited
`GIT_*` settings and all runtime/cloud credentials. The installed Git executable is
resolved from absolute PATH entries before launching the runtime. System/global Git
configuration, fsmonitor, hooks, external diff/textconv, submodule inspection and
network protocols are disabled. Repository filters, executable helper configuration,
includes, partial clones, linked worktrees, alternate object stores and metadata
redirection are rejected. Use a normal dedicated clone without those features.
The local Git configuration is fingerprinted before execution and must remain
unchanged when collecting results. These checks do not provide an OS isolation
boundary against another native process concurrently changing the checkout.

Before starting the harness for an Issue/PR task, the bridge calls the Channel's
server-scoped `read_issue` tool with empty arguments. An authorization failure stops
before harness launch. The prompt contains the task identity, captured baseline,
request and bounded issue JSON explicitly labeled untrusted; repository tasks skip
that read. The runtime is instructed to edit without committing, pushing or changing
Git metadata. Interactive client read tools remain unadvertised.

The bridge saves the session handle before prompting. Cancellation sends ACP cancel
and terminates the immediate child; neither proves descendant processes stopped.
Interrupted/disconnected runs become `unknown`, with no automatic replay or resume.
An uncertain workspace stays blocked within that bridge process. Reconcile the
runtime and checkout manually before restarting the bridge. The clean-workspace
guard also rejects leftover changes on later runs. The lock is process-local;
multiple bridge instances must use distinct checkouts.

Results contain actual bounded UTF-8 file contents and the captured HEAD SHA,
not model assertions about edits. Binary files, symlinks, workflow paths, changed
HEAD, over 100 files and over 512 KiB total contents are rejected. Changed executable files and executable-bit
changes are not supported publication artifacts. The optional configured
verification command runs in the checkout and records its observed exit code and
bounded output; timeout/interruption is not passing evidence. Verification executes
repository code with only basic OS execution variables; harness `envRefs`, model
credentials and bridge secrets are excluded. It still shares the native OS identity
and filesystem, so this environment boundary is not an OS sandbox.

PR proposal generation requires `runtime.publication`, and actual publication
separately requires the cloud binding's `writePolicy`; the cloud checks the base
SHA, allowed paths and actor again. A failed or unknown verification exit code
disables publication (`kind: none`) while preserving changes and the test report.
A successful PR proposal includes the actual configured verification command,
exit code and bounded observed output. When verification is not configured, the
proposal explicitly says no passing test evidence is claimed. Otherwise, without
an explicit PR setting, the adapter emits an explicit comment publication for an
Issue/PR target and `none` for a repository target. Every result contains both an
`artifacts` array (possibly empty) and a `publication` object; the channel does not
infer missing outcome fields. Tasks use required `target` and `source` objects,
with the Issue/PR number in `target.number` only.

Local tests use a real child process speaking ACP through the SDK, with synthetic
editing/model behavior. They do not establish compatibility with a particular real
coding harness or live GitHub/model acceptance; record that separately before use.

Cloud event/writePolicy, App Contents permission, fresh state stores and complete acceptance checklist: [Channel v2 contract](protocol-v2.md).
