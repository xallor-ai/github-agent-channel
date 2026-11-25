import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/core";
import { boundedGitObjectFetch } from "./github-review-snapshot.js";

const maxFileBytes = 128 * 1024;
const maxSegments = 24;
const oid = /^[a-f0-9]{40}$/;
type PinnedFile =
  | { content: string }
  | { unavailable: "file_unavailable" | "not_a_file" | "file_too_large" };

/** Resolve the exact entry in the pinned tree. Contents can dereference symlinks. */
export async function readPinnedPullFile(
  client: Octokit,
  fetchImpl: typeof fetch,
  repo: { owner: string; repo: string },
  sha: string,
  path: string,
): Promise<PinnedFile> {
  const segments = path.split("/");
  if (
    !oid.test(sha) ||
    path.length > 1024 ||
    /[\\:%\x00-\x1f\x7f]/.test(path) ||
    segments.length > maxSegments ||
    segments.some((part) =>
      ["", ".", "..", ".git"].includes(part.toLowerCase()),
    )
  )
    throw Error("Invalid pinned file path or revision");

  const request = { fetch: boundedGitObjectFetch(fetchImpl, 12_000) };
  const { data: commit } = await client.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { ...repo, commit_sha: sha, request },
  );
  if (
    commit.sha !== sha ||
    typeof commit.tree?.sha !== "string" ||
    !oid.test(commit.tree.sha)
  )
    throw Error("Cannot verify pinned file commit");
  let treeSha = commit.tree.sha;

  for (const [index, part] of segments.entries()) {
    const { data: tree } = await client.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { ...repo, tree_sha: treeSha, request },
    );
    if (
      tree.sha !== treeSha ||
      tree.truncated !== false ||
      !Array.isArray(tree.tree)
    )
      throw Error("Cannot verify complete pinned file tree");
    const matches = tree.tree.filter((item) => item.path === part);
    if (!matches.length) return { unavailable: "file_unavailable" };
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      typeof entry.sha !== "string" ||
      !oid.test(entry.sha)
    )
      throw Error("Pinned path is invalid or ambiguous");
    if (index < segments.length - 1) {
      if (entry.type !== "tree" || entry.mode !== "040000")
        return { unavailable: "not_a_file" };
      treeSha = entry.sha;
      continue;
    }
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode ?? "")
    )
      return { unavailable: "not_a_file" };
    if (
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      throw Error("Invalid pinned file size");
    if (entry.size > maxFileBytes) return { unavailable: "file_too_large" };

    const { data: blob } = await client.request(
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      { ...repo, file_sha: entry.sha, request },
    );
    if (
      blob.sha !== entry.sha ||
      blob.size !== entry.size ||
      blob.encoding !== "base64" ||
      typeof blob.content !== "string"
    )
      throw Error("Pinned file response does not match its Git object");
    const bytes = Buffer.from(blob.content, "base64");
    if (
      bytes.length !== entry.size ||
      createHash("sha1")
        .update(`blob ${entry.size}\0`)
        .update(bytes)
        .digest("hex") !== entry.sha
    )
      throw Error("Pinned file response does not match its Git object");
    if (bytes.includes(0)) return { unavailable: "file_unavailable" };
    try {
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      return { content };
    } catch {
      return { unavailable: "file_unavailable" };
    }
  }
  throw Error("Cannot read pinned file");
}
