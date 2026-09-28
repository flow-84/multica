import { useSpeechStore } from "@multica/core/speech";

interface SpeechItem {
  id: string;
  text: string;
}

// Some Chromium voices stop mid-utterance after roughly 15 seconds, so long
// answers are spoken as a sequence of sentence-sized utterances.
const MAX_CHUNK_LENGTH = 220;

const queue: SpeechItem[] = [];
// Bumped on every stop. `cancel()` fires end/error callbacks on utterances
// that were still pending; comparing generations ignores those stale events.
let generation = 0;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
}

export function isSpeechSupported(): boolean {
  return synth() !== null;
}

function splitIntoChunks(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_CHUNK_LENGTH) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function pickVoice(s: SpeechSynthesis, lang: string): SpeechSynthesisVoice | null {
  const voices = s.getVoices();
  const base = lang.split("-")[0]?.toLowerCase() ?? "";
  return (
    voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase() && v.localService) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(base)) ??
    null
  );
}

function playNext(): void {
  const s = synth();
  const item = queue.shift();
  if (!s || !item) {
    useSpeechStore.getState().setSpeakingId(null);
    return;
  }
  useSpeechStore.getState().setSpeakingId(item.id);
  const current = generation;
  const lang = navigator.language || "en-US";
  const voice = pickVoice(s, lang);
  const chunks = splitIntoChunks(item.text);
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = voice?.lang ?? lang;
    if (voice) utterance.voice = voice;
    if (index === chunks.length - 1) {
      const done = () => {
        if (current === generation) playNext();
      };
      utterance.onend = done;
      utterance.onerror = done;
    }
    s.speak(utterance);
  });
}

/** Stop whatever is playing, drop the queue, and speak `text` now. */
export function speak(id: string, text: string): void {
  stopSpeaking();
  if (!text.trim()) return;
  queue.push({ id, text });
  playNext();
}

/** Speak `text` after everything already queued. */
export function enqueue(id: string, text: string): void {
  if (!text.trim() || !synth()) return;
  queue.push({ id, text });
  if (useSpeechStore.getState().speakingId === null) playNext();
}

export function stopSpeaking(): void {
  generation += 1;
  queue.length = 0;
  synth()?.cancel();
  useSpeechStore.getState().setSpeakingId(null);
}
