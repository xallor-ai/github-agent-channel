// Real Docker acceptance test. No production credentials or public ACME requests.
// Run after npm run build. Requires a local Docker Engine and Compose v2.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import https from "node:https";
import { parse, stringify } from "yaml";
import { renderDeployment } from "../dist/deploy.js";

const root = mkdtempSync(join(tmpdir(), "channel-docker-smoke-"));
const suffix = randomBytes(6).toString("hex");
const imageName = "channel-smoke:" + suffix;
const networkName = "channel-smoke-network-" + suffix;
const projects = [];
const holders = [];
const timeout = Number(process.env.CHANNEL_SMOKE_COMMAND_TIMEOUT_MS || 600000);
let imageBuilt = false;
let networkCreated = false;
function docker(args, quiet = false) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 5_000_000,
  });
  if (result.error || result.status !== 0) {
    // This script only creates synthetic secrets; still omit unbounded provider logs.
    throw new Error(
      "docker " +
        args.slice(0, 5).join(" ") +
        " failed: " +
        (result.error?.message ?? result.stderr?.slice(-6000) ?? result.status),
    );
  }
  if (!quiet && result.stdout.trim()) console.log(result.stdout.trim());
  return result.stdout.trim();
}
function compose(path, args, quiet = false) {
  return docker(["compose", "-f", path, ...args], quiet);
}
async function freePort() {
  const server = createServer();
  await new Promise((res, rej) =>
    server.once("error", rej).listen(0, "127.0.0.1", res),
  );
  const port = server.address().port;
  await new Promise((res) => server.close(res));
  return port;
}
const hookSecret = randomBytes(32).toString("hex");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
for (const [name, value] of Object.entries({
  "app.pem": privateKey,
  hook: hookSecret,
  admin: randomBytes(32).toString("hex"),
  runtime: randomBytes(32).toString("hex"),
})) {
  // Compose file secrets preserve host ownership; root-created files must be
  // readable by the actual nonroot container. Parent directory remains 0700.
  writeFileSync(join(root, name), value, { mode: 0o644 });
  chmodSync(join(root, name), 0o644);
}
function config(mode, localPort) {
  return {
    server: { host: "127.0.0.1", port: 8765, adminTokenFile: "admin" },
    dataFile: "native.db",
    github: {
      appId: "1",
      botLogin: "smoke[bot]",
      privateKeyFile: "app.pem",
      webhookSecretFile: "hook",
    },
    runtime: {
      baseUrl: "http://127.0.0.1:9",
      tokenFile: "runtime",
      agentId: "github",
      timeoutMs: 1000,
      maxToolRounds: 1,
    },
    bindings: [],
    deployment: {
      mode,
      publicUrl: "https://smoke.example.com",
      projectName: "channel-smoke-" + mode + "-" + suffix,
      localPort,
      network: networkName,
    },
  };
}
function headers(body, valid = true, event = "ping", delivery = randomUUID()) {
  return {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": delivery,
    "x-hub-signature-256":
      "sha256=" +
      (valid
        ? createHmac("sha256", hookSecret).update(body).digest("hex")
        : "0".repeat(64)),
  };
}
function tlsRequest(
  port,
  ca,
  path,
  method = "GET",
  body,
  valid = true,
  event = "ping",
  delivery,
) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        servername: "localhost",
        path,
        method,
        ca,
        headers: {
          host: "localhost",
          ...(body ? headers(body, valid, event, delivery) : {}),
        },
        timeout: 10000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("HTTPS request timed out")));
    req.end(body);
  });
}
try {
  docker(["compose", "version"]);
  docker(["info", "--format", "{{.ServerVersion}}"]);
  docker(["network", "create", networkName]);
  networkCreated = true;
  for (const mode of ["external", "caddy"]) {
    const localPort = await freePort();
    const fixture = config(mode, localPort);
    if (mode === "external") {
      const refs = [
        [fixture.server, "adminToken", "admin"],
        [fixture.github, "privateKey", "app.pem"],
        [fixture.github, "webhookSecret", "hook"],
        [fixture.runtime, "token", "runtime"],
      ];
      for (const [section, key, file] of refs) {
        const env = "CHANNEL_SMOKE_" + key.toUpperCase();
        process.env[env] = readFileSync(join(root, file), "utf8");
        delete section[key + "File"];
        section[key + "Env"] = env;
      }
    }
    const files = renderDeployment(
      fixture,
      join(root, "config.yaml"),
      join(root, mode),
    );
    compose(files.composePath, ["config", "-q"]);
    const parsed = parse(readFileSync(files.composePath, "utf8"));
    parsed.services.channel.image = imageName;
    if (!imageBuilt) {
      docker(["build", "-t", imageName, parsed.services.channel.build.context]);
      imageBuilt = true;
    }
    delete parsed.services.channel.build;
    let tlsPort;
    let nginxPort;
    if (mode === "external") {
      const nginxConfig = join(root, "nginx.conf");
      writeFileSync(
        nginxConfig,
        "events {}\nhttp { server { listen 80;\n" +
          readFileSync(files.nginxPath, "utf8") +
          "\nlocation / { return 404; }\n} }\n",
        { mode: 0o644 },
      );
      nginxPort = await freePort();
      parsed.services.nginx = {
        image: "nginx:1.27-alpine",
        ports: ["127.0.0.1:" + nginxPort + ":80"],
        volumes: [
          {
            type: "bind",
            source: nginxConfig,
            target: "/etc/nginx/nginx.conf",
            read_only: true,
          },
        ],
        networks: ["channel"],
        depends_on: { channel: { condition: "service_healthy" } },
      };
    }
    if (mode === "caddy") {
      docker([
        "run",
        "--rm",
        "-v",
        files.caddyfilePath + ":/etc/caddy/Caddyfile:ro",
        parsed.services.caddy.image,
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ]);
      const localhostCaddy = readFileSync(files.caddyfilePath, "utf8").replace(
        "https://smoke.example.com {",
        "https://localhost {\n  tls internal",
      );
      const tlsConfig = join(root, "Caddyfile.localhost");
      writeFileSync(tlsConfig, localhostCaddy, { mode: 0o644 });
      parsed.services.caddy.volumes[0].source = tlsConfig;
      tlsPort = await freePort();
      parsed.services.caddy.ports = ["127.0.0.1:" + tlsPort + ":443"];
    }
    const testCompose = join(root, mode, "compose.smoke.yaml");
    writeFileSync(testCompose, stringify(parsed));
    projects.push(testCompose);
    compose(testCompose, ["up", "-d", "--wait", "--wait-timeout", "90"]);
    const who = compose(
      testCompose,
      ["exec", "-T", "channel", "node", "-p", "String(process.getuid())"],
      true,
    );
    assert.notEqual(who, "0", "Dockerfile must run Channel as nonroot");
    const base = "http://127.0.0.1:" + localPort;
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const body = JSON.stringify({ zen: "synthetic smoke ping" });
    const ping = await fetch(base + "/webhooks/github", {
      method: "POST",
      headers: headers(body),
      body,
    });
    assert.equal(ping.status, 200);
    assert.equal((await ping.json()).ignored, true);
    assert.equal(
      (
        await fetch(base + "/webhooks/github", {
          method: "POST",
          headers: headers(body, false),
          body,
        })
      ).status,
      400,
    );
    assert.equal((await fetch(base + "/tasks/" + randomUUID())).status, 401);
    if (mode === "external") {
      compose(testCompose, ["exec", "-T", "nginx", "nginx", "-t"]);
      const edge = "http://127.0.0.1:" + nginxPort;
      const reply = await fetch(edge + "/webhooks/github", {
        method: "POST",
        headers: headers(body),
        body,
      });
      assert.equal(reply.status, 200);
      assert.equal((await reply.json()).ignored, true);
      assert.equal(
        (
          await fetch(edge + "/webhooks/github", {
            method: "POST",
            headers: headers(body, false),
            body,
          })
        ).status,
        400,
      );
      assert.equal((await fetch(edge + "/webhooks/github")).status, 405);
      for (const path of [
        "/tasks/" + randomUUID(),
        "/healthz",
        "/webhooks/github/extra",
      ])
        assert.equal((await fetch(edge + path)).status, 404);
    }
    // Data written using node:sqlite in the actual nonroot service must survive
    // container recreation, not just a process restart.
    compose(
      testCompose,
      [
        "exec",
        "-T",
        "channel",
        "node",
        "--input-type=module",
        "-e",
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/channel.db'); db.exec(\"CREATE TABLE smoke_persistence(value TEXT); INSERT INTO smoke_persistence VALUES ('retained');\"); db.close();",
      ],
      true,
    );
    if (mode === "caddy") {
      const id = compose(testCompose, ["ps", "-q", "caddy"], true);
      const caPath = join(root, "root-ca.pem");
      // First request starts internal certificate issuance; retry only read-only
      // HTTPS health probe while the fixture CA becomes available.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          docker(
            ["cp", id + ":/data/caddy/pki/authorities/local/root.crt", caPath],
            true,
          );
          break;
        } catch (error) {
          if (attempt === 19) throw error;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      const ca = readFileSync(caPath);
      const valid = await tlsRequest(
        tlsPort,
        ca,
        "/webhooks/github",
        "POST",
        body,
      );
      assert.equal(valid.status, 200);
      assert.equal(JSON.parse(valid.text).ignored, true);
      assert.equal(
        (await tlsRequest(tlsPort, ca, "/webhooks/github", "POST", body, false))
          .status,
        400,
      );
      for (const path of [
        "/",
        "/healthz",
        "/tasks/" + randomUUID(),
        "/webhooks/github",
        "/webhooks/github/extra",
      ]) {
        assert.equal(
          (await tlsRequest(tlsPort, ca, path)).status,
          404,
          "public path must be closed: " + path,
        );
      }
      // Second phase uses production server/store/worker classes with synthetic
      // GitHub/Runtime clients, mounted outside the production image.
      parsed.services.channel.command = [
        "node",
        "/app/scripts/smoke-fixture-server.mjs",
      ];
      parsed.services.channel.volumes.push({
        type: "bind",
        source: join(
          dirname(fileURLToPath(import.meta.url)),
          "smoke-fixture-server.mjs",
        ),
        target: "/app/scripts/smoke-fixture-server.mjs",
        read_only: true,
      });
      writeFileSync(testCompose, stringify(parsed));
      compose(testCompose, [
        "up",
        "-d",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "90",
        "channel",
      ]);
      const issueBody = JSON.stringify({
        action: "created",
        installation: { id: 1 },
        repository: { id: 2, name: "fixture", owner: { login: "fixture" } },
        sender: { id: 5, login: "tester", type: "User" },
        comment: {
          id: 9,
          body: "@smoke[bot] explain this",
          user: { id: 5, login: "tester", type: "User" },
        },
        issue: { number: 3 },
      });
      const delivery = randomUUID();
      const accepted = await tlsRequest(
        tlsPort,
        ca,
        "/webhooks/github",
        "POST",
        issueBody,
        true,
        "issue_comment",
        delivery,
      );
      assert.equal(accepted.status, 202);
      const receipt = JSON.parse(accepted.text);
      const adminToken = readFileSync(join(root, "admin"), "utf8");
      let task;
      for (let attempt = 0; attempt < 50; attempt++) {
        task = await (
          await fetch(base + "/tasks/" + receipt.taskId, {
            headers: { Authorization: "Bearer " + adminToken },
          })
        ).json();
        if (task.deliveryStatus === "sent") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(task.status, "succeeded");
      assert.equal(task.deliveryStatus, "sent");
      const replay = await tlsRequest(
        tlsPort,
        ca,
        "/webhooks/github",
        "POST",
        issueBody,
        true,
        "issue_comment",
        delivery,
      );
      assert.equal(replay.status, 202);
      assert.deepEqual(JSON.parse(replay.text), {
        taskId: receipt.taskId,
        duplicate: true,
      });
      const publications = compose(
        testCompose,
        [
          "exec",
          "-T",
          "channel",
          "node",
          "--input-type=module",
          "-e",
          "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/channel.db');console.log(db.prepare('SELECT count(*) AS n FROM smoke_publications').get().n);db.close();",
        ],
        true,
      );
      assert.equal(publications, "1");
      console.log(
        JSON.stringify({
          syntheticWorkerE2E: "passed",
          signedIssueComment: true,
          duplicatePublicationCount: 1,
        }),
      );
    }
    if (mode === "external") {
      // Force a new backend IP without restarting the existing Nginx process.
      // A literal proxy_pass resolved only at startup fails this regression.
      const gatewayId = compose(testCompose, ["ps", "-q", "nginx"], true);
      const oldChannelId = compose(testCompose, ["ps", "-q", "channel"], true);
      const oldInspect = JSON.parse(docker(["inspect", oldChannelId], true))[0];
      const oldIp = oldInspect.NetworkSettings.Networks[networkName].IPAddress;
      compose(testCompose, ["stop", "channel"]);
      compose(testCompose, ["rm", "-f", "channel"]);
      const holder = "channel-smoke-holder-" + suffix;
      holders.push(holder);
      docker([
        "run",
        "-d",
        "--name",
        holder,
        "--network",
        networkName,
        "--ip",
        oldIp,
        imageName,
        "node",
        "-e",
        "setInterval(()=>{},60000)",
      ]);
      compose(testCompose, [
        "up",
        "-d",
        "--no-deps",
        "--wait",
        "--wait-timeout",
        "90",
        "channel",
      ]);
      const newChannelId = compose(testCompose, ["ps", "-q", "channel"], true);
      const newInspect = JSON.parse(docker(["inspect", newChannelId], true))[0];
      const newIp = newInspect.NetworkSettings.Networks[networkName].IPAddress;
      assert.notEqual(newIp, oldIp, "fixture must force changed Channel IP");
      assert.equal(
        compose(testCompose, ["ps", "-q", "nginx"], true),
        gatewayId,
        "gateway must remain running",
      );
      let refreshed = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const reply = await fetch(
            "http://127.0.0.1:" + nginxPort + "/webhooks/github",
            {
              method: "POST",
              headers: headers(body),
              body,
              signal: AbortSignal.timeout(2000),
            },
          );
          if (reply.status === 200 && (await reply.json()).ignored === true) {
            refreshed = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(
        refreshed,
        true,
        "unchanged Nginx must resolve the replaced backend within DNS TTL",
      );
      console.log(
        JSON.stringify({
          nginxBackendIpRefresh: "passed",
          oldIp,
          newIp,
          gatewayUnchanged: true,
        }),
      );
    }
    compose(testCompose, [
      "up",
      "-d",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "90",
      "channel",
    ]);
    const retained = compose(
      testCompose,
      [
        "exec",
        "-T",
        "channel",
        "node",
        "--input-type=module",
        "-e",
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/channel.db'); console.log(db.prepare('SELECT value FROM smoke_persistence').get().value); db.close();",
      ],
      true,
    );
    assert.equal(retained, "retained");
    console.log(
      JSON.stringify({
        mode,
        result: "passed",
        nonrootUid: who,
        composeValidated: true,
        signedWebhook: true,
        sqliteSurvivesRecreate: true,
        tls: mode === "caddy" ? "verified-local-ca" : "not-applicable",
      }),
    );
  }
  console.log(
    "Docker deployment smoke passed. Public ACME and live GitHub were not exercised.",
  );
} finally {
  let cleanupOk = true;
  for (const path of projects.reverse()) {
    try {
      compose(path, ["down", "-v", "--remove-orphans"]);
    } catch (error) {
      cleanupOk = false;
      console.error("Fixture cleanup failed: " + error.message);
    }
  }
  for (const holder of holders) {
    try {
      docker(["rm", "-f", holder]);
    } catch {
      cleanupOk = false;
    }
  }
  if (imageBuilt) {
    try {
      docker(["image", "rm", imageName]);
    } catch {
      cleanupOk = false;
    }
  }
  if (networkCreated) {
    try {
      docker(["network", "rm", networkName]);
    } catch {
      cleanupOk = false;
    }
  }
  if (cleanupOk) rmSync(root, { recursive: true, force: true });
  else {
    console.error("Retained isolated fixture directory for cleanup: " + root);
    process.exitCode = 1;
  }
}
