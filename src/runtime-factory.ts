import { AcpConnector } from "./acp-connector.js";
import { agentSecrets, type AgentConfig } from "./agent-config.js";
import { OpenClawConnector } from "./connector.js";
import type { RuntimeConnector } from "./contracts.js";
export function createRuntime(
  config: AgentConfig,
  configPath: string,
): RuntimeConnector {
  if (config.runtime.type === "acp")
    return new AcpConnector(config.runtime, configPath);
  if (config.runtime.type !== "openclaw") throw Error("Unknown runtime type");
  return new OpenClawConnector(
    config.runtime,
    agentSecrets(config, configPath).runtime,
  );
}
