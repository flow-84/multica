// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decisionBlock, markdownToSpeech } from "./speech-text";

describe("markdownToSpeech", () => {
  it("keeps link labels and drops link targets and bare URLs", () => {
    expect(markdownToSpeech("Siehe [PR #12](https://github.com/x/y/pull/12) und https://example.com")).toBe(
      "Siehe PR #12 und.",
    );
  });

  it("drops fenced code blocks and images", () => {
    expect(
      markdownToSpeech("Vorher\n\n```ts\nconst a = 1;\n```\n\n![shot](https://x/y.png)\nNachher"),
    ).toBe("Vorher. Nachher.");
  });

  it("turns headings and list items into separate sentences", () => {
    expect(markdownToSpeech("## Ergebnis\n- **Fertig** und deployed\n- Prüfung grün\n1. Schritt")).toBe(
      "Ergebnis. Fertig und deployed. Prüfung grün. 1. Schritt.",
    );
  });

  it("reads table cells and skips the ruler row", () => {
    expect(markdownToSpeech("| Was | Stand |\n|---|---|\n| API | läuft |")).toBe(
      "Was, Stand. API, läuft.",
    );
  });

  it("speaks mentions without the at sign and keeps sentence punctuation", () => {
    expect(markdownToSpeech("Danke [@fl0w](mention://member/abc)! Erledigt?")).toBe("Danke fl0w! Erledigt?");
  });
});

describe("decisionBlock", () => {
  const block = "## Entscheidung\n\n**Worum es geht:** Der Kurs fehlt.\n\n**Option A (empfohlen):** Tageskurs nehmen.";

  it("returns the closing block from its heading on", () => {
    expect(decisionBlock(`Bericht\n\n## Ergebnis\nFertig\n\n${block}`)).toBe(block);
  });

  it("speaks as sentences, without the Markdown", () => {
    expect(markdownToSpeech(decisionBlock(block)!)).toBe(
      "Entscheidung. Worum es geht: Der Kurs fehlt. Option A (empfohlen): Tageskurs nehmen.",
    );
  });

  it("ignores a block that is not the last section", () => {
    expect(decisionBlock(`${block}\n\n## Nachtrag\nNoch etwas`)).toBeNull();
  });

  it("ignores a heading inside a code fence, and an empty block", () => {
    expect(decisionBlock("Text\n\n```md\n## Entscheidung\nBeispiel\n```")).toBeNull();
    expect(decisionBlock("Text\n\n## Entscheidung\n\n")).toBeNull();
  });

  it("keeps a closing block when a later code fence holds a heading", () => {
    const withFence = block + "\n\n```md\n# kein Abschnitt\n```";
    expect(decisionBlock(withFence)).toBe(withFence);
  });
});
