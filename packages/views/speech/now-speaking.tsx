"use client";

import { useEffect } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  getShortcut,
  isEditableShortcutTarget,
  shortcutMatchesEvent,
  useShortcutStore,
} from "@multica/core/shortcuts";
import { useSpeechStore } from "@multica/core/speech";
import { isImeComposing } from "@multica/core/utils";
import { SidebarMenuButton, SidebarMenuItem } from "@multica/ui/components/ui/sidebar";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { useNavigation } from "../navigation";
import { stopSpeaking } from "./speech-engine";

/** Marks the issue being read aloud wherever it appears (rows, cards, pins, tabs). */
export const SPEAKING_HIGHLIGHT = "ring-2 ring-inset ring-brand/70 bg-brand/10";

/**
 * Sidebar entry shown while an answer is read aloud: names the issue, opens it
 * on click (also bound to the `goToSpeakingIssue` shortcut), and stops playback.
 */
export function NowSpeaking() {
  const { t } = useT("issues");
  const speaking = useSpeechStore((s) => s.speaking);
  const overrides = useShortcutStore((s) => s.overrides);
  const navigation = useNavigation();
  const p = useWorkspacePaths();
  const issueId = speaking?.issueId ?? null;

  useEffect(() => {
    if (!issueId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isImeComposing(e)) return;
      if (!shortcutMatchesEvent(getShortcut("goToSpeakingIssue"), e)) return;
      if (isEditableShortcutTarget(e.target)) return;
      e.preventDefault();
      navigation.push(p.issueDetail(issueId));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [issueId, navigation, p, overrides]);

  if (!speaking || !issueId) return null;

  const label = speaking.preparing
    ? t(($) => $.speech.now_summarizing, { identifier: speaking.identifier ?? "" })
    : t(($) => $.speech.now_reading, { identifier: speaking.identifier ?? "" });
  return (
    <SidebarMenuItem className="group/speaking">
      <SidebarMenuButton
        className={cn("text-foreground", SPEAKING_HIGHLIGHT)}
        title={t(($) => $.speech.go_to_speaking_issue)}
        onClick={() => navigation.push(p.issueDetail(issueId))}
      >
        {speaking.preparing ? <Loader2 className="animate-spin" /> : <Volume2 className="animate-pulse" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          role="button"
          tabIndex={0}
          aria-label={t(($) => $.speech.stop_reading)}
          title={t(($) => $.speech.stop_reading)}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            stopSpeaking();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            stopSpeaking();
          }}
        >
          <Square className="size-3" />
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
