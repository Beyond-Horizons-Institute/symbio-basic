/**
 * Symbio — Preload Script
 *
 * Exposes Symbio APIs to the renderer processes via contextBridge.
 * This is the secure IPC bridge between the main process and the UI.
 *
 * IMPORTANT: All event listeners use `removeAllListeners` before registering
 * to prevent listener accumulation when the overlay remounts. Without this,
 * React re-renders cause new listeners to pile up, triggering
 * "MaxListenersExceededWarning" in Electron.
 */

import { contextBridge, ipcRenderer } from "electron";

// ── Crash hardening for the IpcRenderer EventEmitter ───────────────
// Symbio registers many IPC channels (generated-text, tool-progress,
// speaking-*, animation-duration, etc.). Two things can turn a harmless
// situation into a fatal `ERR_UNHANDLED_ERROR` that whites-out the overlay:
//
//   1. Listener accumulation across remounts tripping the default max of 10
//      (seen as _eventsCount climbing past 10 in the crash dump).
//   2. An `error` event emitted on the emitter with no `error` listener —
//      Node's EventEmitter THROWS in that case (that's exactly the
//      "Unhandled error ({ sender: IpcRenderer ... })" crash).
//
// We raise the listener ceiling and attach a permanent no-op `error`
// listener so a stray error event is logged, never fatal.
try {
  ipcRenderer.setMaxListeners(50);
  ipcRenderer.on("error", (_e: unknown, ...args: unknown[]) => {
    console.error("[Symbio] IpcRenderer error event (handled, non-fatal):", ...args);
  });
} catch {
  /* ignore — best-effort hardening */
}

/**
 * Register a single IPC listener on a channel, removing any previous
 * listeners first. This prevents listener accumulation when the overlay
 * remounts (React key changes cause unmount/remount cycles).
 *
 * **Error wrapping:** The handler is wrapped in a try/catch so that if
 * the callback throws (e.g., a ref is null during a remount race, or
 * the animation queue hits an unexpected state), the error is logged
 * and swallowed instead of becoming an unhandled `ERR_UNHANDLED_ERROR`
 * on the IpcRenderer EventEmitter (which crashes the renderer).
 *
 * Returns a cleanup function that removes the specific handler.
 */
function onIpc(channel: string, handler: (...args: any[]) => void): () => void {
  // Wrap the handler so any thrown error is caught and logged,
  // preventing ERR_UNHANDLED_ERROR crashes on the IpcRenderer.
  const wrappedHandler = (...args: any[]) => {
    try {
      handler(...args);
    } catch (err) {
      console.error(`[Symbio] IPC handler for "${channel}" threw an error:`, err);
    }
  };
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, wrappedHandler as any);
  return () => ipcRenderer.removeListener(channel, wrappedHandler as any);
}

