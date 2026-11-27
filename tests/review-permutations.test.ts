import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/store.js";
import { seedBinding } from "./binding-fixture.js";

function* arrangements(
  rest: number[],
  prefix: number[] = [],
): Generator<number[]> {
  if (!rest.length) {
    yield prefix;
    return;
  }
  for (const n of rest)
    yield* arrangements(
      rest.filter((i) => i !== n),
      [...prefix, n],
    );
}

test("all 120 delivery orders of A→B→A→B→A leave a single publishable final A and preserve redeliveries", () => {
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const event = (i: number, bindingId: string) => ({
    reason: "review" as const,
    execute: true as const,
    githubTime: 1000 * (i + 1),
    input: {
      ...scope,
      bindingId,
      deliveryId: "delivery-" + i,
      prompt: "review",
      actorId: 42,
      actorLogin: "alice",
      source: { event: "pull_request", action: i ? "synchronize" : "opened" },
      target: {
        kind: "pull_request" as const,
        number: 7,
        revision: {
          baseSha: "a".repeat(40),
          headSha: (i % 2 ? "c" : "b").repeat(40),
          baseRepoId: 2,
          headRepoId: 2,
        },
      },
    },
  });
  for (const order of arrangements([0, 1, 2, 3, 4])) {
    const s = new TaskStore(":memory:");
    try {
      const b = seedBinding(s, scope, "device", [
        "pull_request.opened",
        "pull_request.synchronize",
      ]);
      const ids = new Set<string>();
      for (const i of order) {
        const r = s.observe(event(i, b.id));
        if (i % 2 === 0 && r.taskId) ids.add(r.taskId);
      }
      const head = s.activityReceipt("delivery-4")?.taskId;
      assert.ok(head, "missing latest task for " + order);
      assert.equal(
        s.get(head)?.deliveryId,
        "delivery-4",
        "current A attributed to an older generation for " + order,
      );
      for (const i of [0, 2, 4]) {
        const receipt = s.activityReceipt("delivery-" + i);
        if (receipt?.taskId) ids.add(receipt.taskId);
        assert.equal(
          s.observe(event(i, b.id)).taskId,
          receipt?.taskId,
          "redelivery changed task for " + order,
        );
      }
      assert.deepEqual(
        [...ids].filter(
          (id) => s.publicationAllowed(id) && s.reviewPublicationCurrent(id),
        ),
        [head],
        "old A may publish or current A blocked for " + order,
      );
    } finally {
      s.close();
    }
  }
});
