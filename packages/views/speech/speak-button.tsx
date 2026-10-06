import { Loader2, Square, Volume2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentWorkspace } from "@multica/core/paths";
import { useSpeechStore } from "@multica/core/speech";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { isSpeechSupported, speak, stopSpeaking } from "./speech-engine";
import { loadSpeechIssue } from "./speech-issue";

/** Toggle button that reads `markdown` aloud; pressing it again stops. */
export function SpeakButton({
  id,
  issueId,
  markdown,
  className,
  label,
}: {
  id: string;
  /** Issue the answer belongs to; enables the short summary and "go to issue". */
  issueId: string;
  markdown: string | null | undefined;
  className?: string;
  /** Overrides the default "Read aloud" label, e.g. for the latest-answer button. */
  label?: string;
}) {
  const { t } = useT("issues");
  const wsId = useCurrentWorkspace()?.id ?? null;
  const qc = useQueryClient();
  const speaking = useSpeechStore((s) => s.speaking?.commentId === id);
  const preparing = useSpeechStore((s) => s.speaking?.commentId === id && s.speaking.preparing);
  if (!isSpeechSupported() || !markdown) return null;

  const title = speaking ? t(($) => $.speech.stop_reading) : (label ?? t(($) => $.speech.read_aloud));
  const onClick = () => {
    if (speaking) return stopSpeaking();
    const pending = wsId ? loadSpeechIssue(qc, wsId, issueId) : Promise.resolve(null);
    void pending.then((issue) => speak({ commentId: id, markdown, issue }));
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label={title}
      aria-pressed={speaking}
      title={title}
      onClick={onClick}
    >
      {preparing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : speaking ? (
        <Square className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Volume2 className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}
