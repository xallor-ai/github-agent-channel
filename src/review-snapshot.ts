import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { gitEnvironment } from "./runtime-workspace.js";

const git = (process.env.PATH ?? "")
  .split(delimiter)
  .filter(isAbsolute)
  .map((dir) => join(dir, process.platform === "win32" ? "git.exe" : "git"))
  .find(existsSync);
const MiB = 1024 * 1024;
const maxFile = MiB;
const maxRead = 64 * 1024;
const maxSearch = 8 * MiB;
const maxMatches = 50;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const hash = /^[a-f0-9]{40}$/;
const safePath = (path: string) =>
  path.length > 0 &&
  path.length <= 4096 &&
  !/[\\:\x00-\x1f\x7f]/.test(path) &&
  !path
    .split("/")
    .some((s) => !s || s === "." || s === ".." || s.toLowerCase() === ".git");
type Entry = { path: string; oid: string; size: number };
type Pin = { fullName: string; sha: string };

// The directory, its metadata and the installed Git are administrator-owned.
// Only OIDs from the pinned tree can reach cat-file. No checkout, remote,
// attributes, diff drivers, revision expressions or model-supplied pathspecs.
export async function openReviewSnapshot(
  dir: string,
  { fullName, sha }: Pin,
  taskSignal?: AbortSignal,
) {
  if (
    !dir ||
    !isAbsolute(dir) ||
    !hash.test(sha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)
  )
    throw Error("No review snapshot for this repository and commit");
  const root = resolve(dir);
  if ((await realpath(root)) !== root)
    throw Error("Review repository must be a real directory");
  for (const name of [
    "config",
    "objects",
    "objects/info",
    "objects/pack",
    "HEAD",
  ]) {
    const path = join(root, name);
    if (existsSync(path) && (await realpath(path)) !== path)
      throw Error("Review repository metadata redirection is unsupported");
  }
  for (const name of [
    "gitdir",
    "commondir",
    "config.worktree",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ]) {
    if (lstatSync(join(root, name), { throwIfNoEntry: false }))
      throw Error("Review repository metadata redirection is unsupported");
  }

  const controller = new AbortController();
  const signal = taskSignal
    ? AbortSignal.any([taskSignal, controller.signal])
    : controller.signal;
  function open() {
    if (signal.aborted) throw Error("Review snapshot is closed");
  }
  function run(args: string[], limit: number, input?: string) {
    open();
    if (!git) throw Error("Local Git executable unavailable");
    const exe = git;
    return new Promise<Buffer>((ok, fail) => {
      const child = execFile(
        exe,
        [
          "--no-replace-objects",
          "-c",
          "protocol.allow=never",
          "--git-dir",
          root,
          ...args,
        ],
        {
          env: gitEnvironment(),
          encoding: "buffer",
          maxBuffer: limit,
          timeout: 15000,
          windowsHide: true,
          signal,
        },
        (err, out) =>
          err
            ? fail(
                Error(
                  "Review Git object unavailable or exceeds inspection limit",
                ),
              )
            : ok(out),
      );
      child.stdin?.on("error", () => {}); // process failure is reported by execFile
      child.stdin?.end(input);
    });
  }
  const config = (
    await run(
      [
        "config",
        "--no-includes",
        "--file",
        join(root, "config"),
        "--null",
        "--list",
      ],
      64 * 1024,
    )
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const origin = config
    .filter((s) => s.startsWith("remote.origin.url\n"))
    .map((s) => s.slice("remote.origin.url\n".length).toLowerCase());
  const url = "https://github.com/" + fullName.toLowerCase();
  if (origin.length !== 1 || ![url, url + ".git"].includes(origin[0]))
    throw Error("Review repository origin does not match task");
  if (
    config.some((s) =>
      /^(include(if)?\.|extensions\.|remote\..*\.(promisor|partialclonefilter|vcs)\n|core\.worktree\n)/i.test(
        s,
      ),
    ) ||
    (await run(["rev-parse", "--is-bare-repository"], 100))
      .toString()
      .trim() !== "true"
  )
    throw Error("Dedicated bare review repository required");
  if ((await run(["cat-file", "-t", sha], 100)).toString().trim() !== "commit")
    throw Error("Review pin must identify a commit");

  const listing = await run(["ls-tree", "-r", "-z", "-l", sha], 8 * MiB);
  const entries = new Map<string, Entry>();
  let incomplete = false;
  for (let at = 0; at < listing.length; ) {
    const end = listing.indexOf(0, at);
    if (end < 0) throw Error("Incomplete review tree");
    const record = listing.subarray(at, end);
    at = end + 1;
    const tab = record.indexOf(9);
    const info = /^100(?:644|755) blob ([a-f0-9]{40}) +(\d+)$/.exec(
      record.subarray(0, tab).toString("ascii"),
    );
    if (!info) {
      incomplete = true;
      continue;
    }
    let path: string;
    try {
      path = utf8.decode(record.subarray(tab + 1));
    } catch {
      incomplete = true;
      continue;
    }
    if (!safePath(path)) {
      incomplete = true;
      continue;
    }
    entries.set(path, { path, oid: info[1], size: Number(info[2]) });
  }
  async function blobs(batch: Entry[]) {
    if (!batch.length) return [];
    const bytes = await run(
      ["cat-file", "--batch"],
      batch.reduce((n, e) => n + e.size + 100, 0),
      batch.map((e) => e.oid + "\n").join(""),
    );
    let at = 0;
    return batch.map((e) => {
      const nl = bytes.indexOf(10, at);
      if (
        nl < 0 ||
        bytes.subarray(at, nl).toString("ascii") !==
          e.oid + " blob " + e.size ||
        bytes[nl + 1 + e.size] !== 10
      )
        throw Error("Review object does not match pinned tree");
      at = nl + e.size + 2;
      return bytes.subarray(nl + 1, at - 1);
    });
  }
  function asText(bytes: Buffer) {
    if (bytes.includes(0)) throw Error("Binary review file");
    try {
      return utf8.decode(bytes);
    } catch {
      throw Error("Non UTF-8 review file");
    }
  }
  return {
    close() {
      controller.abort();
      entries.clear();
    },
    async read(path: string) {
      open();
      const e = safePath(path) ? entries.get(path) : undefined;
      if (!e) throw Error("Not a regular file in the review tree");
      if (e.size > maxFile) throw Error("Review file exceeds size limit");
      const text = asText((await blobs([e]))[0]);
      return {
        path,
        sha,
        text: text.slice(0, maxRead),
        truncated: text.length > maxRead,
      };
    },
    async search(query: string) {
      open();
      validateQuery(query);
      let size = 0,
        truncated = incomplete;
      const batch: Entry[] = [];
      for (const e of entries.values()) {
        if (e.size > maxFile || size + e.size > maxSearch) {
          truncated = true;
          continue;
        }
        if (batch.length === 4096) {
          truncated = true;
          break;
        }
        batch.push(e);
        size += e.size;
      }
      const data = await blobs(batch);
      const files = data.flatMap((bytes, i) => {
        try {
          return [{ path: batch[i].path, text: asText(bytes) }];
        } catch {
          truncated = true;
          return [];
        }
      });
      return findMatches(sha, query, files, truncated);
    },
  };
}

function validateQuery(query: string) {
  if (!query.length || query.length > 256 || /[\x00-\x1f\x7f]/.test(query))
    throw Error("A single literal search term is required");
}
function findMatches(
  sha: string,
  query: string,
  files: Iterable<{ path: string; text: string }>,
  truncated: boolean,
) {
  const matches: { path: string; line: number; text: string }[] = [];
  outer: for (const { path, text: source } of files) {
    let at = 0,
      line = 1;
    while (at < source.length) {
      let end = source.indexOf("\n", at);
      if (end < 0) end = source.length;
      const row = source.slice(at, end);
      const column = row.indexOf(query);
      if (column !== -1) {
        if (matches.length === maxMatches) {
          truncated = true;
          break outer;
        }
        const start = Math.max(0, column - 80);
        matches.push({ path, line, text: row.slice(start, start + 400) });
        if (start || row.length > 400) truncated = true;
      }
      at = end + 1;
      line++;
    }
  }
  return { sha, matches, truncated };
}

export type ReviewSnapshot = Awaited<ReturnType<typeof openReviewSnapshot>>;
