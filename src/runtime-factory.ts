import { AcpConnector } from "./acp-connector.js";
import type { AgentConfig } from "./agent-config.js";
import { OpenClawConnector } from "./connector.js";
import type { RuntimeConnector } from "./contracts.js";
export function createRuntime(
  runtime: AgentConfig["runtime"],
  configPath: string,
  token?: string,
): RuntimeConnector {
  if (runtime.type === "acp") return new AcpConnector(runtime, configPath);
  if (runtime.type !== "openclaw") throw Error("Unknown runtime type");
  if (!token?.trim()) throw Error("OpenClaw runtime token is required");
  return new OpenClawConnector(runtime, token);
}
