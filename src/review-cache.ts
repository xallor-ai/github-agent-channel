import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Task } from "./contracts.js";
import { gitEnvironment } from "./runtime-workspace.js";

const oid = /^[0-9a-f]{40}$/;
const diskLimit = 1024 ** 3;
const git = (process.env.PATH ?? "")
  .split(delimiter)
  .filter(isAbsolute)
  .map((p) => join(p, process.platform === "win32" ? "git.exe" : "git"))
  .find(existsSync);
const unavailable = () => Error("Review cache Git operation unavailable");
type Grant = () => Promise<{ token: string; expiresAt: string }>;
type Transfer = (
  dir: string,
  url: string,
  sha: string,
  token: string,
  signal: AbortSignal,
) => Promise<void>;

function run(dir: string, args: string[], signal: AbortSignal, auth?: string) {
  signal.throwIfAborted();
  if (!git) throw unavailable();
  const env = gitEnvironment();
  env.GIT_ALLOW_PROTOCOL = "https";
  if (auth) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
    env.GIT_CONFIG_VALUE_0 =
      "Authorization: Basic " +
      Buffer.from("x-access-token:" + auth).toString("base64");
  }
  return new Promise<string>((ok, fail) => {
    const child = execFile(
      git!,
      [
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "core.hooksPath=" +
          (process.platform === "win32" ? "NUL" : "/dev/null"),
        "-c",
        "gc.auto=0",
        "-c",
        "fetch.fsckObjects=true",
        "-c",
        "fetch.unpackLimit=1",
        "--git-dir",
        dir,
        ...args,
      ],
      {
        cwd: dir,
        env,
        signal,
        timeout: 90000,
        windowsHide: true,
        maxBuffer: 65536,
      },
      (err, stdout) => {
        if (
          err &&
          auth &&
          (signal.aborted || err.killed || typeof err.code !== "number")
        )
          return fail(new UnconfirmedGitExit());
        if (err) fail(unavailable());
        else ok(stdout.trim());
      },
    );
    child.stdin?.end();
  });
}
const fetchMarker = ".fetch-in-flight";
class UnconfirmedGitExit extends Error {}
const transfer: Transfer = async (dir, url, sha, token, signal) => {
  const marker = join(dirname(dir), fetchMarker);
  await writeFile(marker, basename(dir), { flag: "wx", mode: 0o600 });
  try {
    await run(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
        url,
        sha + ":refs/heads/h" + sha,
      ],
      signal,
      token,
    );
  } catch (error) {
    if (!(error instanceof UnconfirmedGitExit)) await rm(marker);
    throw error;
  }
  await rm(marker);
};

function cacheConfig(url: string) {
  return (
    '[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tlogallrefupdates = false\n[remote "origin"]\n\turl = ' +
    url +
    "\n"
  );
}
const head = "ref: refs/heads/unused\n";
const allowedDir =
  /^(objects|objects\/(info|pack|[a-f0-9]{2})|refs|refs\/(heads|tags))$/;
const allowedFile =
  /^(channel-scope|config|HEAD|shallow|refs\/heads\/h[0-9a-f]{40}|objects\/[0-9a-f]{2}\/[0-9a-f]{38}|objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx|rev))$/;

async function privateDir(dir: string) {
  if ((await realpath(dir)) !== dir)
    throw Error("Review cache requires a real directory");
  const s = await lstat(dir);
  if (
    !s.isDirectory() ||
    (process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077) !== 0))
  )
    throw Error("Review cache requires an owner-private directory");
}

// Inspect files without asking Git to parse any existing repository configuration.
async function walk(
  dir: string,
  signal: AbortSignal,
  check?: (rel: string, directory: boolean, bytes: number) => void,
  sampling = false,
) {
  let bytes = 0,
    count = 0;
  async function visit(parent: string, prefix: string) {
    for await (const entry of await opendir(parent)) {
      signal.throwIfAborted();
      const rel = prefix + entry.name,
        path = join(parent, entry.name);
      const s = await statIfPresent(path);
      // Git renames transient files while the transfer sampler runs.
      if (!s && sampling) continue;
      if (!s) throw Error("Review cache metadata changed");
      if (++count > 50000 || (bytes += s.size) > diskLimit)
        throw Error("Review cache storage limit exceeded");
      if (
        s.isSymbolicLink() ||
        (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))
      )
        throw Error("Unexpected review cache file");
      check?.(rel, s.isDirectory(), s.size);
      if (s.isDirectory()) await visit(path, rel + "/");
    }
  }
  await visit(dir, "");
  return bytes;
}

