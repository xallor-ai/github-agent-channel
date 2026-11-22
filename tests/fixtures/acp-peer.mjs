import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
let cwd;
const app = agent({ name: "fixture" });
app.onRequest(methods.agent.initialize, () => ({
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {},
}));
app.onRequest(methods.agent.session.new, ({ params }) => {
  cwd = params.cwd;
  return { sessionId: "fixture-session" };
});
app.onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
  writeFileSync(
    join(cwd, ".git", "received-prompt.json"),
    JSON.stringify(params.prompt),
  );
  if (process.argv[2] === "crash") process.exit(3);
  if (process.argv[2] === "hang") return new Promise(() => {});
  if (process.env.CHANNEL_SECRET) throw Error("Cloud credential leaked");
  if (
    process.argv[2] === "runtime-auth" &&
    process.env.MODEL_API_KEY !== "synthetic-runtime-secret"
  )
    throw Error("Expected explicitly configured harness auth");
  if (process.argv[2] === "permission") {
    const response = await ctx.request(
      methods.client.session.requestPermission,
      {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "write", title: "Edit", status: "pending" },
        options: [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
        ],
      },
    );
    await ctx.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            response.outcome.outcome === "selected"
              ? response.outcome.optionId
              : "cancelled",
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  writeFileSync(
    join(cwd, "file.txt"),
    process.argv[2] === "bom" ? "\ufeffafter\n" : "after\n",
  );
  if (process.argv[2] === "commit") {
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "unexpected"], { cwd });
  }
  await ctx.notify(methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Edited." },
    },
  });
  return { stopReason: "end_turn" };
});
app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
