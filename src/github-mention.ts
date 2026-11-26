import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

type Node = import("mdast").Root | import("mdast").RootContent;
const comment = /^<!--(?:(?!-->)[\s\S])*-->\s*$/;
const markdown = {
  extensions: [gfmStrikethrough({ singleTilde: true })],
  mdastExtensions: [gfmStrikethroughFromMarkdown()],
};

// An occurrence in a quoted example or link is content, not a delegation.
// Limit accepted prose containers explicitly; a new AST node type cannot opt in.
export function mentionsBot(body: string, login: string): boolean {
  const slug = login.replace(/\[bot\]$/i, "");
  return !!slug && mentions(body, slug);
}
export function addressedFirstLine(body: string): boolean {
  return mentions(body.trimStart().split(/[\r\n]/, 1)[0], null);
}
function mentions(body: string, slug: string | null): boolean {
  if (
    body.length > 16000 ||
    !body.toLowerCase().includes("@" + (slug ?? "").toLowerCase())
  )
    return false;
  const escaped =
    slug === null
      ? "[a-z0-9][a-z0-9-]*(?:/[a-z0-9_-]+)?"
      : slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    "@" + escaped + "(?:\\[bot\\])?(?![a-z0-9_@/\\[\\]-])",
    "gi",
  );
  // A leading command remains unambiguous even before a very large diff.
  // Otherwise bound the syntax work performed on the synchronous ingress path.
  if ((body.match(/[-<>*_\[\]`~#|!\\.():]/g)?.length ?? 0) > 512)
    return (
      slug === null ||
      new RegExp("^@" + escaped + "(?:\\[bot\\])?(?=\\s|$)", "i").test(body)
    );
  let root;
  try {
    root = fromMarkdown(body, markdown);
  } catch {
    return false;
  }
  // Markdown syntax is resolved by the parser. Inspect the original source
  // offsets so that a backslash or character reference cannot create a mention.
  const blocks: Node[] = [root];
  while (blocks.length) {
    const block = blocks.pop()!;
    if (
      block.type === "root" ||
      block.type === "list" ||
      block.type === "listItem"
    ) {
      blocks.push(...[...block.children].reverse());
      continue;
    }
    // Raw HTML can extend across Markdown blocks. Look no further once its
    // meaning is ambiguous. Self-contained comments only hide their contents.
    if (block.type === "html" && !comment.test(block.value)) return false;
    if (block.type !== "paragraph" && block.type !== "heading") continue;
    // Inline HTML can change the meaning of sibling text (e.g. <code>...).
    // Do not infer rendered prose in a paragraph containing raw HTML.
    const pending: Node[] = [...block.children];
    let found = false;
    while (pending.length) {
      const n = pending.pop()!;
      if (n.type === "html") {
        if (!comment.test(n.value)) return false;
        continue;
      }
      if (n.type === "emphasis" || n.type === "strong") {
        pending.push(...n.children);
        continue;
      }
      if (n.type !== "text") continue;
      const start = n.position?.start.offset,
        end = n.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const raw = body.slice(start, end);
      for (const m of raw.matchAll(match)) {
        const offset = start + m.index;
        // Strip only parser-recognized opening emphasis delimiters. Do not
        // treat @ in an email, path, escaped token or URL as a command.
        let left = offset;
        if (m.index === 0)
          while (left > 0 && /[*_]/.test(body[left - 1])) left--;
        // Parenthesized prose can start a word. Check the outer boundary
        // as well: a parenthesis inside a URL/path does not start a word.
        while (left > 0 && body[left - 1] === "(") left--;
        if (left && !/[\s，。：；！？、（]/u.test(body[left - 1])) continue;
        const next = body[offset + m[0].length];
        if (next && /[a-z0-9@/\[\]-]/i.test(next)) continue;
        if (
          next === "_" &&
          !(m.index + m[0].length === raw.length && end < body.length)
        )
          continue;
        found = true;
        break;
      }
    }
    if (found) return true;
  }
  return false;
}
