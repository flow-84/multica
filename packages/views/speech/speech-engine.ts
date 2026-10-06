import { useSpeechStore } from "@multica/core/speech";
import type { Issue } from "@multica/core/types";
import { markdownToSpeech } from "./speech-text";

/** What a summarizer gets to condense one agent answer into a few sentences. */
export interface SummaryInput {
  identifier: string;
  title: string;
  status: string;
  text: string;
  /** BCP 47 language the summary is spoken in, e.g. "de-DE". */
  locale: string;
}

/**
 * Speaks one text to the end. `speak` resolves when playback finished or was
 * stopped; `stop` interrupts whatever is playing. `summarize`, when present,
 * turns an answer into a short spoken summary, or null when it cannot.
 */
export interface SpeechBackend {
  speak: (text: string) => Promise<void>;
  stop: () => void;
  summarize?: (input: SummaryInput) => Promise<string | null>;
}

export type SpeechIssue = Pick<Issue, "id" | "identifier" | "title" | "status" | "project_id">;

/** One agent answer to read aloud. */
export interface SpeechRequest {
  commentId: string;
  markdown: string;
  issue: SpeechIssue | null;
  /** Spoken before the answer, e.g. "New answer on MUL-1." */
  prefix?: string;
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

/** Whether answers are read as a short summary rather than in full. */
export function canSummarize(): boolean {
  return !!activeBackend()?.summarize;
}

const queue: SpeechRequest[] = [];
// Summaries cost tokens, so each comment is summarized at most once.
const summaries = new Map<string, string>();
// Bumped on every stop. A stopped backend still resolves its pending
// `speak`; comparing generations keeps that from starting the next item.
let generation = 0;

async function spokenText(b: SpeechBackend, req: SpeechRequest): Promise<string> {
  const full = markdownToSpeech(req.markdown);
  if (!b.summarize || !req.issue || !useSpeechStore.getState().summarize) return full;
  const cached = summaries.get(req.commentId);
  if (cached) return cached;
  const summary = await b
    .summarize({
      identifier: req.issue.identifier,
      title: req.issue.title,
      status: req.issue.status,
      text: full,
      locale: typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
    })
    .catch(() => null);
  if (!summary?.trim()) return full;
  summaries.set(req.commentId, summary.trim());
  return summary.trim();
}

function playNext(): void {
  const b = activeBackend();
  const req = queue.shift();
  const { setSpeaking } = useSpeechStore.getState();
  if (!b || !req) {
    setSpeaking(null);
    return;
  }
  const item = {
    commentId: req.commentId,
    issueId: req.issue?.id ?? null,
    identifier: req.issue?.identifier ?? null,
    projectId: req.issue?.project_id ?? null,
  };
  const current = generation;
  setSpeaking({ ...item, preparing: true });
  void spokenText(b, req)
    .then((text) => {
      if (current !== generation) return;
      setSpeaking({ ...item, preparing: false });
      return b.speak(req.prefix ? `${req.prefix} ${text}` : text);
    })
    .catch(() => undefined)
    .then(() => {
      if (current === generation) playNext();
    });
}

/** Stop whatever is playing, drop the queue, and read `req` now. */
export function speak(req: SpeechRequest): void {
  stopSpeaking();
  if (!req.markdown.trim()) return;
  queue.push(req);
  playNext();
}

/** Read `req` after everything already queued. */
export function enqueue(req: SpeechRequest): void {
  if (!req.markdown.trim() || !activeBackend()) return;
  queue.push(req);
  if (useSpeechStore.getState().speaking === null) playNext();
}

export function stopSpeaking(): void {
  generation += 1;
  queue.length = 0;
  activeBackend()?.stop();
  useSpeechStore.getState().setSpeaking(null);
}
