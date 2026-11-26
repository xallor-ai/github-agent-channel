import { boundedMergeFetch, collectMergeFacts } from "./github-merge-facts.js";
import { z } from "zod";
import { readPinnedPullFile } from "./github-pinned-file.js";
import { publishNativeReview, reconcileNativeReview } from "./github-review.js";
import {
  publishDraftPullRequest,
  validateProposal,
} from "./github-publication.js";
import { checkPull, collectPullDiff } from "./github-pull-context.js";
import { App } from "@octokit/app";
import { ownerReaction } from "./github-reaction.js";
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
    private readonly publicationAllowed: (id: string) => boolean = () => true,
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
  #binding(task: Task, evidenceRead = false) {
    const found = this.lookup(task.installationId, task.repositoryId);
    if (
      (!evidenceRead &&
        (task.status === "succeeded" || task.status === "failed") &&
        !this.publicationAllowed(task.id)) ||
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
    return this.#installationClient(
      task,
      write ? { ...permissions, contents: "write" } : permissions,
    );
  }
  async #installationClient(
    task: Task,
    scope: {
      metadata: "read";
      pull_requests: "read" | "write";
      contents?: "read" | "write";
      issues?: "read" | "write";
      administration?: "read";
      checks?: "read";
      statuses?: "read";
    },
    evidenceRead = false,
  ): Promise<Octokit> {
    const installation = await this.#app.getInstallationOctokit(
      task.installationId,
    );
    // App v16 only accepts installationId in getInstallationOctokit. Request a
    // scoped token explicitly, then avoid auth-app hooks that refresh/retry writes.
    const auth = (await installation.auth({
      type: "installation",
      repositoryIds: [task.repositoryId],
      permissions: scope,
    })) as { token: string };
    return new Octokit({
      auth: auth.token,
      request: {
        fetch: evidenceRead ? boundedMergeFetch(this.#fetch) : this.#fetch,
        timeout: 30000,
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
  }
  async #authorized(
    task: Task,
    evidenceRead = false,
    reaction?: "read" | "write",
  ): Promise<Octokit> {
    this.#binding(task, evidenceRead);
    await this.verifyManager(task);
    const client = reaction
      ? await this.#installationClient(
          task,
          { metadata: "read", pull_requests: "read", issues: reaction },
          true,
        )
      : evidenceRead
        ? await this.#installationClient(
            task,
            {
              metadata: "read",
              contents: "read",
              pull_requests: "read",
            },
            true,
          )
        : await this.#client(task);
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
    this.#binding(task, evidenceRead);
    return client;
  }
  async #checkedClient(task: Task) {
    const client = await this.#authorized(task);
    if (task.target.kind === "pull_request") {
      await checkPull(client, task);
    } else if (task.target.kind === "issue") {
      await this.#readOpenDiscussion(client, task, task.target.number);
    }
    this.#binding(task);
    return client;
  }
  async #readOpenDiscussion(client: Octokit, task: Task, number: number) {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner: task.owner, repo: task.repo, issue_number: number },
    );
    if (
      data.number !== number ||
      data.state !== "open" ||
      (task.target.kind === "issue" && data.pull_request)
    )
      throw new AccessDenied("Issue discussion is not confirmed open");
    return data;
  }
  async resolvePullRevision(task: Task) {
    const client = await this.#authorized(task);
    const { revision } = await checkPull(client, task, true);
    this.#binding(task);
    return revision;
  }
  async authorize(task: Task): Promise<void> {
    await this.#checkedClient(task);
  }
  async #ownerReaction(task: Task, check?: () => void) {
    // Read-only lookups are permitted on closed threads, but never after a
    // binding/manager/actor change. They can only confirm an existing receipt.
    const mode = check ? "write" : "read";
    const client = await this.#authorized(task, true, mode);
    const { data: app } = await this.#app.octokit.request("GET /app");
    if (
      !app ||
      String(app.id) !== this.#config.github.appId ||
      !app.slug ||
      app.slug + "[bot]" !== this.#config.github.botLogin
    )
      throw new AccessDenied("App identity mismatch");
    const reactionId = await ownerReaction(
      client,
      task,
      this.#config.github.botLogin,
      check &&
        (async () => {
          await this.#authorized(task, true, mode);
          check();
        }),
      () => {
        this.#binding(task, true);
        check?.();
      },
    );
    if (!check) await this.#authorized(task, true, mode);
    return reactionId;
  }
  async publishOwnerReaction(task: Task, check: () => void) {
    const id = await this.#ownerReaction(task, check);
    if (!id) throw new AmbiguousExecution("Reaction not confirmed");
    return id;
  }
  lookupOwnerReaction(task: Task) {
    return this.#ownerReaction(task);
  }
  async readMergeFacts(task: Task) {
    const client = await this.#authorized(task, true);
    const facts = await collectMergeFacts(client, task, (purpose) => {
      this.#binding(task, true);
      return this.#installationClient(
        task,
        {
          metadata: "read",
          contents: "read",
          pull_requests: "read",
          ...(purpose === "classic"
            ? ({ administration: "read" } as const)
            : ({ checks: "read", statuses: "read" } as const)),
        },
        true,
      );
    });
    await this.#authorized(task, true);
    return facts;
  }
  async readPullDiff(task: Task) {
    const client = await this.#authorized(task);
    const initial = await checkPull(client, task);
    this.#binding(task);
    return collectPullDiff(client, task, initial, () => this.authorize(task));
  }
  async issueSourceGrant(task: Task, checkAssignment: () => void) {
    const checkScope = () => {
      checkAssignment();
      if (
        this.#binding(task).deepReview !== true ||
        task.target.kind !== "pull_request" ||
        task.target.revision?.headRepoId !== task.repositoryId ||
        task.target.revision.baseRepoId !== task.repositoryId
      )
        throw new AccessDenied("Deep review is not enabled for this revision");
    };
    checkScope();
    await this.authorize(task);
    checkScope();
    // Direct App-authenticated mint: never reuse or forward a cached server token.
    const permissions = { contents: "read", metadata: "read" } as const;
    const response = await this.#app.octokit
      .request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: task.installationId,
        repository_ids: [task.repositoryId],
        permissions,
        request: { redirect: "error" },
      })
      .catch(() => {
        throw Error("Source grant unavailable");
      });
    const result = z
      .object({
        token: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[!-~]+$/),
        expires_at: z.iso.datetime(),
        permissions: z.strictObject({
          contents: z.literal("read"),
          metadata: z.literal("read"),
        }),
        repository_selection: z.literal("selected"),
        repositories: z.tuple([z.object({ id: z.literal(task.repositoryId) })]),
      })
      .safeParse(response.data);
    if (!result.success)
      throw new AccessDenied("Source grant scope could not be confirmed");
    await this.authorize(task);
    checkScope();
    const remaining = Date.parse(result.data.expires_at) - Date.now();
    if (!(remaining > 0 && remaining <= 3_660_000))
      throw new AccessDenied("Source grant expiry is invalid");
    return { token: result.data.token, expiresAt: result.data.expires_at };
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
    if (task.target.kind === "pull_request") await checkPull(client, task);
    const data = await this.#readOpenDiscussion(
      client,
      task,
      task.target.number,
    );
    this.#binding(task);
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
    const client = await this.#checkedClient(task);
    if (task.target.kind === "pull_request") {
      const revision = task.target.revision!;
      const result = await readPinnedPullFile(
        client,
        this.#fetch,
        { owner: task.owner, repo: task.repo },
        revision.headSha,
        path,
      );
      await this.authorize(task);
      return { untrusted: true, revision, path, ...result };
    }
    const response = await client
      .request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: task.owner,
        repo: task.repo,
        path,
      })
      .catch((error: unknown) => {
        if (error instanceof Error && "status" in error && error.status === 404)
          return null;
        throw error;
      });
    if (!response) return { untrusted: true, unavailable: "file_unavailable" };
    const { data } = response;
    if (Array.isArray(data) || data.type !== "file")
      return { untrusted: true, unavailable: "not_a_file" };
    if (data.size > MAX_FILE)
      return { untrusted: true, unavailable: "file_too_large" };
    if (
      !("content" in data) ||
      data.encoding !== "base64" ||
      data.content.length > Math.ceil((MAX_FILE * 4) / 3) + 4096
    )
      throw new Error("Expected a file of at most 128 KiB");
    const bytes = Buffer.from(data.content, "base64");
    if (bytes.length > MAX_FILE) throw new Error("File exceeds 128 KiB");
    return {
      untrusted: true,
      path,
      content: bytes.toString("utf8"),
    };
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
    return publishDraftPullRequest(
      task,
      proposal,
      client,
      () => this.authorize(task),
      () => this.#binding(task),
    );
  }
  async publishReview(task: Task, text: string) {
    const client = await this.#authorized(task).catch(() => {
      throw new AccessDenied(
        "Review authorization unavailable before dispatch",
      );
    });
    return publishNativeReview(
      task,
      text,
      client,
      this.#config.github.botLogin,
      async () => {
        await this.authorize(task);
        if (this.#binding(task).nativeReview !== true)
          throw new AccessDenied("Native review publication is not enabled");
      },
    );
  }
  async reconcileReview(task: Task, id?: number) {
    // Only the authenticated admin resolution route calls this read-only path.
    // A retired binding/actor cannot grant another write, or prevent auditing an old one.
    if (
      task.deliveryStatus !== "unknown" ||
      task.outcome?.publication.kind !== "review" ||
      task.target.kind !== "pull_request" ||
      task.target.revision?.baseRepoId !== task.repositoryId ||
      task.target.revision?.headRepoId !== task.repositoryId ||
      (id !== undefined && (!Number.isSafeInteger(id) || id < 1)) ||
      ![task.installationId, task.repositoryId].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new AccessDenied("Invalid persisted review scope");
    const client = await this.#installationClient(task, {
      metadata: "read",
      pull_requests: "read",
    });
    const { data: repo } = await client.request("GET /repos/{owner}/{repo}", {
      owner: task.owner,
      repo: task.repo,
    });
    if (
      repo.id !== task.repositoryId ||
      repo.name !== task.repo ||
      repo.owner.login !== task.owner
    )
      throw new AccessDenied(
        "Original repository identity cannot be confirmed",
      );
    return reconcileNativeReview(
      task,
      id,
      client,
      this.#config.github.botLogin,
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
    const version =
      task.target.kind === "pull_request" && task.target.revision
        ? `\n\nPR base: ${task.target.revision.baseSha}; head: ${task.target.revision.headSha}`
        : "";
    const body = `${text}${version}\n\n${marker}`;
    if (!text.trim() || body.length > 20000)
      throw new Error(
        "Response must contain text and fit within 20000 characters",
      );
    const client = await this.#authorized(task);
    if (task.target.kind === "pull_request") {
      try {
        await checkPull(client, task);
      } catch {
        throw new AccessDenied("Cannot confirm target pull request revision");
      }
      this.#binding(task);
    }
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
        if (task.target.kind === "pull_request" && existing.body !== body)
          throw new AmbiguousExecution(
            "Cannot confirm version of existing PR comment",
          );
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
    this.#binding(task);
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
