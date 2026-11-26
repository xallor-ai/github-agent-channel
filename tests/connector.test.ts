import test from "node:test";
import assert from "node:assert/strict";
import { OpenClawConnector } from "../src/connector.js";
import { AmbiguousExecution, type Task } from "../src/contracts.js";
const task: Task = {
  id: "task-1",
  bindingId: "binding",
  prompt: "review",
  actorLogin: "alice",
  deliveryId: "delivery",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  target: { kind: "issue", number: 1 },
  source: { event: "issue_comment", action: "created", commentId: 1 },
  status: "running",
  deliveryStatus: "pending",
  error: null,
  createdAt: 1,
  outcome: null,
  runtime: null,
  publicationReceipt: null,
};
const settings = {
  type: "openclaw" as const,
  baseUrl: "http://localhost:18789",
  agentId: "github",
  tokenEnv: "RUNTIME_TOKEN",
  timeoutMs: 100,
  maxToolRounds: 3,
};
test("repository tasks expose only file reads and retain analysis without a comment", async () => {
  const requests: Array<{
    tools: Array<{ name: string }>;
    previous_response_id?: string;
  }> = [];
  const connector = new OpenClawConnector(settings, "secret", (async (
    _url,
    init,
  ) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1)
      return Response.json({
        id: "file-read",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "read_file",
            call_id: "file",
            arguments: '{"path":"README.md"}',
          },
        ],
      });
    return Response.json({
      id: "analysis",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Repository analysis" }],
        },
      ],
    });
  }) as typeof fetch);
  const invocations: string[] = [];
  const result = await connector.run(
    {
      ...task,
      target: {
        kind: "repository",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
      },
      source: { event: "push" },
    },
    async (name) => {
      invocations.push(name);
      return { content: "readme" };
    },
  );
  assert.deepEqual(invocations, ["read_file"]);
  assert.deepEqual(
    requests.map((request) => request.tools.map((tool) => tool.name)),
    [["read_file"], ["read_file"]],
  );
  assert.equal(requests[1].previous_response_id, "file-read");
  assert.equal(result.text, "Repository analysis");
  assert.deepEqual(result.publication, { kind: "none" });
});
test("repository tasks reject unsolicited issue reads before invoking cloud tools", async () => {
  const connector = new OpenClawConnector(settings, "secret", (async () =>
    Response.json({
      id: "invalid",
      status: "completed",
      output: [
        {
          type: "function_call",
          name: "read_issue",
          call_id: "issue",
          arguments: "{}",
        },
      ],
    })) as typeof fetch);
  let calls = 0;
  await assert.rejects(
    connector.run(
      { ...task, target: { kind: "repository" }, source: { event: "push" } },
      async () => {
        calls++;
        return {};
      },
    ),
    /Invalid runtime tool call/,
  );
  assert.equal(calls, 0);
});
test("returns an explicit outcome from completed assistant output and scopes session to task", async () => {
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
    artifacts: [],
    publication: { kind: "comment" },
  });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(
    calls[0].opts.headers["x-openclaw-session-key"],
    "github-channel:task-1",
  );
  assert.equal(body.model, "openclaw/github");
  assert.equal(body.input[0].role, "user");
  assert.equal(body.input[0].type, "message");
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
test("rejects a duplicate call ID after executing the first valid tool call", async () => {
  const invocations: Array<{ name: string; args: unknown }> = [];
  const connector = new OpenClawConnector(settings, "secret", (async () =>
    Response.json({
      id: "duplicate-call-id-response",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "first-call-id",
          name: "read_issue",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "first-call-id",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      ],
    })) as typeof fetch);

  await assert.rejects(
    connector.run(task, async (name, args) => {
      invocations.push({ name, args });
      return { title: "issue" };
    }),
    /Invalid runtime tool call/,
  );
  assert.deepEqual(invocations, [{ name: "read_issue", args: {} }]);
});

test("rejects an unknown tool after executing the first valid tool call", async () => {
  const invocations: Array<{ name: string; args: unknown }> = [];
  const connector = new OpenClawConnector(settings, "secret", (async () =>
    Response.json({
      id: "unknown-tool-response",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "valid-call-id",
          name: "read_issue",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "unknown-call-id",
          name: "write_issue",
          arguments: "{}",
        },
      ],
    })) as typeof fetch);

  await assert.rejects(
    connector.run(task, async (name, args) => {
      invocations.push({ name, args });
      return { title: "issue" };
    }),
    /Invalid runtime tool call/,
  );
  assert.deepEqual(invocations, [{ name: "read_issue", args: {} }]);
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