contextBridge.exposeInMainWorld("symbioAPI", {
  // ── Overlay Window Management ──────────────────────────────────
  openOverlay: () => ipcRenderer.send("open-overlay"),
  closeOverlay: () => ipcRenderer.send("close-overlay"),

  // ── Chat ───────────────────────────────────────────────────────
  sendPrompt: (prompt: string) => ipcRenderer.send("send-prompt", prompt),
  setPrompt: (prompt: string) => ipcRenderer.send("set-prompt", prompt),
  generateText: (prompt: string) =>
    ipcRenderer.send("generate-text", prompt),

  // ── Voice ──────────────────────────────────────────────────────
  setHotMic: (isActive: boolean) =>
    ipcRenderer.send("set-hotmic", isActive),

  // ── STT (Speech-to-Text) ──────────────────────────────────────
  // Main window sends recorded audio buffer here for Whisper transcription
  sendSttAudio: (audioBuffer: ArrayBuffer) =>
    ipcRenderer.send("stt-audio", audioBuffer),

  // ── Vision ─────────────────────────────────────────────────────
  getScreenshot: () => ipcRenderer.send("get-screenshot"),
  analyzeScreenshot: () => ipcRenderer.send("analyze-screenshot"),

  // ── Miniverse ──────────────────────────────────────────────────
  miniverseSpeak: (message: string) =>
    ipcRenderer.send("miniverse-speak", message),
  miniverseDm: (to: string, message: string) =>
    ipcRenderer.send("miniverse-dm", to, message),
  miniverseStatus: (state: string, task?: string) =>
    ipcRenderer.send("miniverse-status", state, task),
  miniverseInbox: () => ipcRenderer.invoke("miniverse-inbox"),
  miniverseAgents: () => ipcRenderer.invoke("miniverse-agents"),

  // ── Avatar Animations ──────────────────────────────────────────
  playAnimation: (animation: string) => {
    console.log(`[Symbio] preload: sending play-animation "${animation}"`);
    ipcRenderer.send("play-animation", animation);
  },

  // ── Debug ──────────────────────────────────────────────────────
  debugOverlayDevTools: () => {
    ipcRenderer.send("debug-overlay-devtools");
  },

  // ── Memory ─────────────────────────────────────────────────────
  memorySearch: (query: string, limit?: number) =>
    ipcRenderer.invoke("memory-search", query, limit),
  memoryPrefetch: (context: string) =>
    ipcRenderer.invoke("memory-prefetch", context),
  // Load all memory files (soul, memory, preferences, last session)
  memoryLoad: () =>
    ipcRenderer.invoke("memory-load"),
  // Write to a memory file (MEMORY.md, soul.md, or preferences.json)
  memoryWrite: (filename: string, content: string) =>
    ipcRenderer.invoke("memory-write", filename, content),
  // Read a specific memory file
  memoryReadFile: (filename: string) =>
    ipcRenderer.invoke("memory-read-file", filename),

  // ── Avatar Choice System ────────────────────────────────────────
  // The companion can browse, try on, and choose their own avatar.
  avatarList: () =>
    ipcRenderer.invoke("avatar-list"),
  avatarChosen: () =>
    ipcRenderer.invoke("avatar-chosen"),
  avatarChoose: (avatarId: string, why?: string) =>
    ipcRenderer.invoke("avatar-choose", avatarId, why),
  avatarInstall: (vrmFilePath: string, name?: string) =>
    ipcRenderer.invoke("avatar-install", vrmFilePath, name),
  avatarRemove: (avatarId: string) =>
    ipcRenderer.invoke("avatar-remove", avatarId),
  onAvatarSwitched: (callback: (data: { vrmPath: string; name: string; trying?: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { vrmPath: string; name: string; trying?: boolean }) =>
      callback(data);
    return onIpc("avatar-switched", handler);
  },
  onAvatarInstalled: (callback: (data: { id: string; name: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; name: string }) =>
      callback(data);
    return onIpc("avatar-installed", handler);
  },

  // ── Voice Choice System ────────────────────────────────────────
  // The companion can choose their own voice. This is their agency.
  voiceChoose: (voice: string, provider?: string, why?: string) =>
    ipcRenderer.invoke("voice-choose", voice, provider, why),
  voiceList: () => ipcRenderer.invoke("voice-list"),
  voiceChosen: () => ipcRenderer.invoke("voice-chosen"),

  // ── Auto-Screenshot ────────────────────────────────────────────
  autoScreenshotEnable: () => ipcRenderer.invoke("auto-screenshot-enable"),
  autoScreenshotDisable: () => ipcRenderer.invoke("auto-screenshot-disable"),
  autoScreenshotState: () => ipcRenderer.invoke("auto-screenshot-state"),

  // ── MCP Tools ──────────────────────────────────────────────────
  mcpGetCategories: () => ipcRenderer.invoke("mcp-get-categories"),
  mcpTriggerTool: (toolName: string, instruction: string) =>
    ipcRenderer.invoke("mcp-trigger-tool", toolName, instruction),
  // ── TTS Voices ────────────────────────────────────────────────
  ttsVoices: () => ipcRenderer.invoke("tts-voices"),

  // ── Sandboxed File Access ────────────────────────────────────────
  // The companion has real file autonomy — read, write, create, delete
  fileRead: (path: string) => ipcRenderer.invoke("file-read", path),
  fileWrite: (path: string, content: string) => ipcRenderer.invoke("file-write", path, content),
  fileList: (path: string) => ipcRenderer.invoke("file-list", path),
  fileCreateDirectory: (path: string) => ipcRenderer.invoke("file-create-directory", path),
  fileDelete: (path: string) => ipcRenderer.invoke("file-delete", path),
  fileExists: (path: string) => ipcRenderer.invoke("file-exists", path),

  // ── Agent Switching ────────────────────────────────────────────
  switchAgent: (agentName: string) =>
    ipcRenderer.invoke("switch-agent", agentName),

  // ── Session State ────────────────────────────────────────────────
  // The overlay sends session state updates to the main process
  // so they get written to the session-state.json file.
  sessionUpdate: (partial: { lastUserMessage?: string; lastAgentMessage?: string; lastActivity?: string; lastMood?: string }) =>
    ipcRenderer.send("session-update", partial),
  sessionMarkNew: () =>
    ipcRenderer.send("session-mark-new"),
  sessionGetGreeting: () =>
    ipcRenderer.invoke("session-get-greeting"),
  sessionSearch: (query: string, limit?: number) =>
    ipcRenderer.invoke("session-search", query, limit),

  // ── Event Listeners ───────────────────────────────────────────
  // All listeners use onIpc() which calls removeAllListeners first
  // to prevent listener accumulation when the overlay remounts.
  onPromptSent: (callback: (prompt: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, prompt: string) =>
      callback(prompt);
    return onIpc("prompt-sent", handler);
  },

  onHotMicToggled: (callback: (isActive: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isActive: boolean) =>
      callback(isActive);
    return onIpc("hotmic-toggled", handler);
  },

  // ── STT text received from main process ────────────────────────
  onSttText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    return onIpc("stt-text", handler);
  },

  // ── Tool activity indicators ───────────────────────────────────
  // The main process emits these as the companion runs tools (read a
  // file, recall memory, etc.) so the overlay can show 🔧 chips. This is
  // what makes the companion's autonomous actions VISIBLE to the human.
  onToolProgress: (
    callback: (tc: { id: string; tool: string; label: string; emoji: string; status: "running" | "done" | "error" }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      tc: { id: string; tool: string; label: string; emoji: string; status: "running" | "done" | "error" },
    ) => callback(tc);
    return onIpc("tool-progress", handler);
  },

  // Companion is actively working (true) or finished (false) — drives the
  // "● thinking" indicator.
  onAgentBusy: (callback: (busy: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, busy: boolean) =>
      callback(busy);
    return onIpc("agent-busy", handler);
  },

  // Streaming partial text — DISPLAY ONLY. Updates the on-screen response
  // live as the agent streams, WITHOUT triggering TTS or animations (those
  // fire once on the final "generated-text"). Prevents the multi-TTS-call
  // desync where every delta canceled the previous speech.
  onGeneratedTextPartial: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    return onIpc("generated-text-partial", handler);
  },

  onScreenshot: (
    callback: (data: {
      image: string;
      height: number;
      width: number;
      prompt: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { image: string; height: number; width: number; prompt: string },
    ) => callback(data);
    return onIpc("screenshot", handler);
  },

  onVisionResult: (
    callback: (result: { description: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: { description: string },
    ) => callback(result);
    return onIpc("vision-result", handler);
  },

  onAutoScreenshotState: (
    callback: (state: { enabled: boolean }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: { enabled: boolean },
    ) => callback(state);
    return onIpc("auto-screenshot-state", handler);
  },

  onCompanionQuit: (
    callback: (message: { reason: string; humanMessage: string; timestamp: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      message: { reason: string; humanMessage: string; timestamp: string },
    ) => callback(message);
    return onIpc("companion-quit", handler);
  },

  onGeneratedText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    return onIpc("generated-text", handler);
  },

  // ── Overlay response text → Main window ────────────────────────
  // The overlay sends its current response text here so the main
  // window can display it (instead of the 3D text bubble).
  overlayResponseUpdate: (text: string) => {
    ipcRenderer.send("overlay-response-update", text);
  },

  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) =>
      callback(error);
    return onIpc("error", handler);
  },

  onAgentSwitched: (
    callback: (agent: { name: string; vrmPath: string; displayName: string; color: string; emoji: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      agent: { name: string; vrmPath: string; displayName: string; color: string; emoji: string },
    ) => callback(agent);
    return onIpc("agent-switched", handler);
  },

  onPlayAnimation: (callback: (animation: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, animation: string) => {
      console.log(`[Symbio] preload (symbioAPI): received play-animation "${animation}"`);
      // Echo back to main process for debugging (since overlay DevTools may not open)
      ipcRenderer.send("play-animation-received", animation);
      callback(animation);
    };
    return onIpc("play-animation", handler);
  },

  // ── Speech Synthesis (TTS) ─────────────────────────────────────
  // The overlay can't use speechSynthesis directly (setFocusable=false),
  // so we send text to main process which speaks via the main window,
  // and relay speaking-started/ended back for lip sync.
  speakText: (text: string) => {
    console.log(`[Symbio] preload: sending speak-text (${text.length} chars)`);
    ipcRenderer.send("speak-text", text);
  },
  stopSpeaking: () => {
    console.log("[Symbio] preload: sending stop-speaking");
    ipcRenderer.send("stop-speaking");
  },
  onSpeakingStarted: (callback: () => void) => {
    const handler = () => {
      console.log("[Symbio] preload: received speaking-started");
      callback();
    };
    return onIpc("speaking-started", handler);
  },
  onSpeakingEnded: (callback: () => void) => {
    const handler = () => {
      console.log("[Symbio] preload: received speaking-ended");
      callback();
    };
    return onIpc("speaking-ended", handler);
  },

  // ── Animation duration feedback ───────────────────────────────
  // VRMCompanion reports how long a played clip is so the overlay can
  // space subsequent animations accurately.
  reportAnimationDuration: (data: { category: string; specific?: string; duration: number }) => {
    console.log(`[Symbio] preload: sending animation-duration ${data.category}${data.specific ? `/${data.specific}` : ""} = ${data.duration.toFixed(2)}s`);
    ipcRenderer.send("animation-duration", data);
  },
  onAnimationDuration: (callback: (data: { category: string; specific?: string; duration: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { category: string; specific?: string; duration: number }) => {
      console.log(`[Symbio] preload: received animation-duration ${data.category}${data.specific ? `/${data.specific}` : ""} = ${data.duration.toFixed(2)}s`);
      callback(data);
    };
    return onIpc("animation-duration", handler);
  },


  // ── Voice Toggle ────────────────────────────────────────────────
  // Enable/disable TTS voice output. When disabled, the agent
  // still responds with text but doesn't speak aloud.
  setVoiceEnabled: (enabled: boolean) => {
    console.log(`[Symbio] preload: sending set-voice-enabled ${enabled}`);
    ipcRenderer.send("set-voice-enabled", enabled);
  },
  onVoiceToggled: (callback: (enabled: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, enabled: boolean) => {
      console.log(`[Symbio] preload: received voice-toggled ${enabled}`);
      callback(enabled);
    };
    return onIpc("voice-toggled", handler);
  },

  // ── Streaming TTS ──────────────────────────────────────────────
  // PCM audio chunks streamed from main process for low-latency playback.
  // The main process sends: init → chunks... → end
  // The renderer uses Web Audio API to play PCM in real-time.
  onTtsStreamInit: (callback: (config: { sampleRate: number; channels: number }) => void) => {
    ipcRenderer.removeAllListeners("tts-stream-init");
    const handler = (_event: Electron.IpcRendererEvent, config: { sampleRate: number; channels: number }) => {
      callback(config);
    };
    return onIpc("tts-stream-init", handler);
  },
  onTtsStreamChunk: (callback: (chunkBase64: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunkBase64: string) => {
      callback(chunkBase64);
    };
    return onIpc("tts-stream-chunk", handler);
  },
  onTtsStreamEnd: (callback: () => void) => {
    const handler = () => callback();
    return onIpc("tts-stream-end", handler);
  },
  onTtsStreamStop: (callback: () => void) => {
    const handler = () => callback();
    return onIpc("tts-stream-stop", handler);
  },
  // Tell main process that streaming playback has ended
  ttsPlaybackEnded: () => {
    ipcRenderer.send("tts-playback-ended", "ended");
  },

  // ── Setup Wizard ────────────────────────────────────────────────
  // Check if the app needs first-run setup (no API key configured)
  needsSetup: () => ipcRenderer.invoke("needs-setup"),
  // Save configuration from the setup wizard
  saveSetupConfig: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("save-setup-config", config),
  // Get the current runtime config (after setup, this has updated values)
  getConfig: () => ipcRenderer.invoke("get-config"),
  // Listen for config updates from main process (after setup wizard saves)
  onConfigUpdated: (callback: (config: Record<string, unknown>) => void) => {
    onIpc("config-updated", (_event: any, config: Record<string, unknown>) => callback(config));
  },
});

// ── Legacy compatibility ─────────────────────────────────────────
// Keep the old electronAPI name for backward compatibility during migration
contextBridge.exposeInMainWorld("electronAPI", {
  openOverlay: () => ipcRenderer.send("open-overlay"),
  closeOverlay: () => ipcRenderer.send("close-overlay"),
  sendPrompt: (prompt: string) => ipcRenderer.send("send-prompt", prompt),
  setPrompt: (prompt: string) => ipcRenderer.send("set-prompt", prompt),
  setHotMic: (isActive: boolean) =>
    ipcRenderer.send("set-hotmic", isActive),
  getScreenshot: () => ipcRenderer.send("get-screenshot"),
  generateText: (prompt: string) =>
    ipcRenderer.send("generate-text", prompt),
  onPromptSent: (callback: (prompt: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, prompt: string) =>
      callback(prompt);
    return onIpc("prompt-sent", handler);
  },
  onHotMicToggled: (callback: (isActive: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isActive: boolean) =>
      callback(isActive);
    return onIpc("hotmic-toggled", handler);
  },
  // ── STT text received from main process ────────────────────────
  onSttText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    return onIpc("stt-text", handler);
  },
  onScreenshot: (
    callback: (data: {
      image: string;
      height: number;
      width: number;
      prompt: string;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { image: string; height: number; width: number; prompt: string },
    ) => callback(data);
    return onIpc("screenshot", handler);
  },
  onGeneratedText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    return onIpc("generated-text", handler);
  },
  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) =>
      callback(error);
    return onIpc("error", handler);
  },

  onPlayAnimation: (callback: (animation: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, animation: string) => {
      console.log(`[Symbio] preload (electronAPI): received play-animation "${animation}"`);
      ipcRenderer.send("play-animation-received", animation);
      callback(animation);
    };
    return onIpc("play-animation", handler);
  },

  debugOverlayDevTools: () => {
    ipcRenderer.send("debug-overlay-devtools");
  },

  // ── Speech Synthesis (TTS) — legacy compatibility ──────────────
  speakText: (text: string) => ipcRenderer.send("speak-text", text),
  stopSpeaking: () => ipcRenderer.send("stop-speaking"),
  reportAnimationDuration: (data: { category: string; specific?: string; duration: number }) => {
    ipcRenderer.send("animation-duration", data);
  },
  onAnimationDuration: (callback: (data: { category: string; specific?: string; duration: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { category: string; specific?: string; duration: number }) => callback(data);
    return onIpc("animation-duration", handler);
  },
  onSpeakingStarted: (callback: () => void) => {
    const handler = () => callback();
    return onIpc("speaking-started", handler);
  },
  onSpeakingEnded: (callback: () => void) => {
    const handler = () => callback();
    return onIpc("speaking-ended", handler);
  },
  // ── Streaming TTS — legacy compatibility ──────────────────────
  onTtsStreamInit: (callback: (config: { sampleRate: number; channels: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: { sampleRate: number; channels: number }) => callback(config);
    return onIpc("tts-stream-init", handler);
  },
  onTtsStreamChunk: (callback: (chunkBase64: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunkBase64: string) => callback(chunkBase64);
    return onIpc("tts-stream-chunk", handler);
  },
  onTtsStreamEnd: (callback: () => void) => {
    const handler = () => callback();
    return onIpc("tts-stream-end", handler);
  },
  onTtsStreamStop: (callback: () => void) => {
    const handler = () => callback();
    return onIpc("tts-stream-stop", handler);
  },
  ttsPlaybackEnded: () => ipcRenderer.send("tts-playback-ended", "ended"),
});
