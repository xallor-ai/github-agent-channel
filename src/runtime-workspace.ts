import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, sep, join, delimiter, isAbsolute } from "node:path";
import type { Task, ChangedFile } from "./contracts.js";
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
// Pin an installed executable before starting any untrusted runtime. Never search cwd.
const gitExecutable = (process.env.PATH ?? process.env.Path ?? "")
  .split(delimiter)
  .filter(isAbsolute)
  .map((dir) => join(dir, process.platform === "win32" ? "git.exe" : "git"))
  .find(existsSync);
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
}
function runGit(cwd: string, args: string[]): string {
  if (!gitExecutable)
    throw Error("Git executable missing from absolute PATH entries");
  return execFileSync(
    gitExecutable,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${nullDevice}`,
      "-c",
      `core.attributesFile=${nullDevice}`,
      "-c",
      "core.untrackedCache=false",
      "-c",
      "protocol.allow=never",
      ...args,
    ],
    {
      cwd,
      env: gitEnvironment(),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  ).trimEnd();
}
function metadata(cwd: string, expectedHash?: string): string {
  const gitDir = join(cwd, ".git");
  if (
    !lstatSync(gitDir).isDirectory() ||
    realpathSync.native(gitDir) !== gitDir
  )
    throw Error(
      "Git metadata must be a local directory; linked worktrees are unsupported",
    );
  for (const path of ["config", "objects", "objects/info"]) {
    const absolute = join(gitDir, path);
    if (existsSync(absolute) && realpathSync.native(absolute) !== absolute)
      throw Error("Git metadata symlinks are unsupported");
  }
  for (const path of [
    "commondir",
    "gitdir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "config.worktree",
  ])
    if (existsSync(join(gitDir, path)))
      throw Error("Git metadata redirection is unsupported");
  const config = join(gitDir, "config");
  const hash = createHash("sha256").update(readFileSync(config)).digest("hex");
  if (expectedHash !== undefined && hash !== expectedHash)
    throw Error("Git metadata changed during runtime execution");
  const entries = runGit(cwd, [
    "config",
    "--file",
    config,
    "--no-includes",
    "--null",
    "--list",
  ]).split("\0");
  for (const entry of entries) {
    const [key, value] = entry.split("\n");
    // No includes, worktree redirection, partial clone/remote helpers, or code hooks.
    if (
      /^(include|includeif|filter|extensions)\./i.test(key) ||
      /^core\.(fsmonitor|hookspath|worktree|sshcommand|alternaterefscommand)$/i.test(
        key,
      ) ||
      /^diff\..*\.(command|textconv)$/i.test(key) ||
      /^diff\.external$/i.test(key) ||
      /^remote\..*\.(vcs|promisor|partialclonefilter)$/i.test(key) ||
      (/^core\.bare$/i.test(key) && value !== "false")
    )
      throw Error("Executable or redirecting Git configuration is unsupported");
  }
  return hash;
}
export function git(cwd: string, ...args: string[]): string {
  cwd = realpathSync.native(cwd);
  metadata(cwd);
  if (args[0] === "diff")
    args.splice(
      1,
      0,
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
    );
  return runGit(cwd, args);
}
function validateIndex(cwd: string): void {
  // -v exposes assume-unchanged as lowercase tags and skip-worktree as S/s.
  // NUL records keep filenames (including newlines) out of flag parsing.
  for (const entry of git(cwd, "ls-files", "--stage", "-v", "-z").split("\0")) {
    if (/^[a-zS]/.test(entry))
      throw Error("Git index flags can hide changes; workspace is unsupported");
    if (/^. 160000 /.test(entry))
      throw Error("Submodule workspaces are unsupported");
  }
}
export function inspectWorkspace(path: string, task: Task) {
  const cwd = realpathSync.native(path);
  if (realpathSync.native(git(cwd, "rev-parse", "--show-toplevel")) !== cwd)
    throw Error("Workspace must be a Git repository root");
  const origin = git(cwd, "remote", "get-url", "origin");
  const expected = `${task.owner}/${task.repo}`.toLowerCase();
  const match = origin.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+?)(?:\.git)?$/i,
  );
  if (!match || match[1].toLowerCase() !== expected)
    throw Error("Workspace origin does not match task repository");
  validateIndex(cwd);
  if (
    git(
      cwd,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignore-submodules=all",
    )
  )
    throw Error("Workspace must be clean");
  const baseSha = git(cwd, "rev-parse", "HEAD");
  if (task.target.kind === "pull_request") {
    const pin = task.target.revision;
    if (
      !pin ||
      pin.baseRepoId !== task.repositoryId ||
      pin.headRepoId !== task.repositoryId ||
      pin.headSha !== baseSha
    )
      throw Error(
        "Workspace must match the pinned PR head in the bound repository",
      );
  }

  if (
    task.target.kind === "repository" &&
    task.target.sha !== undefined &&
    task.target.sha.toLowerCase() !== baseSha
  )
    throw Error("Workspace HEAD does not match task target SHA");
  return {
    cwd,
    baseSha,
    metadataHash: metadata(cwd),
  };
}
export function collectChanges(
  cwd: string,
  baseSha: string,
  metadataHash?: string,
): ChangedFile[] {
  cwd = realpathSync.native(cwd);
  metadata(cwd, metadataHash);
  validateIndex(cwd);
  if (git(cwd, "rev-parse", "HEAD") !== baseSha)
    throw Error("Runtime changed HEAD; refusing publication");
  // A staged mode/type change can be cancelled out by the working-tree state
  // (notably executable bits on Linux). Enforce restrictions at both layers.
  const raw = [
    git(cwd, "diff", "--cached", "--raw", "--no-renames", baseSha),
    git(cwd, "diff", "--raw", "--no-renames", baseSha),
  ];
  for (const line of raw.flatMap((diff) => diff.split("\n"))) {
    const modes = line.match(/^:([0-9]{6}) ([0-9]{6}) /);
    if (
      modes &&
      modes.slice(1).some((mode) => mode !== "100644" && mode !== "000000")
    )
      throw Error("Unsupported Git file mode");
  }
  const tracked = git(cwd, "diff", "--name-only", "-z", baseSha).split("\0");
  const untracked = git(
    cwd,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ).split("\0");
  const names = [...new Set([...tracked, ...untracked].filter(Boolean))];
  if (names.length > 100) throw Error("Too many changed files");
  if (new Set(names.map((path) => path.toLowerCase())).size !== names.length)
    throw Error("Case-ambiguous changed paths");
  let bytes = 0;
  return names.map((path) => {
    if (
      path.length > 1024 ||
      /[\\\x00-\x1f:]/.test(path) ||
      path.startsWith("/") ||
      path
        .split("/")
        .some(
          (p) =>
            p === "" || p === "." || p === ".." || p.toLowerCase() === ".git",
        ) ||
      path.toLowerCase().startsWith(".github/workflows/")
    )
      throw Error("Unsafe changed path");
    const absolute = resolve(cwd, path);
    const rel = relative(cwd, absolute);
    if (rel.startsWith(".." + sep) || rel === "..")
      throw Error("Changed path outside workspace");
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { path, content: null };
      throw e;
    }
    if (!stat.isFile() || realpathSync.native(absolute) !== absolute)
      throw Error("Only regular workspace files supported");
    if (process.platform !== "win32" && (stat.mode & 0o111) !== 0)
      throw Error("Unsupported executable file mode");
    bytes += stat.size;
    if (bytes > 512 * 1024) throw Error("Changed files exceed size limit");
    const data = readFileSync(absolute);
    if (data.includes(0)) throw Error("Binary files unsupported");
    // Keep an initial U+FEFF so UTF-8 re-encoding preserves the original BOM bytes.
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(data);
    return { path, content };
  });
}
