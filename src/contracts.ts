export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'unknown';
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
export interface Binding {
  id: string; installationId: number; repositoryId: number;
  owner: string; repo: string; enabled: boolean;
}
export interface ChannelConfig {
  server: { host: string; port: number; adminTokenEnv: string };
  dataFile: string;
  github: { appId: string; privateKeyEnv: string; webhookSecretEnv: string; botLogin: string };
  runtime: { baseUrl: string; tokenEnv: string; agentId: string; timeoutMs: number; maxToolRounds: number };
  bindings: Binding[];
}
export interface NewTask {
  deliveryId: string; commentId: number; bindingId: string;
  installationId: number; repositoryId: number; owner: string; repo: string;
  actorId: number; actorLogin: string; issueNumber: number; prompt: string;
}
export interface Task extends NewTask {
  id: string; status: TaskState; deliveryStatus: DeliveryState;
  result: string | null; error: string | null; createdAt: number;
  responseId: string | null; commentUrl: string | null;
}
export type ToolInvoker = (name: string, args: unknown) => Promise<unknown>;
export interface RuntimeResult { text: string; responseId?: string }
export interface RuntimeConnector {
  run(task: Task, invoke: ToolInvoker, signal?: AbortSignal): Promise<RuntimeResult>;
}
export interface GitHubClient {
  authorize(task: Task): Promise<void>;
  readIssue(task: Task): Promise<unknown>;
  readFile(task: Task, path: string): Promise<unknown>;
  publish(task: Task, text: string): Promise<{ id: number; url: string }>;
}
export class AccessDenied extends Error {}
export class AmbiguousExecution extends Error {}
