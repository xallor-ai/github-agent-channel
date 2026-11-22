export const cloudExample = `# ECS: no OpenClaw URL or model token belongs here.
server:
  host: 127.0.0.1
  port: 3000
  adminTokenFile: secrets/channel-admin-token
dataFile: ./data/channel.db
github:
  appId: "REPLACE_WITH_APP_ID"
  privateKeyFile: secrets/github-app-private-key.pem
  webhookSecretFile: secrets/github-webhook-secret
  botLogin: your-app[bot]
connector:
  workerId: local-openclaw
  tokenFile: secrets/connector-token
  timeoutMs: 300000
bindings: []
# - id: example
#   installationId: 123
#   repositoryId: 456
#   owner: example-org
#   repo: example-repo
#   enabled: true
deployment:
  mode: external
  publicUrl: https://channel.example.com
`;

export const agentExample = `# Internal network: makes outbound HTTPS connections only.
channel:
  baseUrl: https://channel.example.com
  tokenFile: secrets/connector-token
runtime:
  type: openclaw
  baseUrl: http://127.0.0.1:18789
  tokenFile: secrets/openclaw-gateway-token
  agentId: github
  timeoutMs: 180000
  maxToolRounds: 8
stateFile: ./data/agent.db
pollIntervalMs: 2000
requestTimeoutMs: 15000
# Container deployments can join the existing OpenClaw Docker network:
# deployment:
#   network: openclaw_default
# Then set runtime.baseUrl to http://<OpenClaw container alias>:18789
`;
