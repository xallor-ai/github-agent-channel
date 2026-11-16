import test from "node:test";
import assert from "node:assert/strict";
import { OpenClawConnector } from "../src/connector.js";
import { AmbiguousExecution, type Task } from "../src/contracts.js";
const task = {
  id: "task-1",
  bindingId: "binding",
  prompt: "review",
  actorLogin: "alice",
} as Task;
const settings = {
  baseUrl: "http://localhost:18789",
  agentId: "github",
  tokenEnv: "RUNTIME_TOKEN",
  timeoutMs: 100,
  maxToolRounds: 3,
};
test("returns text only from completed assistant output and scopes session to task", async () => {
  const calls: any[] = [];
  const fetcher = async (url: any, opts: any) => {
    calls.push({ url, opts });
    return Response.json({
      id: "resp1",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
    });
  };
  const connector = new OpenClawConnector(
    settings,
    "secret",
    fetcher as typeof fetch,
  );
  assert.deepEqual(await connector.run(task, async () => null), {
    text: "done",
    responseId: "resp1",
  });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(
    calls[0].opts.headers["x-openclaw-session-key"],
    "github-channel:task-1",
  );
  assert.equal(body.model, "openclaw/github");
  assert.equal(body.input[0].role, "user");
});
test("executes client tools and continues with matching response and call IDs", async () => {
  const bodies: any[] = [];
  const invocations: any[] = [];
  const fetcher = async (_: any, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? Response.json({
          id: "r1",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "c1",
              name: "read_issue",
              arguments: "{}",
            },
          ],
        })
      : Response.json({
          id: "r2",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "analysis" }],
            },
          ],
        });
  };
  const result = await new OpenClawConnector(
    settings,
    "secret",
    fetcher as typeof fetch,
  ).run(task, async (name, args) => {
    invocations.push({ name, args });
    return { title: "issue" };
  });
  assert.equal(result.text, "analysis");
  assert.deepEqual(invocations, [{ name: "read_issue", args: {} }]);
  assert.equal(bodies[1].previous_response_id, "r1");
  assert.equal(bodies[1].input[0].call_id, "c1");
});
test("unknown tools, incomplete status and malformed arguments do not succeed", async () => {
  for (const response of [
    { status: "incomplete", output: [] },
    {
      status: "completed",
      id: "r",
      output: [
        { type: "function_call", name: "push", call_id: "c", arguments: "{}" },
      ],
    },
    {
      status: "completed",
      id: "r",
      output: [
        {
          type: "function_call",
          name: "read_issue",
          call_id: "c",
          arguments: "invalid",
        },
      ],
    },
  ]) {
    const connector = new OpenClawConnector(settings, "secret", (async () =>
      Response.json(response)) as typeof fetch);
    await assert.rejects(() =>
      connector.run(task, async () => {
        throw Error("must not run");
      }),
    );
  }
});
test("transport interruption is ambiguous, not retried", async () => {
  let count = 0;
  const connector = new OpenClawConnector(settings, "secret", (async () => {
    count++;
    throw Error("connection lost");
  }) as typeof fetch);
  await assert.rejects(
    () => connector.run(task, async () => null),
    AmbiguousExecution,
  );
  assert.equal(count, 1);
});
test("non-final output must not be mistaken for final answer", async () => {
  const c = new OpenClawConnector(settings, "secret", (async () =>
    Response.json({
      id: "r",
      status: "completed",
      output: [{ type: "reasoning", text: "secret reasoning" }],
    })) as typeof fetch);
  await assert.rejects(() => c.run(task, async () => null), /no final/);
});
test("bound tool rounds terminate a tool-only loop", async () => {
  let count = 0;
  const c = new OpenClawConnector(
    { ...settings, maxToolRounds: 2 },
    "secret",
    (async () => {
      count++;
      return Response.json({
        id: "r" + count,
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "read_issue",
            call_id: "c" + count,
            arguments: "{}",
          },
        ],
      });
    }) as typeof fetch,
  );
  await assert.rejects(() => c.run(task, async () => ({})), /round limit/);
  assert.equal(count, 2);
});

test("timeout and nonterminal runtime responses remain ambiguous", async () => {
  for (const response of [
    new Response("", { status: 408 }),
    Response.json({ status: "queued" }),
    Response.json({ status: "in_progress" }),
    Response.json({ status: "unexpected" }),
  ]) {
    const c = new OpenClawConnector(
      settings,
      "secret",
      (async () => response) as typeof fetch,
    );
    await assert.rejects(
      () => c.run(task, async () => null),
      AmbiguousExecution,
    );
  }
});
