"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useWSEvent } from "@multica/core/realtime";
import { useSpeechStore } from "@multica/core/speech";
import type { CommentCreatedPayload } from "@multica/core/types";
import { useT } from "../i18n";
import { enqueue } from "./speech-engine";
import { markdownToSpeech } from "./speech-text";

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

        const text = markdownToSpeech(comment.content ?? "");
        if (!text) return;
        void qc
          .fetchQuery({ ...issueDetailOptions(wsId, comment.issue_id), staleTime: 60_000 })
          .then((issue) => issue?.identifier ?? null, () => null)
          .then((identifier) => {
            const prefix = identifier
              ? t(($) => $.speech.new_answer_on, { identifier })
              : t(($) => $.speech.new_answer);
            enqueue(comment.id, `${prefix} ${text}`);
          });
      },
      [qc, wsId, t],
    ),
  );

  return null;
}
