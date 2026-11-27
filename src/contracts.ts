import type { MergeFacts } from "./merge-assessment.js";
import type { runtimeEventSchema } from "./outcomes.js";
import type { z } from "zod";

export type TaskState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "unknown";
export type DeliveryState =
  | "pending"
  | "sending"
  | "sent"
  | "skipped"
  | "failed"
  | "unknown";
export interface Binding {
  id: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  repo: string;
  enabled: boolean;
  events: string[];
  nativeReview?: boolean;
  deepReview?: boolean;
  autoTriage?: boolean;
  autoReview?: boolean;
  responsibleAgent?: import("./runtime-profile.js").RuntimeProfile;
  triggerLabel?: string;
  writePolicy?: {
    baseBranch: string;
    allowedPaths: string[];
    maxFiles?: number;
    maxBytes?: number;
  };
}
export interface ChannelConfig {
  server: {
    host: string;
    port: number;
    adminTokenEnv?: string;
    adminTokenFile?: string;
  };
  dataFile: string;
  github: {
    appId: string;
    privateKeyEnv?: string;
    privateKeyFile?: string;
    webhookSecretEnv?: string;
    webhookSecretFile?: string;
    botLogin: string;
  };
  connector: {
    timeoutMs: number;
  };
  writeProfiles?: Array<{
    installationId: number;
    repositoryId: number;
    policy: NonNullable<Binding["writePolicy"]>;
  }>;
  deployment?: {
    mode: "external" | "caddy";
    publicUrl?: string;
    network?: string;
    projectName?: string;
    localPort?: number;
    image?: string;
  };
}
export interface ResolvedSecrets {
  adminToken: string;
  privateKey: string;
  webhookSecret: string;
}
export interface NewTask {
  deliveryId: string;
  bindingId: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  repo: string;
  actorId: number;
  actorLogin: string;
  prompt: string;
  target: GitHubTarget;
  source: { event: string; action?: string; commentId?: number };
}
export interface PullRevision {
  baseSha: string;
  headSha: string;
  baseRepoId: number;
  headRepoId: number;
}
export type GitHubTarget =
  | { kind: "issue"; number: number }
  | { kind: "pull_request"; number: number; revision?: PullRevision }
  | { kind: "repository"; ref?: string; sha?: string };
export type ChangedFile = { path: string; content: string | null };
export type Artifact =
  | { kind: "text"; name: string; text: string }
  | { kind: "link"; name: string; url: string }
  | {
      kind: "test_report";
      name: string;
      command: string;
      exitCode: number | null;
      summary: string;
    }
  | { kind: "change_set"; name: string; baseSha: string; files: ChangedFile[] };
export type PublicationRequest =
  | { kind: "clarification" }
  | { kind: "comment"; expectedBaseRef?: string }
  | { kind: "review"; expectedBaseRef?: string }
  | { kind: "none" }
  | {
      kind: "pull_request";
      title: string;
      body: string;
      baseBranch: string;
      baseSha: string;
      files: ChangedFile[];
    };
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type PublicationReceipt = {
  kind: "comment" | "pull_request" | "review";
  id?: number;
  url: string;
  createdAt?: number;
};
export interface Task extends NewTask {
  previousReview?: import("./review-input.js").PriorReview;
  continuation?: {
    rootTaskId: string;
    questionTaskId: string;
    originalPrompt: string;
    history: { question: string; answer: string }[];
    question: string;
  };
  questionChoices?: string[];
  // Attached by the server only after authorizing the claim.
  reviewPolicy?: { deepReview: boolean; nativeReview: boolean };
  threadContext?: Array<{
    actor: string;
    event: string;
    excerpt: string;
    truncated: boolean;
  }>;
  id: string;
  status: TaskState;
  deliveryStatus: DeliveryState;
  error: string | null;
  createdAt: number;
  publicationReceipt: PublicationReceipt | null;
  outcome: RuntimeResult | null;
  runtime: RuntimeEvent | null;
}
export type ToolInvoker = (name: string, args: unknown) => Promise<unknown>;
export interface RuntimeResult {
  text: string;
  responseId?: string;
  artifacts: Artifact[];
  publication: PublicationRequest;
}
export interface RuntimeConnector {
  run(
    task: Task,
    invoke: ToolInvoker,
    signal?: AbortSignal,
    onEvent?: (event: RuntimeEvent) => Promise<void>,
  ): Promise<RuntimeResult>;
}
export interface GitHubClient {
  publishClarification?(
    task: Task,
  ): Promise<{ id: number; url: string; createdAt: number }>;
  reconcileClarification?(
    task: Task,
  ): Promise<{ id: number; url: string; createdAt: number }>;
  publishOwnerReaction?(task: Task, check: () => void): Promise<number>;
  lookupOwnerReaction?(task: Task): Promise<number | null>;
  reconcileOwnerReaction?(task: Task): Promise<number | null>;
  authorize(task: Task): Promise<void>;
  resolvePullRevision?(task: Task): Promise<PullRevision>;
  readPullDiff?(task: Task): Promise<unknown>;
  readMergeFacts?(task: Task): Promise<MergeFacts>;
  issueSourceGrant?(
    task: Task,
    checkAssignment: () => void,
  ): Promise<{ token: string; expiresAt: string }>;
  publishReview?(
    task: Task,
    text: string,
  ): Promise<{ id: number; url: string }>;
  reconcileReview?(
    task: Task,
    id?: number,
  ): Promise<{ id: number; url: string }>;
  readIssue(task: Task): Promise<unknown>;
  // Authorize the target, then check the live assignment before fetching any file data.
  readFile(
    task: Task,
    path: string,
    checkAssignment: () => void,
  ): Promise<unknown>;
  publishComment(
    task: Task,
    text: string,
  ): Promise<{ id: number; url: string }>;
  publishPullRequest(
    task: Task,
    request: Extract<PublicationRequest, { kind: "pull_request" }>,
  ): Promise<{ id: number; url: string }>;
}
export class AccessDenied extends Error {}
export class PullTargetRejected extends AccessDenied {
  constructor(
    readonly reason:
      | "pr_open_unconfirmed"
      | "pr_outside_binding"
      | "pr_review_generation_changed"
      | "pr_revision_changed",
    readonly observedRevision?: PullRevision,
    readonly observedGithubAt?: number,
  ) {
    super(reason);
  }
}
export function isAutomaticReview(
  task: Pick<Task, "target" | "source">,
): boolean {
  return (
    task.source.event === "pull_request" &&
    (task.source.action === "opened" || task.source.action === "synchronize") &&
    task.target.kind === "pull_request"
  );
}
export function observedReviewDrift(task: Task, error: unknown) {
  return isAutomaticReview(task) &&
    error instanceof PullTargetRejected &&
    error.reason === "pr_revision_changed" &&
    error.observedRevision
    ? { revision: error.observedRevision, githubAt: error.observedGithubAt }
    : undefined;
}
export class AmbiguousExecution extends Error {}

export type BindingLookup = (
  installationId: number,
  repositoryId: number,
) => Binding | undefined;
