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
