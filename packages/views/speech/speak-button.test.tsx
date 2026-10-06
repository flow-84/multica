import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineEntry } from "@multica/core/types";
import { useSpeechStore } from "@multica/core/speech";
import { renderWithI18n } from "../test/i18n";
import { SpeakButton } from "./speak-button";
import { latestAgentAnswer } from "./issue-read-aloud-controls";

vi.mock("./speech-issue", () => ({ loadSpeechIssue: async () => null }));

class FakeUtterance {
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const spoken: FakeUtterance[] = [];
const synth = {
  speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
  cancel: vi.fn(),
  getVoices: () => [],
};

beforeEach(() => {
  spoken.length = 0;
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  useSpeechStore.setState({ speaking: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error test cleanup of the stubbed browser API
  delete window.speechSynthesis;
});

describe("SpeakButton", () => {
  it("speaks the plain text of the answer and stops on a second press", async () => {
    renderWithI18n(
      <QueryClientProvider client={new QueryClient()}>
        <SpeakButton id="c1" issueId="i1" markdown={"**Fertig** und [live](https://x.y)"} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    await waitFor(() => expect(spoken.map((u) => u.text)).toEqual(["Fertig und live."]));
    expect(useSpeechStore.getState().speaking?.commentId).toBe("c1");

    fireEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    expect(synth.cancel).toHaveBeenCalled();
    expect(useSpeechStore.getState().speaking).toBeNull();
  });
});

describe("latestAgentAnswer", () => {
  const entry = (id: string, actor_type: string, created_at: string, content = "x"): TimelineEntry =>
    ({ type: "comment", id, actor_type, actor_id: "a", created_at, content }) as TimelineEntry;

  it("returns the newest agent comment and ignores members", () => {
    const timeline = [
      entry("a1", "agent", "2026-09-28T10:00:00Z"),
      entry("m1", "member", "2026-09-28T12:00:00Z"),
      entry("a2", "agent", "2026-09-28T11:00:00Z"),
    ];
    expect(latestAgentAnswer(timeline)?.id).toBe("a2");
    expect(latestAgentAnswer([entry("m1", "member", "2026-09-28T12:00:00Z")])).toBeNull();
  });
});
