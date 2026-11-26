import { Octokit } from "@octokit/core";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clarificationComment } from "../src/github-clarification.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type Task,
} from "../src/contracts.js";

const task = {
  id: "12345678-1234-4123-8123-123456789abc",
  owner: "org",
  repo: "example",
  repositoryId: 1,
  actorId: 9,
  target: {
    kind: "pull_request",
    number: 7,
    revision: {
      baseRepoId: 1,
      headRepoId: 1,
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
    },
  },
  source: { event: "issue_comment", action: "created", commentId: 13 },
  outcome: {
    text: "Which reproduction?",
    artifacts: [],
    publication: { kind: "clarification" },
  },
} as Task;
const issue_url = "https://api.github.com/repos/org/example/issues/7";
const bot = "helper[bot]";
function fixture() {
  let writes = 0,
    creation = 201,
    sourceId = 9;
  let posted: {
    id: number;
    body: string;
    issue_url: string;
    html_url: string;
    created_at: string;
    user: { login: string; type: string };
  }[] = [];
  const client = new Octokit({
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: {
      fetch: async (input: string, init: RequestInit) => {
        const path = new URL(input).pathname;
        if (init.method === "POST") {
          writes++;
          assert.equal(path, "/repos/org/example/issues/7/comments");
          const row = {
            id: 11,
            body: JSON.parse(String(init.body)).body,
            issue_url,
            html_url: "https://github.com/org/example/pull/7#issuecomment-11",
            created_at: "2026-11-26T11:00:00Z",
            user: { login: bot, type: "Bot" },
          };
          if (creation === 201 || creation === 503) posted.push(row);
          return Response.json(row, { status: creation });
        }
        if (path.endsWith("/issues/comments/13"))
          return Response.json({
            id: 13,
            user: { id: sourceId, type: "User" },
            issue_url,
          });
        assert.equal(path, "/repos/org/example/issues/7/comments");
        return Response.json(posted);
      },
    },
  });
  return {
    run: (w?: () => Promise<void>) =>
      clarificationComment(client, task, bot, w),
    writes: () => writes,
    rows: () => posted,
    setStatus: (s: number) => {
      creation = s;
    },
    wrongSource: () => {
      sourceId = 11;
    },
  };
}
test("question creation verifies originating user/thread, version and unique bot receipt; unknown POST is reconciled by a GET", async () => {
  const f = fixture();
  f.setStatus(503);
  await assert.rejects(
    f.run(async () => {}),
    AmbiguousExecution,
  );
  const receipt = await f.run();
  assert.equal(receipt.createdAt, Date.parse("2026-11-26T11:00:00Z"));
  assert.equal(receipt.id, 11);
  assert.equal(f.writes(), 1);
  const row = f.rows()[0];
  assert.ok(row.body.includes("/answer " + task.id));
  assert.ok(row.body.includes("head: " + "b".repeat(40)));
  const other = { ...row, user: { type: "Bot", login: "other[bot]" } };
  f.rows().push(other);
  assert.deepEqual(await f.run(), receipt);
  f.rows().push({ ...row, id: 12 });
  await assert.rejects(f.run(), AmbiguousExecution);
  f.rows().pop();
  row.body = "Edited question\n\n<!-- github-agent-channel:" + task.id + " -->";
  await assert.rejects(f.run(), AmbiguousExecution);
  assert.equal(f.writes(), 1);
});
test("different source actor, revoked final authorization or explicit 4xx cannot open a question", async () => {
  const wrong = fixture();
  wrong.wrongSource();
  await assert.rejects(
    wrong.run(async () => {}),
    AccessDenied,
  );
  assert.equal(wrong.writes(), 0);
  const denied = fixture();
  await assert.rejects(
    denied.run(async () => {
      throw new AccessDenied("revoked");
    }),
    AccessDenied,
  );
  assert.equal(denied.writes(), 0);
  await assert.rejects(denied.run(), AmbiguousExecution);
  denied.setStatus(422);
  await assert.rejects(
    denied.run(async () => {}),
    AccessDenied,
  );
});