test("tool arguments must be a JSON string, not a coerced primitive", async () => {
  let invoked = false;
  const c = new OpenClawConnector(settings, "secret", (async () =>
    Response.json({
      status: "completed",
      id: "r",
      output: [
        {
          type: "function_call",
          name: "read_issue",
          call_id: "c",
          arguments: 42,
        },
      ],
    })) as typeof fetch);
  await assert.rejects(
    c.run(task, async () => {
      invoked = true;
      return {};
    }),
  );
  assert.equal(invoked, false);
});

test("malformed completed output is rejected before any tool call", async () => {
  for (const output of [
    [null],
    [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: 42 }],
      },
    ],
  ]) {
    const c = new OpenClawConnector(settings, "secret", (async () =>
      Response.json({ status: "completed", output })) as typeof fetch);
    await assert.rejects(
      c.run(task, async () => {
        throw Error("must not invoke");
      }),
      /Runtime output is invalid/,
    );
  }
});

test("completed oversized answer is a confirmed invalid response", async () => {
  const c = new OpenClawConnector(settings, "secret", async () =>
    Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "x".repeat(18001) }],
        },
      ],
    }),
  );
  await assert.rejects(
    c.run(task, async () => ({})),
    { code: "runtime_response_invalid" },
  );
});

const revision = {
  baseRepoId: 2,
  headRepoId: 2,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const pr: Task = {
  ...task,
  target: { kind: "pull_request", number: 1, revision },
};
const diff = {
  untrusted: true,
  revision,
  changedFiles: 1,
  files: [
    {
      path: "impl.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "+newImplementation()",
      patchStatus: "provided",
    },
  ],
  limitations: [],
};
const summary = {
  status: "completed",
  id: "result",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Observed at the pinned head." }],
    },
  ],
};
function call(name: string, args: unknown) {
  return {
    status: "completed",
    id: "tool",
    output: [
      {
        type: "function_call",
        call_id: "call",
        name,
        arguments: JSON.stringify(args),
      },
    ],
  };
}

test("PR first input contains the assigned diff and exposes only scoped public tools", async () => {
  let turn = 0;
  const calls: string[] = [];
  const connector = new OpenClawConnector(
    { ...settings, timeoutMs: 5000 },
    "secret",
    async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      if (!turn++) {
        assert.deepEqual(calls, ["read_pull_diff"]);
        assert.deepEqual(JSON.parse(req.input[1].content), diff);
        assert.deepEqual(
          req.tools.map((t: { name: string }) => t.name),
          ["read_issue", "read_file"],
        );
        assert.match(req.tools[1].description, /PR head/);
        return Response.json(call("read_file", { path: "impl.ts" }));
      }
      assert.match(req.input[0].output, /only-at-head/);
      return Response.json(summary);
    },
  );
  const result = await connector.run(pr, async (name, args) => {
    calls.push(name);
    if (name === "read_pull_diff") return diff;
    assert.deepEqual(args, { path: "impl.ts" });
    return { content: "only-at-head", revision };
  });
  assert.deepEqual(result.publication, { kind: "comment" });
  assert.match(result.text, /1\/1 changed files/);
  assert.ok(result.text.includes("head " + revision.headSha));
  assert.ok(result.text.includes("base " + revision.baseSha));
});

test("missing or mixed PR revision fails before dispatch to OpenClaw", async () => {
  let requests = 0;
  const connector = new OpenClawConnector(settings, "secret", async () => {
    requests++;
    return Response.json(summary);
  });
  await assert.rejects(
    connector.run(
      { ...pr, target: { kind: "pull_request", number: 1 } },
      async () => diff,
    ),
    /pinned pull request/,
  );
  await assert.rejects(
    connector.run(pr, async () => ({
      ...diff,
      revision: { ...revision, headSha: "d".repeat(40) },
    })),
    /assigned revision/,
  );
  assert.equal(requests, 0);
});