async function validate(
  dir: string,
  url: string,
  key: string,
  signal: AbortSignal,
) {
  await privateDir(dir);
  await walk(dir, signal, (p, d, size) => {
    if (
      !(d ? allowedDir : allowedFile).test(p) ||
      (["config", "HEAD", "channel-scope"].includes(p) && size > 4096)
    )
      throw Error("Unexpected review cache metadata");
  });
  if (
    (await readFile(join(dir, "config"), "utf8")) !== cacheConfig(url) ||
    (await readFile(join(dir, "HEAD"), "utf8")) !== head ||
    (await readFile(join(dir, "channel-scope"), "utf8")) !== key
  )
    throw Error("Review cache origin or configuration mismatch");
}
async function statIfPresent(dir: string) {
  try {
    return await lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
async function exists(dir: string) {
  return !!(await statIfPresent(dir));
}
async function verify(dir: string, sha: string, signal: AbortSignal) {
  if (
    (await run(
      dir,
      ["rev-parse", "--verify", "refs/heads/h" + sha],
      signal,
    )) !== sha ||
    (await run(dir, ["cat-file", "-t", sha], signal)) !== "commit"
  )
    throw Error("Review cache pin mismatch");
  await run(
    dir,
    ["fsck", "--full", "--strict", "--no-reflogs", "--no-dangling", sha],
    signal,
  );
}

// Publish immutable objects first, then the shallow boundary and the new ref.
// Existing readers retain their OIDs throughout. No fetch writes into a
// published repository, so a failed/aborted transfer cannot dirty earlier pins.
async function copyForIncrement(from: string, to: string, signal: AbortSignal) {
  for await (const entry of await opendir(from)) {
    signal.throwIfAborted();
    const src = join(from, entry.name),
      dst = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dst, { mode: 0o700 });
      await copyForIncrement(src, dst, signal);
    } else
      await copyFile(
        src,
        dst,
        constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
  }
  signal.throwIfAborted();
}
async function publishIncrement(
  stage: string,
  dir: string,
  sha: string,
  signal: AbortSignal,
) {
  async function moveNew(from: string, to: string) {
    for await (const entry of await opendir(from)) {
      signal.throwIfAborted();
      const source = join(from, entry.name),
        dest = join(to, entry.name);
      if (entry.isDirectory()) {
        await mkdir(dest, { recursive: true, mode: 0o700 });
        await moveNew(source, dest);
      } else if (!(await exists(dest))) await rename(source, dest);
    }
  }
  await moveNew(join(stage, "objects"), join(dir, "objects"));
  if (await exists(join(stage, "shallow")))
    await rename(join(stage, "shallow"), join(dir, "shallow"));
  signal.throwIfAborted();
  const ref = "refs/heads/h" + sha;
  await rename(join(stage, ref), join(dir, ref));
}

const busy = new Set<string>();
// The root and its parent must be administrator-controlled; on Windows deploy a private ACL.
// A single active bridge owns a cache root. Busy preparations fail closed.
export function createReviewCachePreparer(fetchObjects: Transfer) {
  return async (
    root: string,
    task: Task,
    grant: Grant,
    abort?: AbortSignal,
  ) => {
    const rev = task.target.kind === "pull_request" && task.target.revision;
    if (
      !rev ||
      !oid.test(rev.headSha) ||
      !oid.test(rev.baseSha) ||
      rev.headRepoId !== task.repositoryId ||
      rev.baseRepoId !== task.repositoryId ||
      ![task.installationId, task.repositoryId].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      !task.bindingId ||
      ![task.owner, task.repo].every(
        (p) => /^[A-Za-z0-9_.-]{1,100}$/.test(p) && p !== "." && p !== "..",
      )
    )
      throw Error("Invalid review cache task pin");
    if (!isAbsolute(root))
      throw Error("Review cache requires an absolute root");
    root = resolve(root);
    const signal = AbortSignal.any([
      AbortSignal.timeout(120000),
      ...(abort ? [abort] : []),
    ]);
    signal.throwIfAborted();
    if (busy.has(root)) throw Error("Review cache is busy");
    busy.add(root);
    let staging: string | undefined;
    let lock: DatabaseSync | undefined;
    try {
      if ((await realpath(dirname(root))) !== dirname(root))
        throw Error("Invalid review cache parent");
      if (!(await exists(root))) await mkdir(root, { mode: 0o700 });
      await privateDir(root);
      const lockPath = join(root, "channel.lock");
      const lockStat = await statIfPresent(lockPath);
      if (lockStat && (!lockStat.isFile() || lockStat.nlink !== 1))
        throw Error("Invalid review cache lock");
      if (!lockStat) {
        for await (const _entry of await opendir(root))
          throw Error("A new review cache requires an empty private root");
      }
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        const s = await statIfPresent(lockPath + suffix);
        if (s) throw Error("Unexpected review cache lock sidecar");
      }
      lock = new DatabaseSync(lockPath);
      try {
        lock.exec(
          "PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE;",
        );
      } catch {
        throw Error("Review cache is busy");
      }
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            task.installationId,
            task.repositoryId,
            task.bindingId,
          ]),
        )
        .digest("hex");
      const dir = join(root, key);
      const url =
        "https://github.com/" +
        task.owner.toLowerCase() +
        "/" +
        task.repo.toLowerCase() +
        ".git";
      if (await exists(join(root, fetchMarker))) {
        // A previous Git HTTPS helper may still own its staging directory.
        // Do not delete staging or admit new downloads until operator reconciliation.
        if (!(await exists(dir)))
          throw Error("Review download needs reconciliation");
        await validate(dir, url, key, signal);
        if (!(await exists(join(dir, "refs/heads/h" + rev.headSha))))
          throw Error("Review download needs reconciliation");
        await verify(dir, rev.headSha, signal);
        return dir;
      }
      // No process can still own a preparation under this root lock, and
      // published readers only use the final digest directory. Reclaim just
      // the reserved mkdtemp names from our initially empty private root.
      for await (const entry of await opendir(root)) {
        signal.throwIfAborted();
        if (!/^\.preparing-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
        const stale = join(root, entry.name);
        await privateDir(stale);
        await rm(stale, { recursive: true, force: true });
      }
      const used = await walk(root, signal, (p, directory) => {
        if (
          !p.includes("/") &&
          !(p === "channel.lock" && !directory) &&
          !(directory && /^[0-9a-f]{64}$/.test(p))
        )
          throw Error("Unexpected entry in dedicated review cache root");
      });
      const cold = !(await exists(dir));
      let work = cold
        ? (staging = await mkdtemp(join(root, ".preparing-")))
        : dir;
      if (cold) {
        // Minimal bare repository with a fixed format and no Git init templates.
        for (const path of [
          "objects/pack",
          "objects/info",
          "refs/heads",
          "refs/tags",
        ])
          await mkdir(join(work, path), { recursive: true, mode: 0o700 });
        await writeFile(join(work, "HEAD"), head, { flag: "wx", mode: 0o600 });
        await writeFile(join(work, "channel-scope"), key, {
          flag: "wx",
          mode: 0o600,
        });
        await writeFile(join(work, "config"), cacheConfig(url), {
          flag: "wx",
          mode: 0o600,
        });
      }
      await validate(work, url, key, signal);
      const sha = rev.headSha;
      if (!(await exists(join(work, "refs/heads/h" + sha)))) {
        if (!cold) {
          // Seed negotiation with the old objects/refs in an isolated staging
          // directory. Prefer filesystem copy-on-write; never use alternates.
          if (used + (await walk(dir, signal)) > diskLimit)
            throw Error("Review cache storage limit exceeded");
          work = staging = await mkdtemp(join(root, ".preparing-"));
          await copyForIncrement(dir, work, signal);
          await validate(work, url, key, signal);
        }
        const { token, expiresAt } = await grant();
        if (
          !token ||
          !Number.isFinite(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= Date.now()
        )
          throw Error("No current review cache credential");
        await validate(work, url, key, signal);
        signal.throwIfAborted();
        const monitor = new AbortController();
        const transferSignal = AbortSignal.any([signal, monitor.signal]);
        let checking: Promise<void> | undefined;
        const timer = setInterval(() => {
          checking ??= walk(root, transferSignal, undefined, true)
            .then(() => undefined)
            .catch(() => {
              monitor.abort();
            })
            .finally(() => {
              checking = undefined;
            });
        }, 500);
        try {
          await fetchObjects(work, url, sha, token, transferSignal);
        } catch {
          throw unavailable();
        } finally {
          clearInterval(timer);
          await checking;
        }
        transferSignal.throwIfAborted();
        await walk(root, signal);
        await validate(work, url, key, signal);
      }
      await verify(work, sha, signal);
      signal.throwIfAborted();
      if (cold) {
        await rename(work, dir);
        staging = undefined;
      } else if (staging) await publishIncrement(staging, dir, sha, signal);
      return dir;
    } finally {
      try {
        if (staging && !(await exists(join(root, fetchMarker))))
          await rm(staging, { recursive: true, force: true });
      } finally {
        try {
          lock?.close();
        } finally {
          busy.delete(root);
        }
      }
    }
  };
}
export const prepareReviewCache = createReviewCachePreparer(transfer);
