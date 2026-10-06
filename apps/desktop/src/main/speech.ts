import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";

// `say` without `-v` speaks with the voice chosen under System Settings →
// Accessibility → Spoken Content, which can be a Siri voice. Chromium's
// speechSynthesis never exposes Siri voices, so desktop routes read-aloud here.
let current: ChildProcess | null = null;

function stop(): void {
  current?.kill();
  current = null;
}

// GUI apps start without the login shell PATH, so the Claude CLI is looked up
// in its usual install locations.
const CLAUDE_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".claude", "local", "claude"),
];
const SUMMARY_TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 12_000;

const SUMMARY_SYSTEM_PROMPT = [
  "You turn an AI agent's comment on a task card into a spoken status update for a busy person.",
  "Reply with at most three short sentences of plain spoken text: no Markdown, no lists, no quotes.",
  "Cover only, in this order: whether the work is done and the card can be closed;",
  "anything open, forgotten, or needing a decision or discussion;",
  "the next step and who takes it.",
  "Skip whatever does not apply. Never mention file names, commands, code, commit hashes,",
  "IDs, URLs, test counts, or other technical details.",
].join(" ");

interface SummaryInput {
  identifier: string;
  title: string;
  status: string;
  text: string;
  locale: string;
}

function isSummaryInput(v: unknown): v is SummaryInput {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["identifier", "title", "status", "text", "locale"].every((k) => typeof o[k] === "string");
}

/** Short spoken summary from the Claude CLI on the user's own login, or null. */
function summarize(input: SummaryInput): Promise<string | null> {
  const bin = CLAUDE_CANDIDATES.find((p) => existsSync(p));
  if (!bin || !input.text.trim()) return Promise.resolve(null);
  const prompt = [
    `Answer in the language with the BCP 47 tag "${input.locale}".`,
    `Card ${input.identifier}: ${input.title}`,
    `Card status: ${input.status}`,
    "Agent comment:",
    input.text.slice(0, MAX_INPUT_CHARS),
  ].join("\n");

  return new Promise((resolve) => {
    // `--setting-sources project` from a neutral cwd keeps the user's global
    // hooks and instructions out of this one-shot call; `--bare` is not used
    // because it skips the keychain login.
    const child = spawn(
      bin,
      [
        "-p",
        "--model", "haiku",
        "--no-session-persistence",
        "--tools", "",
        "--setting-sources", "project",
        "--system-prompt", SUMMARY_SYSTEM_PROMPT,
        "--output-format", "text",
      ],
      { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => child.kill(), SUMMARY_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
    child.stdin?.end(prompt);
  });
}

export function setupSpeech(): void {
  if (process.platform !== "darwin") return;

  ipcMain.handle("speech:speak", (_event, text: unknown) =>
    new Promise<void>((resolve) => {
      if (typeof text !== "string" || !text.trim()) return resolve();
      stop();
      const child = spawn("/usr/bin/say", ["-f", "-"], { stdio: ["pipe", "ignore", "ignore"] });
      current = child;
      child.on("error", () => resolve());
      child.on("exit", () => {
        if (current === child) current = null;
        resolve();
      });
      child.stdin?.end(text);
    }),
  );
  ipcMain.handle("speech:stop", () => stop());
  ipcMain.handle("speech:summarize", (_event, input: unknown) =>
    isSummaryInput(input) ? summarize(input) : null,
  );
}