async function prepareView() {
  const sha = revision.headSha;
  const path = "unchanged.ts";
  const text = "return impl();";
  return {
    close() {},
    async read() {
      return { sha, path, text, truncated: false };
    },
    async search() {
      return { sha, matches: [{ path, line: 2, text }], truncated: false };
    },
  };
}

test("deep review searches then reads an unchanged file locally under fresh authorization", async () => {
  const calls: string[] = [];
  let turn = 0;
  const connector = new OpenClawConnector(
    { ...settings, timeoutMs: 5000 },
    "secret",
    async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      if (turn++ === 0) {
        assert.deepEqual(
          req.tools.map((t: { name: string }) => t.name),
          ["read_issue", "read_file", "search_repo"],
        );
        assert.ok(!JSON.stringify(req.input).includes("unchanged.ts"));
        return Response.json(call("search_repo", { query: "impl()" }));
      }
      const output = JSON.parse(req.input[0].output);
      if (turn === 2) {
        assert.deepEqual(output.matches, [
          { path: "unchanged.ts", line: 2, text: "return impl();" },
        ]);
        return Response.json(
          call("read_file", { path: output.matches[0].path }),
        );
      }
      assert.match(output.text, /return impl/);
      return Response.json(summary);
    },
  );
  const result = await connector
    .withReviewSource(prepareView)
    .run(
      { ...pr, reviewPolicy: { deepReview: true, nativeReview: true } },
      async (name) => {
        calls.push(name);
        if (name === "read_pull_diff") return diff;
        assert.equal(name, "review_access");
        return { authorized: true };
      },
    );
  assert.deepEqual(calls, [
    "read_pull_diff",
    "review_access",
    "review_access",
    "review_access",
    "review_access",
    "review_access",
    "review_access",
  ]);
  assert.deepEqual(result.publication, { kind: "review" });
  assert.match(result.text, /snapshot searches: 1, files read: 1/);
});

test("revocation after local search withholds results and prevents another model request", async () => {
  let grants = 0,
    requests = 0;
  const connector = new OpenClawConnector(
    { ...settings, timeoutMs: 5000 },
    "secret",
    async () => {
      requests++;
      return Response.json(call("search_repo", { query: "private" }));
    },
  );
  await assert.rejects(
    connector
      .withReviewSource(prepareView)
      .run(
        { ...pr, reviewPolicy: { deepReview: true, nativeReview: true } },
        async (name) => {
          if (name === "read_pull_diff") return diff;
          return { authorized: ++grants < 4 };
        },
      ),
    /access not confirmed/,
  );
  assert.equal(grants, 4);
  assert.equal(requests, 1);
});

test("invalid local snapshot calls are classified as model tool errors", async () => {
  for (const [name, args] of [
    ["read_source_grant", {}],
    ["search_repo", {}],
    ["search_repo", { query: "one\ntwo" }],
    ["read_file", { path: "../x" }],
    ["read_file", { path: ".Git/config" }],
    ["read_file", { path: "foo//x" }],
    ["read_file", { path: "ok", ref: "HEAD" }],
  ] as const) {
    const c = new OpenClawConnector(
      { ...settings, timeoutMs: 5000 },
      "secret",
      async () => Response.json(call(name, args)),
    );
    await assert.rejects(
      c
        .withReviewSource(prepareView)
        .run(
          { ...pr, reviewPolicy: { deepReview: true, nativeReview: true } },
          async (name) => {
            if (name === "read_pull_diff") return diff;
            assert.equal(name, "review_access");
            return { authorized: true };
          },
        ),
      { code: "tool_call_invalid" },
    );
  }
});

test("PR output preserves scope at the presentation limit and rejects oversized model answers", async () => {
  async function run(text: string) {
    const c = new OpenClawConnector(
      { ...settings, timeoutMs: 5000 },
      "secret",
      async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
        }),
    );
    return (await c.run(pr, async () => diff)).text;
  }
  for (const text of ["🌲".repeat(9000), "a" + "🌲".repeat(8999) + "z"]) {
    const result = await run(text);
    assert.ok(result.length <= 18000);
    assert.ok(result.isWellFormed());
    assert.match(result, /truncated/);
    assert.ok(result.includes("head " + revision.headSha));
    assert.ok(result.includes("base " + revision.baseSha));
    assert.match(result, /1\/1 changed files/);
  }
  await assert.rejects(run("x".repeat(18001)), {
    code: "runtime_response_invalid",
  });
});
