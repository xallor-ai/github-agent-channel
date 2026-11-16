// Opt-in live check. Runs two model requests and may incur provider charges.
// Run after npm run build; never prints credentials or raw provider responses.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OpenClawConnector } from "../dist/connector.js";

const token = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token) throw Error("OPENCLAW_GATEWAY_TOKEN is required");
const config = {
  baseUrl: process.env.OPENCLAW_BASE_URL ?? "http://127.0.0.1:18789",
  agentId: process.env.OPENCLAW_AGENT_ID ?? "github",
  tokenEnv: "OPENCLAW_GATEWAY_TOKEN",
  timeoutMs: 180000,
  maxToolRounds: 4,
};
const runtime = new OpenClawConnector(config, token);
const text = await runtime.run(
  {
    id: randomUUID(),
    prompt: "Reply with exactly CHANNEL_RUNTIME_OK. Do not call any tools.",
  },
  async () => {
    throw Error("Unexpected tool");
  },
);
assert.match(text.text, /CHANNEL_RUNTIME_OK/);
console.log(JSON.stringify({ check: "real-model-text", passed: true }));
const expected = "fixture-" + randomUUID();
let reads = 0;
const tool = await runtime.run(
  {
    id: randomUUID(),
    prompt:
      "Call read_issue to obtain the current issue title. Then reply with that exact title. You cannot know it without calling the tool.",
  },
  async (name, args) => {
    assert.equal(name, "read_issue");
    assert.deepEqual(args, {});
    reads++;
    return {
      untrusted: true,
      title: expected,
      body: "Synthetic integration fixture, not live GitHub data.",
    };
  },
);
assert.ok(reads > 0);
assert.ok(tool.text.includes(expected));
console.log(
  JSON.stringify({
    check: "real-model-tool-continuation",
    passed: true,
    toolCalls: reads,
  }),
);
