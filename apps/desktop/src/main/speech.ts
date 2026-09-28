import { spawn, type ChildProcess } from "node:child_process";
import { ipcMain } from "electron";

// `say` without `-v` speaks with the voice chosen under System Settings →
// Accessibility → Spoken Content, which can be a Siri voice. Chromium's
// speechSynthesis never exposes Siri voices, so desktop routes read-aloud here.
let current: ChildProcess | null = null;

function stop(): void {
  current?.kill();
  current = null;
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
}
