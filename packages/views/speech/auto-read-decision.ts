import { issueColumnCategory } from "@multica/core/issues";
import { parseMentions } from "@multica/core/issues/comment-trigger-outcomes";
import type { Issue } from "@multica/core/types";

/** Why an agent answer is read aloud without being asked. */
export type AutoReadReason = "mentioned" | "done" | "blocked";

/** Whether the comment mentions the current user, directly or through @all. */
export function mentionsMe(markdown: string, myUserId: string | null): boolean {
  return parseMentions(markdown).some(
    (m) => m.type === "all" || (m.type === "member" && !!myUserId && m.id === myUserId),
  );
}

/** Whether the comment passes the work on to another agent, squad, or member. */
export function handsOff(markdown: string, myUserId: string | null): boolean {
  return parseMentions(markdown).some(
    (m) => m.type === "agent" || m.type === "squad" || (m.type === "member" && m.id !== myUserId),
  );
}

export interface RunEnd {
  issue: Pick<Issue, "status" | "status_category">;
  /** Another run on the issue is queued or running. */
  hasActiveTask: boolean;
  /** Markdown of the last agent comment on the issue, if one arrived. */
  lastComment: string | null;
  myUserId: string | null;
  failed: boolean;
}

/**
 * After an agent run ends, read aloud only when the issue is done or blocked
 * (waiting on a person). A run that stops with the issue still open, fails,
 * or hands off to another agent or person stays silent.
 */
export function decideRunEnd(run: RunEnd): AutoReadReason | null {
  if (run.hasActiveTask) return null;
  if (run.lastComment && handsOff(run.lastComment, run.myUserId)) return null;
  const category = issueColumnCategory(run.issue);
  if (category === "done") return "done";
  if (category === "closed") return null;
  if (run.issue.status === "blocked") return "blocked";
  return null;
}
