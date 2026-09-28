// @vitest-environment node
import { describe, expect, it } from "vitest";
import { markdownToSpeech } from "./speech-text";

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
