"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useWSEvent } from "@multica/core/realtime";
import { useSpeechStore } from "@multica/core/speech";
import type { CommentCreatedPayload } from "@multica/core/types";
import { useT } from "../i18n";
import { enqueue } from "./speech-engine";
import { loadSpeechIssue } from "./speech-issue";

// Module-level so a comment is spoken once per renderer even when several
// workspace layouts (desktop tabs) mount this listener at the same time.
const spokenCommentIds = new Set<string>();

/**
 * Speaks every newly created agent comment in the workspace while the
 * read-aloud preference is on. Queued, so parallel agent runs are read one
 * after another instead of interrupting each other.
 */
export function AutoReadAgentAnswers() {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { t } = useT("issues");

  useWSEvent(
    "comment:created",
    useCallback(
      (payload: unknown) => {
        const comment = (payload as CommentCreatedPayload | null)?.comment;
        if (!comment || comment.author_type !== "agent") return;
        if (useSpeechStore.getState().autoRead !== true) return;
        if (spokenCommentIds.has(comment.id)) return;
        spokenCommentIds.add(comment.id);

        const markdown = comment.content ?? "";
        if (!markdown.trim()) return;
        void loadSpeechIssue(qc, wsId, comment.issue_id).then((issue) => {
          const prefix = issue
            ? t(($) => $.speech.new_answer_on, { identifier: issue.identifier })
            : t(($) => $.speech.new_answer);
          enqueue({ commentId: comment.id, markdown, issue, prefix });
        });
      },
      [qc, wsId, t],
    ),
  );

  return null;
}
