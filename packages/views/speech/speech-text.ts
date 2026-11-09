import { stripInlineMarkdown } from "../issues/components/description-preview";

/**
 * Turn comment Markdown into text a speech engine reads naturally. Code blocks,
 * raw HTML, bare URLs and table rulers carry no spoken meaning and are dropped;
 * every remaining line becomes its own sentence so the voice pauses between
 * list items and paragraphs instead of running them together.
 */
export function markdownToSpeech(markdown: string): string {
  const withoutBlocks = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");

  return stripInlineMarkdown(withoutBlocks)
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/^\s*[-+]\s+/, "")
        .replace(/^\s*\[[ xX]\]\s+/, "")
        .replace(/\s*\|\s*/g, ", ")
        .replace(/(^|\s)@(?=\S)/g, "$1")
        .replace(/^[,\s]+|[,\s]+$/g, ""),
    )
    .filter((line) => line.length > 0)
    .map((line) => (/[.!?:;…]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

const DECISION_HEADING = /^##\s+Entscheidung:?\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const CODE_FENCE = /^\s*```/;

/**
 * The closing "## Entscheidung" section agents end a comment with when the user
 * has to decide something, or null when the comment has none. Only the last
 * section counts: a later heading means the block is not the comment's end.
 */
export function decisionBlock(markdown: string): string | null {
  const lines = markdown.split("\n");
  let start = -1;
  let inFence = false;
  lines.forEach((line, index) => {
    if (CODE_FENCE.test(line)) inFence = !inFence;
    else if (!inFence && ANY_HEADING.test(line)) start = DECISION_HEADING.test(line) ? index : -1;
  });
  if (start < 0 || !lines.slice(start + 1).join("").trim()) return null;
  return lines.slice(start).join("\n");
}
