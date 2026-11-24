import {
  publishDraftPullRequest,
  validateProposal,
} from "./github-publication.js";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import {
  AccessDenied,
  AmbiguousExecution,
  type BindingLookup,
  type ChannelConfig,
  type GitHubClient,
  type Task,
  type PublicationRequest,
} from "./contracts.js";

const permissions = {
  metadata: "read",
  contents: "read",
  issues: "write",
  pull_requests: "write",
} as const;
const MAX_FILE = 128 * 1024;
const MAX_COMMENT_PAGES = 10;
export class OctokitGitHubClient implements GitHubClient {
  #app: App;
  #config: ChannelConfig;
  #fetch: typeof fetch;
  constructor(
    config: ChannelConfig,
    privateKey: string,
    private readonly lookup: BindingLookup,
    private readonly verifyManager: (task: Task) => Promise<void>,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#app = new App({
      appId: config.github.appId,
      privateKey,
      Octokit: Octokit.defaults({
        request: { fetch: fetchImpl, timeout: 30000 },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      }),
    });
  }
  #binding(task: Task) {
    const found = this.lookup(task.installationId, task.repositoryId);
    if (
      !found?.enabled ||
      found.id !== task.bindingId ||
      found.owner !== task.owner ||
      found.repo !== task.repo ||
      ![task.actorId, task.repositoryId, task.installationId].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      !/^[A-Za-z0-9-]{1,39}$/.test(task.actorLogin)
    )
      throw new AccessDenied("Task scope is not enabled");
    return found;
  }
  async #client(task: Task, write = false): Promise<Octokit> {
    this.#binding(task);
    const installation = await this.#app.getInstallationOctokit(
      task.installationId,
    );
    // App v16 only accepts installationId in getInstallationOctokit. Request a
    // scoped token explicitly, then avoid auth-app hooks that refresh/retry writes.
    const auth = (await installation.auth({
      type: "installation",
      repositoryIds: [task.repositoryId],
      permissions: write ? { ...permissions, contents: "write" } : permissions,
    })) as { token: string };
    return new Octokit({
      auth: auth.token,
      request: { fetch: this.#fetch, timeout: 30000 },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
  }
  async #authorized(task: Task): Promise<Octokit> {
    this.#binding(task);
    await this.verifyManager(task);
    const client = await this.#client(task);
    const { data: repo } = await client.request("GET /repos/{owner}/{repo}", {
      owner: task.owner,
      repo: task.repo,
    });
    if (
      repo.id !== task.repositoryId ||
      repo.name !== task.repo ||
      repo.owner.login !== task.owner
    )
      throw new AccessDenied("Repository identity changed");
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      { owner: task.owner, repo: task.repo, username: task.actorLogin },
    );
    if (
      data.user?.id !== task.actorId ||
      data.user.login !== task.actorLogin ||
      !["admin", "maintain", "write"].includes(data.permission)
    )
      throw new AccessDenied("Actor is not authorized");
    this.#binding(task);
    return client;
  }
  async authorize(task: Task): Promise<void> {
    const client = await this.#authorized(task);
    if (task.target.kind === "pull_request") {
      const { data } = await client.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner: task.owner, repo: task.repo, pull_number: task.target.number },
      );
      if (data.state !== "open" || data.merged !== false)
        throw new AccessDenied("Target pull request is not confirmed open");
    }
  }
  async readIssue(task: Task): Promise<unknown> {
    if (
      !task.target ||
      task.target.kind === "repository" ||
      !Number.isSafeInteger(task.target.number) ||
      task.target.number < 1
    )
      throw new AccessDenied("Task has no issue scope");
    const client = await this.#authorized(task);
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner: task.owner, repo: task.repo, issue_number: task.target.number },
    );
    return {
      untrusted: true,
      number: task.target.number,
      title: data.title,
      body: data.body,
    };
  }
  async readFile(task: Task, path: string): Promise<unknown> {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 1024 ||
      /[\\:%\x00-\x1f]/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((p) => !p || p === ".." || p === ".")
    )
      throw new Error("Invalid repository file path");
    const client = await this.#authorized(task);
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: task.owner, repo: task.repo, path },
    );
    if (
      Array.isArray(data) ||
      data.type !== "file" ||
      data.size > MAX_FILE ||
      !("content" in data) ||
      data.encoding !== "base64" ||
      data.content.length > Math.ceil((MAX_FILE * 4) / 3) + 4096
    )
      throw new Error("Expected a file of at most 128 KiB");
    const bytes = Buffer.from(data.content, "base64");
    if (bytes.length > MAX_FILE) throw new Error("File exceeds 128 KiB");
    return { untrusted: true, path, content: bytes.toString("utf8") };
  }
  private async authorizeWrite(task: Task): Promise<void> {
    try {
      await this.authorize(task);
    } catch {
      throw new AccessDenied("Cannot confirm authorization for GitHub write");
    }
  }
  async publishPullRequest(
    task: Task,
    proposal: Extract<PublicationRequest, { kind: "pull_request" }>,
  ): Promise<{ id: number; url: string }> {
    validateProposal(task, this.#binding(task).writePolicy, proposal);
    await this.authorizeWrite(task);
    const client = await this.#client(task, true);
    return publishDraftPullRequest(task, proposal, client, () =>
      this.authorize(task),
    );
  }
  async publishComment(
    task: Task,
    text: string,
  ): Promise<{ id: number; url: string }> {
    if (
      !task.target ||
      task.target.kind === "repository" ||
      !Number.isSafeInteger(task.target.number) ||
      task.target.number < 1
    )
      throw new AccessDenied("Task has no issue scope");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(task.id))
      throw new Error("Invalid task marker ID");
    const marker = `<!-- github-agent-channel:${task.id} -->`;
    const body = `${text}\n\n${marker}`;
    if (!text.trim() || body.length > 20000)
      throw new Error(
        "Response must contain text and fit within 20000 characters",
      );
    const client = await this.#authorized(task);
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const { data } = await client.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: task.owner,
          repo: task.repo,
          issue_number: task.target.number,
          per_page: 100,
          page,
        },
      );
      const existing = data.find(
        (comment) =>
          comment.user?.login === this.#config.github.botLogin &&
          comment.body?.includes(marker),
      );
      if (existing) {
        if (
          typeof existing.id !== "number" ||
          !Number.isSafeInteger(existing.id) ||
          existing.id <= 0
        )
          throw new AmbiguousExecution("GitHub comment ID is unsupported");
        return { id: existing.id, url: existing.html_url };
      }
      if (data.length < 100) break;
      if (page === MAX_COMMENT_PAGES)
        throw new AmbiguousExecution(
          "Comment reconciliation exceeded scan limit",
        );
    }
    // Re-check after the paginated read, immediately before the outbound effect.
    await this.authorizeWrite(task);
    try {
      const { data } = await client.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: task.owner,
          repo: task.repo,
          issue_number: task.target.number,
          body,
        },
      );
      if (
        typeof data.id !== "number" ||
        !Number.isSafeInteger(data.id) ||
        data.id <= 0 ||
        !data.html_url
      )
        throw new AmbiguousExecution("GitHub comment response was incomplete");
      return { id: data.id, url: data.html_url };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!status || status >= 500 || status === 408)
        throw new AmbiguousExecution(
          "GitHub comment delivery is uncertain; reconcile before any retry",
        );
      throw error;
    }
  }
}
