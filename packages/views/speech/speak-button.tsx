import { Square, Volume2 } from "lucide-react";
import { useSpeechStore } from "@multica/core/speech";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { isSpeechSupported, speak, stopSpeaking } from "./speech-engine";
import { markdownToSpeech } from "./speech-text";

/** Toggle button that reads `markdown` aloud; pressing it again stops. */
export function SpeakButton({
  id,
  markdown,
  className,
  label,
}: {
  id: string;
  markdown: string | null | undefined;
  className?: string;
  /** Overrides the default "Read aloud" label, e.g. for the latest-answer button. */
  label?: string;
}) {
  const { t } = useT("issues");
  const speaking = useSpeechStore((s) => s.speakingId === id);
  if (!isSpeechSupported() || !markdown) return null;

  const title = speaking ? t(($) => $.speech.stop_reading) : (label ?? t(($) => $.speech.read_aloud));
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label={title}
      aria-pressed={speaking}
      title={title}
      onClick={() => (speaking ? stopSpeaking() : speak(id, markdownToSpeech(markdown)))}
    >
      {speaking ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
    </Button>
  );
}
