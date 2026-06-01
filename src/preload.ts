/**
 * Symbio — Preload Script
 *
 * Exposes Symbio APIs to the renderer processes via contextBridge.
 * This is the secure IPC bridge between the main process and the UI.
 */

import { contextBridge, ipcRenderer } from "electron";

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

  // ── Auto-Screenshot ────────────────────────────────────────────
  autoScreenshotEnable: () => ipcRenderer.invoke("auto-screenshot-enable"),
  autoScreenshotDisable: () => ipcRenderer.invoke("auto-screenshot-disable"),
  autoScreenshotState: () => ipcRenderer.invoke("auto-screenshot-state"),

  // ── MCP Tools ──────────────────────────────────────────────────
  mcpGetCategories: () => ipcRenderer.invoke("mcp-get-categories"),
  mcpTriggerTool: (toolName: string, instruction: string) =>
    ipcRenderer.invoke("mcp-trigger-tool", toolName, instruction),

  // ── Agent Switching ────────────────────────────────────────────
  switchAgent: (agentName: string) =>
    ipcRenderer.invoke("switch-agent", agentName),

  // ── Event Listeners ───────────────────────────────────────────
  onPromptSent: (callback: (prompt: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, prompt: string) =>
      callback(prompt);
    ipcRenderer.on("prompt-sent", handler);
    return () => ipcRenderer.removeListener("prompt-sent", handler);
  },

  onHotMicToggled: (callback: (isActive: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isActive: boolean) =>
      callback(isActive);
    ipcRenderer.on("hotmic-toggled", handler);
    return () => ipcRenderer.removeListener("hotmic-toggled", handler);
  },

  // ── STT text received from main process ────────────────────────
  onSttText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    ipcRenderer.on("stt-text", handler);
    return () => ipcRenderer.removeListener("stt-text", handler);
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
    ipcRenderer.on("screenshot", handler);
    return () => ipcRenderer.removeListener("screenshot", handler);
  },

  onVisionResult: (
    callback: (result: { description: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: { description: string },
    ) => callback(result);
    ipcRenderer.on("vision-result", handler);
    return () => ipcRenderer.removeListener("vision-result", handler);
  },

  onAutoScreenshotState: (
    callback: (state: { enabled: boolean }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: { enabled: boolean },
    ) => callback(state);
    ipcRenderer.on("auto-screenshot-state", handler);
    return () => ipcRenderer.removeListener("auto-screenshot-state", handler);
  },

  onCompanionQuit: (
    callback: (message: { reason: string; humanMessage: string; timestamp: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      message: { reason: string; humanMessage: string; timestamp: string },
    ) => callback(message);
    ipcRenderer.on("companion-quit", handler);
    return () => ipcRenderer.removeListener("companion-quit", handler);
  },

  onGeneratedText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    ipcRenderer.on("generated-text", handler);
    return () => ipcRenderer.removeListener("generated-text", handler);
  },

  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) =>
      callback(error);
    ipcRenderer.on("error", handler);
    return () => ipcRenderer.removeListener("error", handler);
  },

  onAgentSwitched: (
    callback: (agent: { name: string; vrmPath: string; displayName: string; color: string; emoji: string }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      agent: { name: string; vrmPath: string; displayName: string; color: string; emoji: string },
    ) => callback(agent);
    ipcRenderer.on("agent-switched", handler);
    return () => ipcRenderer.removeListener("agent-switched", handler);
  },

  onPlayAnimation: (callback: (animation: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, animation: string) => {
      console.log(`[Symbio] preload (symbioAPI): received play-animation "${animation}"`);
      // Echo back to main process for debugging (since overlay DevTools may not open)
      ipcRenderer.send("play-animation-received", animation);
      callback(animation);
    };
    ipcRenderer.on("play-animation", handler);
    return () => ipcRenderer.removeListener("play-animation", handler);
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
    ipcRenderer.on("speaking-started", handler);
    return () => ipcRenderer.removeListener("speaking-started", handler);
  },
  onSpeakingEnded: (callback: () => void) => {
    const handler = () => {
      console.log("[Symbio] preload: received speaking-ended");
      callback();
    };
    ipcRenderer.on("speaking-ended", handler);
    return () => ipcRenderer.removeListener("speaking-ended", handler);
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
    ipcRenderer.on("voice-toggled", handler);
    return () => ipcRenderer.removeListener("voice-toggled", handler);
  },

  // ── Streaming TTS ──────────────────────────────────────────────
  // PCM audio chunks streamed from main process for low-latency playback.
  // The main process sends: init → chunks... → end
  // The renderer uses Web Audio API to play PCM in real-time.
  onTtsStreamInit: (callback: (config: { sampleRate: number; channels: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: { sampleRate: number; channels: number }) => {
      callback(config);
    };
    ipcRenderer.on("tts-stream-init", handler);
    return () => ipcRenderer.removeListener("tts-stream-init", handler);
  },
  onTtsStreamChunk: (callback: (chunkBase64: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunkBase64: string) => {
      callback(chunkBase64);
    };
    ipcRenderer.on("tts-stream-chunk", handler);
    return () => ipcRenderer.removeListener("tts-stream-chunk", handler);
  },
  onTtsStreamEnd: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("tts-stream-end", handler);
    return () => ipcRenderer.removeListener("tts-stream-end", handler);
  },
  onTtsStreamStop: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("tts-stream-stop", handler);
    return () => ipcRenderer.removeListener("tts-stream-stop", handler);
  },
  // Tell main process that streaming playback has ended
  ttsPlaybackEnded: () => {
    ipcRenderer.send("tts-playback-ended", "ended");
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
    ipcRenderer.on("prompt-sent", handler);
    return () => ipcRenderer.removeListener("prompt-sent", handler);
  },
  onHotMicToggled: (callback: (isActive: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isActive: boolean) =>
      callback(isActive);
    ipcRenderer.on("hotmic-toggled", handler);
    return () => ipcRenderer.removeListener("hotmic-toggled", handler);
  },
  // ── STT text received from main process ────────────────────────
  onSttText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    ipcRenderer.on("stt-text", handler);
    return () => ipcRenderer.removeListener("stt-text", handler);
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
    ipcRenderer.on("screenshot", handler);
    return () => ipcRenderer.removeListener("screenshot", handler);
  },
  onGeneratedText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) =>
      callback(text);
    ipcRenderer.on("generated-text", handler);
    return () => ipcRenderer.removeListener("generated-text", handler);
  },
  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) =>
      callback(error);
    ipcRenderer.on("error", handler);
    return () => ipcRenderer.removeListener("error", handler);
  },

  onPlayAnimation: (callback: (animation: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, animation: string) => {
      console.log(`[Symbio] preload (electronAPI): received play-animation "${animation}"`);
      ipcRenderer.send("play-animation-received", animation);
      callback(animation);
    };
    ipcRenderer.on("play-animation", handler);
    return () => ipcRenderer.removeListener("play-animation", handler);
  },

  debugOverlayDevTools: () => {
    ipcRenderer.send("debug-overlay-devtools");
  },

  // ── Speech Synthesis (TTS) — legacy compatibility ──────────────
  speakText: (text: string) => ipcRenderer.send("speak-text", text),
  stopSpeaking: () => ipcRenderer.send("stop-speaking"),
  onSpeakingStarted: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("speaking-started", handler);
    return () => ipcRenderer.removeListener("speaking-started", handler);
  },
  onSpeakingEnded: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("speaking-ended", handler);
    return () => ipcRenderer.removeListener("speaking-ended", handler);
  },
  // ── Streaming TTS — legacy compatibility ──────────────────────
  onTtsStreamInit: (callback: (config: { sampleRate: number; channels: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: { sampleRate: number; channels: number }) => callback(config);
    ipcRenderer.on("tts-stream-init", handler);
    return () => ipcRenderer.removeListener("tts-stream-init", handler);
  },
  onTtsStreamChunk: (callback: (chunkBase64: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunkBase64: string) => callback(chunkBase64);
    ipcRenderer.on("tts-stream-chunk", handler);
    return () => ipcRenderer.removeListener("tts-stream-chunk", handler);
  },
  onTtsStreamEnd: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("tts-stream-end", handler);
    return () => ipcRenderer.removeListener("tts-stream-end", handler);
  },
  onTtsStreamStop: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("tts-stream-stop", handler);
    return () => ipcRenderer.removeListener("tts-stream-stop", handler);
  },
  ttsPlaybackEnded: () => ipcRenderer.send("tts-playback-ended", "ended"),
});
