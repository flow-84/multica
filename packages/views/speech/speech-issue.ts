import type { QueryClient } from "@tanstack/react-query";
import { issueDetailOptions } from "@multica/core/issues/queries";
import type { SpeechIssue } from "./speech-engine";

/**
 * The issue a spoken answer belongs to, from cache or the API; null on failure.
 * `staleTime: 0` forces a fresh read when the current status matters.
 */
export function loadSpeechIssue(
  qc: QueryClient,
  wsId: string,
  issueId: string,
  staleTime = 60_000,
): Promise<SpeechIssue | null> {
  return qc
    .fetchQuery({ ...issueDetailOptions(wsId, issueId), staleTime })
    .then((issue) => issue ?? null, () => null);
}
