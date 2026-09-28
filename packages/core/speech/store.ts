import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

/**
 * Read-aloud preferences and playback pointer.
 *
 * `autoRead` speaks every newly created agent comment as it arrives. It is a
 * personal preference (like theme), so it persists globally. `speakingId` is
 * the id of the comment currently being spoken; it is ephemeral playback state
 * and is excluded from persistence.
 */
interface SpeechStore {
  autoRead: boolean;
  speakingId: string | null;
  toggleAutoRead: () => void;
  setSpeakingId: (id: string | null) => void;
}

export const useSpeechStore = create<SpeechStore>()(
  persist(
    (set) => ({
      autoRead: false,
      speakingId: null,
      toggleAutoRead: () => set((s) => ({ autoRead: !s.autoRead })),
      setSpeakingId: (speakingId) => set({ speakingId }),
    }),
    {
      name: "multica_speech",
      storage: createJSONStorage(() => defaultStorage),
      partialize: (s) => ({ autoRead: s.autoRead }),
    },
  ),
);
