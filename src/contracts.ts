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
  requireMention?: boolean;
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
export type GitHubTarget =
  | { kind: "issue" | "pull_request"; number: number }
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
  | { kind: "comment" }
  | { kind: "none" }
  | {
      kind: "pull_request";
      title: string;
      body: string;
      baseBranch: string;
      baseSha: string;
      files: ChangedFile[];
    };
export type RuntimeEvent = { kind: "started"; runId: string; provider: string };
export type PublicationReceipt = {
  kind: "comment" | "pull_request";
  id?: number;
  url: string;
};
export interface Task extends NewTask {
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
  authorize(task: Task): Promise<void>;
  readIssue(task: Task): Promise<unknown>;
  readFile(task: Task, path: string): Promise<unknown>;
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
export class AmbiguousExecution extends Error {}
export type RuntimeFailureCode =
  | "tool_round_limit"
  | "no_final_answer"
  | "runtime_timeout"
  | "runtime_transport"
  | "runtime_response_invalid"
  | "tool_call_invalid"
  | "tool_call_failed";

export type BindingLookup = (
  installationId: number,
  repositoryId: number,
) => Binding | undefined;
