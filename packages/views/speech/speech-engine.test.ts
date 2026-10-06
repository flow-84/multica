import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpeechStore } from "@multica/core/speech";
import { setSpeechBackend, speak, stopSpeaking, type SpeechBackend } from "./speech-engine";

const issue = { id: "i1", identifier: "MUL-1", title: "Login fix", status: "in_review", project_id: "p1" } as const;

function fakeBackend(summary: string | null) {
  const spoken: string[] = [];
  const backend: SpeechBackend = {
    speak: vi.fn(async (text: string) => {
      spoken.push(text);
    }),
    stop: vi.fn(),
    summarize: vi.fn(async () => summary),
  };
  setSpeechBackend(backend);
  return { backend, spoken };
}

afterEach(() => {
  stopSpeaking();
  setSpeechBackend(null);
  useSpeechStore.setState({ summarize: true, speaking: null });
});

describe("speech engine summaries", () => {
  it("speaks the summary instead of the full answer and tracks the issue", async () => {
    const { backend, spoken } = fakeBackend("Done, nothing open.");
    speak({ commentId: "c1", markdown: "**Merged** PR #12 in `auth.ts`", issue });
    expect(useSpeechStore.getState().speaking).toMatchObject({
      commentId: "c1",
      issueId: "i1",
      identifier: "MUL-1",
      projectId: "p1",
      preparing: true,
    });
    await vi.waitFor(() => expect(spoken).toEqual(["Done, nothing open."]));
    expect(backend.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "MUL-1", title: "Login fix", status: "in_review" }),
    );
  });

  it("falls back to the full answer when no summary comes back", async () => {
    const { spoken } = fakeBackend(null);
    speak({ commentId: "c2", markdown: "**Fertig** und live", issue });
    await vi.waitFor(() => expect(spoken).toEqual(["Fertig und live."]));
  });

  it("reads the full answer when the summary preference is off", async () => {
    const { backend, spoken } = fakeBackend("short");
    useSpeechStore.setState({ summarize: false });
    speak({ commentId: "c3", markdown: "Full text", issue });
    await vi.waitFor(() => expect(spoken).toEqual(["Full text."]));
    expect(backend.summarize).not.toHaveBeenCalled();
  });

  it("summarizes each comment only once", async () => {
    const { backend, spoken } = fakeBackend("Short.");
    speak({ commentId: "c4", markdown: "Long answer", issue });
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    speak({ commentId: "c4", markdown: "Long answer", issue });
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(backend.summarize).toHaveBeenCalledTimes(1);
  });
});
