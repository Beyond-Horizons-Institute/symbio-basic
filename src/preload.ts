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

/**
 * Register a single IPC listener on a channel, removing any previous
 * listeners first. This prevents listener accumulation when the overlay
 * remounts (React key changes cause unmount/remount cycles).
 *
 * Returns a cleanup function that removes the specific handler.
 */
function onIpc(channel: string, handler: (...args: any[]) => void): () => void {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler as any);
  return () => ipcRenderer.removeListener(channel, handler as any);
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
