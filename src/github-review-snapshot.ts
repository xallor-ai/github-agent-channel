import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/core";

const filesLimit = 128,
  fileBytes = 128 * 1024,
  wireBytes = 1_000_000;
const oid = /^[a-f0-9]{40}$/;
const supportedPath = (path: string) =>
  path.length > 0 &&
  path.length <= 1024 &&
  !/[\\:\x00-\x1f\x7f]/.test(path) &&
  !path
    .split("/")
    .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git");

// Bound even a misleading/truncated upstream response before Octokit parses it.
// Neither redirect destinations nor URLs in Git tree entries are followed.
export function boundedGitObjectFetch(
  fetchImpl: typeof fetch,
  timeoutMs = 90_000,
): typeof fetch {
  let remaining = 3_000_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  return async (input, init) => {
    const response = await fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: init?.signal
        ? AbortSignal.any([deadline, init.signal])
        : deadline,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error("Cannot fetch pinned Git object");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        remaining -= value.length;
        if (size > 512_000 || remaining < 0) {
          await reader.cancel();
          throw Error("Git object response exceeds snapshot budget");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      headers: { "content-type": "application/json" },
    });
  };
}

export async function collectReviewSnapshot(
  client: Octokit,
  fetchImpl: typeof fetch,
  repo: { owner: string; repo: string },
  sha: string,
) {
  if (!oid.test(sha)) throw Error("Invalid snapshot commit");
  const request = { fetch: boundedGitObjectFetch(fetchImpl) };
  const { data: commit } = await client.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { ...repo, commit_sha: sha, request },
  );
  if (
    commit.sha !== sha ||
    typeof commit.tree?.sha !== "string" ||
    !oid.test(commit.tree.sha)
  )
    throw Error("Cannot verify snapshot commit");
  const { data: tree } = await client.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { ...repo, tree_sha: commit.tree.sha, recursive: "1", request },
  );
  if (
    tree.sha !== commit.tree.sha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree)
  )
    throw Error("Incomplete snapshot tree");
  let total = 0;
  const entries: { path: string; sha: string; size: number }[] = [];
  const paths = new Set<string>();
  for (const e of tree.tree) {
    if (
      typeof e.path !== "string" ||
      !supportedPath(e.path) ||
      paths.has(e.path)
    )
      throw Error("Unsupported snapshot path");
    paths.add(e.path);
    if (e.type === "tree" && e.mode === "040000") continue;
    if (
      e.type !== "blob" ||
      !["100644", "100755"].includes(e.mode ?? "") ||
      typeof e.sha !== "string" ||
      !oid.test(e.sha)
    )
      throw Error("Snapshot requires regular files only");
    if (
      typeof e.size !== "number" ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      e.size > fileBytes ||
      (total += e.size) > wireBytes ||
      entries.length === filesLimit
    )
      throw Error("Snapshot tree exceeds size or file limit");
    entries.push({ path: e.path, size: e.size, sha: e.sha });
  }
  const files: { path: string; text: string }[] = [];
  const result = { sha, files, complete: true as const };
  let encodedSize = Buffer.byteLength(JSON.stringify(result));
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let i = 0; i < entries.length; i += 4) {
    const batch = await Promise.allSettled(
      entries.slice(i, i + 4).map(async (e) => {
        const { data: b } = await client.request(
          "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          { ...repo, file_sha: e.sha, request },
        );
        if (
          b.sha !== e.sha ||
          b.encoding !== "base64" ||
          b.size !== e.size ||
          typeof b.content !== "string"
        )
          throw Error("Invalid snapshot blob");
        const bytes = Buffer.from(b.content, "base64");
        if (
          bytes.length !== e.size ||
          bytes.includes(0) ||
          createHash("sha1")
            .update(`blob ${e.size}\0`)
            .update(bytes)
            .digest("hex") !== e.sha
        )
          throw Error(
            "Snapshot blob is binary or does not match its Git object",
          );
        return { path: e.path, text: utf8.decode(bytes) };
      }),
    );
    for (const f of batch) {
      if (f.status === "rejected")
        throw Error("Pinned snapshot file is unavailable, invalid or non-text");
      encodedSize +=
        Buffer.byteLength(JSON.stringify(f.value)) + (files.length ? 1 : 0);
      if (encodedSize > wireBytes)
        throw Error("Snapshot exceeds transfer limit");
      files.push(f.value);
    }
  }
  return result;
}
