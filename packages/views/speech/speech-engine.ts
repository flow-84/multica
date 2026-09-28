import { useSpeechStore } from "@multica/core/speech";

/**
 * Speaks one text to the end. `speak` resolves when playback finished or was
 * stopped; `stop` interrupts whatever is playing.
 */
export interface SpeechBackend {
  speak: (text: string) => Promise<void>;
  stop: () => void;
}

interface SpeechItem {
  id: string;
  text: string;
}

// Some Chromium voices stop mid-utterance after roughly 15 seconds, so long
// answers are spoken as a sequence of sentence-sized utterances.
const MAX_CHUNK_LENGTH = 220;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
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

const browserBackend: SpeechBackend = {
  speak: (text) =>
    new Promise<void>((resolve) => {
      const s = synth();
      if (!s) return resolve();
      const lang = navigator.language || "en-US";
      const voice = pickVoice(s, lang);
      const chunks = splitIntoChunks(text);
      chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        utterance.lang = voice?.lang ?? lang;
        if (voice) utterance.voice = voice;
        if (index === chunks.length - 1) {
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
        }
        s.speak(utterance);
      });
    }),
  stop: () => synth()?.cancel(),
};

let backend: SpeechBackend | null = null;

/**
 * Platforms with a better voice than the browser's (desktop uses the macOS
 * system voice, which can be a Siri voice) install their backend at startup.
 */
export function setSpeechBackend(next: SpeechBackend | null): void {
  backend = next;
}

function activeBackend(): SpeechBackend | null {
  return backend ?? (synth() ? browserBackend : null);
}

export function isSpeechSupported(): boolean {
  return activeBackend() !== null;
}

const queue: SpeechItem[] = [];
// Bumped on every stop. A stopped backend still resolves its pending
// `speak`; comparing generations keeps that from starting the next item.
let generation = 0;

function playNext(): void {
  const b = activeBackend();
  const item = queue.shift();
  if (!b || !item) {
    useSpeechStore.getState().setSpeakingId(null);
    return;
  }
  useSpeechStore.getState().setSpeakingId(item.id);
  const current = generation;
  void b
    .speak(item.text)
    .catch(() => undefined)
    .then(() => {
      if (current === generation) playNext();
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
  if (!text.trim() || !activeBackend()) return;
  queue.push({ id, text });
  if (useSpeechStore.getState().speakingId === null) playNext();
}

export function stopSpeaking(): void {
  generation += 1;
  queue.length = 0;
  activeBackend()?.stop();
  useSpeechStore.getState().setSpeakingId(null);
}
