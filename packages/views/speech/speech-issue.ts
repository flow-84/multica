import type { QueryClient } from "@tanstack/react-query";
import { issueDetailOptions } from "@multica/core/issues/queries";
import type { SpeechIssue } from "./speech-engine";

/** The issue a spoken answer belongs to, from cache or the API; null on failure. */
export function loadSpeechIssue(
  qc: QueryClient,
  wsId: string,
  issueId: string,
): Promise<SpeechIssue | null> {
  return qc
    .fetchQuery({ ...issueDetailOptions(wsId, issueId), staleTime: 60_000 })
    .then((issue) => issue ?? null, () => null);
}
