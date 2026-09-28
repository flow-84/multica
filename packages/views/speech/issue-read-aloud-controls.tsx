"use client";

import { useEffect, useMemo } from "react";
import { AudioLines } from "lucide-react";
import type { TimelineEntry } from "@multica/core/types";
import { isDeletedComment } from "@multica/core/issues/comment-deletion";
import {
  getShortcut,
  isEditableShortcutTarget,
  shortcutMatchesEvent,
  useShortcutStore,
} from "@multica/core/shortcuts";
import { useSpeechStore } from "@multica/core/speech";
import { isImeComposing } from "@multica/core/utils";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { SpeakButton } from "./speak-button";
import { isSpeechSupported, speak, stopSpeaking } from "./speech-engine";
import { markdownToSpeech } from "./speech-text";

/** Newest non-deleted agent comment in the timeline, or null. */
export function latestAgentAnswer(timeline: readonly TimelineEntry[]): TimelineEntry | null {
  let latest: TimelineEntry | null = null;
  for (const entry of timeline) {
    if (entry.type !== "comment" || entry.actor_type !== "agent") continue;
    if (!entry.content || isDeletedComment(entry)) continue;
    if (!latest || entry.created_at >= latest.created_at) latest = entry;
  }
  return latest;
}

/**
 * Issue header controls: read the latest agent answer aloud (also bound to
 * the `readLatestAnswer` shortcut) and toggle auto-reading of new answers.
 */
export function IssueReadAloudControls({ timeline }: { timeline: readonly TimelineEntry[] }) {
  const { t } = useT("issues");
  const latest = useMemo(() => latestAgentAnswer(timeline), [timeline]);
  const autoRead = useSpeechStore((s) => s.autoRead);
  const toggleAutoRead = useSpeechStore((s) => s.toggleAutoRead);
  const overrides = useShortcutStore((s) => s.overrides);

  useEffect(() => {
    if (!latest?.content) return;
    const { id, content } = latest;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isImeComposing(e)) return;
      if (!shortcutMatchesEvent(getShortcut("readLatestAnswer"), e)) return;
      if (isEditableShortcutTarget(e.target)) return;
      e.preventDefault();
      if (useSpeechStore.getState().speakingId === id) stopSpeaking();
      else speak(id, markdownToSpeech(content));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [latest, overrides]);

  if (!isSpeechSupported()) return null;

  const autoReadLabel = autoRead ? t(($) => $.speech.auto_read_off) : t(($) => $.speech.auto_read_on);
  return (
    <>
      {latest && (
        <SpeakButton
          id={latest.id}
          markdown={latest.content}
          className="text-muted-foreground"
          label={t(($) => $.speech.read_latest_answer)}
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn("text-muted-foreground", autoRead && "text-foreground bg-muted")}
        aria-label={autoReadLabel}
        aria-pressed={autoRead}
        title={autoReadLabel}
        onClick={toggleAutoRead}
      >
        <AudioLines />
      </Button>
    </>
  );
}
