import test from "node:test";
import assert from "node:assert/strict";
import {
  composeArgs,
  detectComposeVersion,
  runComposeLifecycle,
} from "../src/lifecycle.js";

test("maps lifecycle actions to modern Docker Compose commands", () => {
  assert.deepEqual(composeArgs("up", ".channel/compose.yaml"), [
    "compose",
    "-f",
    ".channel/compose.yaml",
    "up",
    "-d",
    "--build",
    "--wait",
  ]);
  assert.deepEqual(composeArgs("status", ".channel/compose.yaml"), [
    "compose",
    "-f",
    ".channel/compose.yaml",
    "ps",
  ]);
  assert.deepEqual(composeArgs("down", ".channel/compose.yaml"), [
    "compose",
    "-f",
    ".channel/compose.yaml",
    "down",
  ]);
});

test("requires the Docker Compose v2 plugin and never falls back to legacy binary", () => {
  assert.throws(
    () => detectComposeVersion(() => ({ status: 1 })),
    /v2 plugin.*legacy/,
  );
  const calls: string[][] = [];
  const status = runComposeLifecycle(
    "up",
    "/tmp/compose.yaml",
    (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "Docker Compose version v2.40.0" };
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ["compose", "version"],
    ["compose", "-f", "/tmp/compose.yaml", "up", "-d", "--build", "--wait"],
  ]);
});

test("lifecycle propagates failed Docker exit status", () => {
  let count = 0;
  const result = runComposeLifecycle("status", "/tmp/compose.yaml", () => {
    count++;
    return count === 1
      ? { status: 0, stdout: "Docker Compose version v2.40.0" }
      : { status: 17 };
  });
  assert.equal(result, 17);
});

test("rejects legacy or malformed Compose version even when probe exits zero", () => {
  for (const stdout of [
    "Docker Compose version v1.29.2",
    "Docker Compose version v2.5.0",
    "unexpected output",
  ])
    assert.throws(
      () => detectComposeVersion(() => ({ status: 0, stdout })),
      /Compose/,
    );
  assert.equal(
    detectComposeVersion(() => ({
      status: 0,
      stdout: "Docker Compose version v5.1.1",
    })),
    "Docker Compose version v5.1.1",
  );
});
