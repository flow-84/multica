import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

/** The comment being read aloud and the issue it belongs to. */
export interface SpeakingItem {
  commentId: string;
  issueId: string | null;
  identifier: string | null;
  projectId: string | null;
  /** True while a short summary is being generated before playback starts. */
  preparing: boolean;
}

/**
 * Read-aloud preferences and playback pointer.
 *
 * `autoRead` speaks every newly created agent comment as it arrives and
 * `summarize` reads a short AI summary instead of the full comment where the
 * platform supports it. Both are personal preferences (like theme), so they
 * persist globally. `speaking` is ephemeral playback state and is excluded
 * from persistence.
 */
interface SpeechStore {
  autoRead: boolean;
  summarize: boolean;
  speaking: SpeakingItem | null;
  toggleAutoRead: () => void;
  toggleSummarize: () => void;
  setSpeaking: (speaking: SpeakingItem | null) => void;
}

export const useSpeechStore = create<SpeechStore>()(
  persist(
    (set) => ({
      autoRead: false,
      summarize: true,
      speaking: null,
      toggleAutoRead: () => set((s) => ({ autoRead: !s.autoRead })),
      toggleSummarize: () => set((s) => ({ summarize: !s.summarize })),
      setSpeaking: (speaking) => set({ speaking }),
    }),
    {
      name: "multica_speech",
      storage: createJSONStorage(() => defaultStorage),
      partialize: (s) => ({ autoRead: s.autoRead, summarize: s.summarize }),
    },
  ),
);

/** Whether `issueId` is the issue currently being read aloud. */
export function useIsSpeakingIssue(issueId: string | null | undefined): boolean {
  return useSpeechStore((s) => !!issueId && s.speaking?.issueId === issueId);
}
