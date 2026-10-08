"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWSEvent } from "@multica/core/realtime";
import { useSpeechStore } from "@multica/core/speech";
import type {
  Comment,
  CommentCreatedPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
} from "@multica/core/types";
import { useT } from "../i18n";
import { decideRunEnd, mentionsMe, type AutoReadReason } from "./auto-read-decision";
import { enqueue } from "./speech-engine";
import { loadSpeechIssue } from "./speech-issue";

// Module-level so an answer is spoken once per renderer even when several
// workspace layouts (desktop tabs) mount this listener at the same time.
const spokenCommentIds = new Set<string>();
const handledTaskIds = new Set<string>();
const lastAgentComment = new Map<string, Comment>();

// The run's final comment and status change can reach the client just after
// the task event, so the decision waits briefly before reading them.
const RUN_END_SETTLE_MS = 1_500;

const PREFIX_KEYS = {
  mentioned: "mentioned_on",
  done: "done_on",
  blocked: "blocked_on",
  stalled: "stalled_on",
  failed: "failed_on",
} as const satisfies Record<AutoReadReason, string>;

function myUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

/**
 * While the read-aloud preference is on, speaks an agent answer only when it
 * mentions the user or when a run ends and the work stops there: the issue is
 * done or blocked, the run failed, or no other run picks it up. Handoffs to
 * other agents or people stay silent. Queued, so answers never interrupt each
 * other.
 */
export function AutoReadAgentAnswers() {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { t } = useT("issues");

  const read = useCallback(
    (reason: AutoReadReason, issueId: string, comment: Comment | null) => {
      void loadSpeechIssue(qc, wsId, issueId).then((issue) => {
        const prefix = t(($) => $.speech[PREFIX_KEYS[reason]], {
          identifier: issue?.identifier ?? "",
        });
        if (comment && !spokenCommentIds.has(comment.id) && comment.content?.trim()) {
          spokenCommentIds.add(comment.id);
          enqueue({ commentId: comment.id, markdown: comment.content, issue, prefix });
        } else {
          enqueue({ commentId: `run-end:${issueId}:${Date.now()}`, markdown: prefix, issue });
        }
      });
    },
    [qc, wsId, t],
  );

  useWSEvent(
    "comment:created",
    useCallback(
      (payload: unknown) => {
        const comment = (payload as CommentCreatedPayload | null)?.comment;
        if (!comment || comment.author_type !== "agent") return;
        lastAgentComment.set(comment.issue_id, comment);
        if (useSpeechStore.getState().autoRead !== true) return;
        if (mentionsMe(comment.content ?? "", myUserId())) read("mentioned", comment.issue_id, comment);
      },
      [read],
    ),
  );

  const onRunEnd = useCallback(
    (payload: TaskCompletedPayload | TaskFailedPayload | null, failed: boolean) => {
      if (!payload?.issue_id || payload.chat_session_id) return;
      if (failed && (payload as TaskFailedPayload).retry_pending) return;
      if (useSpeechStore.getState().autoRead !== true) return;
      if (handledTaskIds.has(payload.task_id)) return;
      handledTaskIds.add(payload.task_id);
      const issueId = payload.issue_id;

      setTimeout(() => {
        void Promise.all([
          loadSpeechIssue(qc, wsId, issueId, 0),
          api.getActiveTasksForIssue(issueId).then(
            (r) => (r.tasks ?? []).some((task) => task.id !== payload.task_id),
            () => false,
          ),
        ]).then(([issue, hasActiveTask]) => {
          if (!issue) return;
          // Consumed here so a later run without its own comment does not
          // re-read this one.
          const comment = lastAgentComment.get(issueId) ?? null;
          lastAgentComment.delete(issueId);
          const reason = decideRunEnd({
            issue,
            hasActiveTask,
            lastComment: comment?.content ?? null,
            myUserId: myUserId(),
            failed,
          });
          // A stop right after an answer that was already read for mentioning
          // the user adds nothing.
          if (reason === "stalled" && comment && spokenCommentIds.has(comment.id)) return;
          if (reason) read(reason, issueId, comment);
        });
      }, RUN_END_SETTLE_MS);
    },
    [qc, wsId, read],
  );

  useWSEvent(
    "task:completed",
    useCallback((p: unknown) => onRunEnd(p as TaskCompletedPayload | null, false), [onRunEnd]),
  );
  useWSEvent(
    "task:failed",
    useCallback((p: unknown) => onRunEnd(p as TaskFailedPayload | null, true), [onRunEnd]),
  );

  return null;
}
