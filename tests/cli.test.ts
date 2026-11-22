import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { buildDoctorReport } from "../src/lifecycle.js";
const cli = resolve("src/cli.ts");
const tsx = resolve("node_modules/tsx/dist/cli.mjs");
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}
test("init creates an editable configuration once and refuses to overwrite it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = run(dir, "init");
  assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(join(dir, "config.local.yaml"), "utf8");
  assert.match(original, /privateKeyFile/);
  assert.notEqual(run(dir, "init").status, 0);
  assert.equal(readFileSync(join(dir, "config.local.yaml"), "utf8"), original);
  const missing = run(dir, "config", "check");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /github\.appId|server\.adminToken/);
});
test("CLI help and unsupported commands have distinct exit statuses", () => {
  assert.equal(run(process.cwd(), "--help").status, 0);
  assert.notEqual(run(process.cwd(), "erase-everything").status, 0);
});

test("doctor reads its first path argument instead of the cwd default", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-doctor-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run(dir, "init").status, 0);
  const explicit = join(dir, "explicit.yaml");
  writeFileSync(
    explicit,
    readFileSync(join(dir, "config.local.yaml"), "utf8").replace(
      "port: 3000",
      "port: -1",
    ),
  );
  const result = run(dir, "doctor", explicit);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server.port/);
});

test("doctor reports valid configuration without printing secret values", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = run(dir, "init", dir);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Created/);
  const configPath = join(dir, "config.local.yaml");
  const config = readFileSync(configPath, "utf8").replace(
    "REPLACE_WITH_APP_ID",
    "12345",
  );
  writeFileSync(configPath, config);
  writeFileSync(join(dir, "secrets", "channel-admin-token"), "admin-secret");
  writeFileSync(
    join(dir, "secrets", "github-app-private-key.pem"),
    "pem-secret",
  );
  writeFileSync(join(dir, "secrets", "github-webhook-secret"), "hook-secret");
  writeFileSync(
    join(dir, "secrets", "openclaw-gateway-token"),
    "runtime-secret",
  );
  const report = buildDoctorReport(configPath, (_command, args) => ({
    status: 0,
    stdout: `Docker Compose version v2.40.0 (${args.join(" ")})`,
  }));
  assert.equal(report.mode, "offline");
  assert.equal(report.config, "valid");
  assert.equal(report.secrets, "references-resolved");
  assert.doesNotMatch(
    JSON.stringify(report),
    /admin-secret|pem-secret|hook-secret|runtime-secret/,
  );
});
