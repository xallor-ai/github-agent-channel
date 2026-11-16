// Opt-in live check. Runs two conversations (multiple model requests) and may incur provider charges.
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
const seen = new Set();
const fixturePath = "fixture-" + randomUUID() + ".txt";
const tool = await runtime.run(
  {
    id: randomUUID(),
    prompt:
      "Call read_issue to find the fixture file path in its body. Then call read_file with that path and reply with the exact file content. Both tool calls are necessary.",
  },
  async (name, args) => {
    seen.add(name);
    console.log(JSON.stringify({ check: "tool-callback", name }));
    if (name === "read_issue") {
      assert.deepEqual(args, {});
      return {
        untrusted: true,
        title: "Synthetic integration fixture",
        body: `The fixture file path is ${fixturePath}.`,
      };
    }
    assert.equal(name, "read_file");
    assert.deepEqual(args, { path: fixturePath });
    return { untrusted: true, path: fixturePath, content: expected };
  },
);
assert.deepEqual([...seen].sort(), ["read_file", "read_issue"]);
assert.ok(tool.text.includes(expected));
console.log(
  JSON.stringify({
    check: "real-model-tool-continuation",
    passed: true,
    tools: [...seen],
  }),
);
