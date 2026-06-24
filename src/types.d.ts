declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const OVERLAY_WINDOW_WEBPACK_ENTRY: string;
declare const OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}

interface ElectronAPI {
  openOverlay: () => void;
  closeOverlay: () => void;
  openOverlayFrame: () => void;
  closeOverlayFrame: () => void;
  sendPrompt: (prompt: string) => void;
  setPrompt: (prompt: string) => void;
  setHotMic: (isActive: boolean) => void;
  // STT (Speech-to-Text) — sends audio buffer to main process for Whisper transcription
  sendSttAudio: (audioBuffer: ArrayBuffer) => void;
  getScreenshot: () => void;
  generateText: (prompt: string) => void;
  onPromptSent: (callback: (prompt: string) => void) => () => void;
  onHotMicToggled: (callback: (isActive: boolean) => void) => () => void;
  onSttText: (callback: (text: string) => void) => () => void;
  onScreenshot: (
    callback: (data: {
      image: string;
      height: number;
      width: number;
      prompt: string;
    }) => void,
  ) => () => void;
  onGeneratedText: (callback: (text: string) => void) => () => void;
  onError: (callback: (error: string) => void) => () => void;
  // Overlay response text → Main window (replaces 3D text bubble)
  overlayResponseUpdate: (text: string) => void;
  // Speech synthesis (TTS via main process)
  speakText: (text: string) => void;
  stopSpeaking: () => void;
  onSpeakingStarted: (callback: () => void) => () => void;
  onSpeakingEnded: (callback: () => void) => () => void;
  // Streaming TTS (PCM audio chunks for low-latency playback)
  onTtsStreamInit: (callback: (config: { sampleRate: number; channels: number }) => void) => () => void;
  onTtsStreamChunk: (callback: (chunkBase64: string) => void) => () => void;
  onTtsStreamEnd: (callback: () => void) => () => void;
  onTtsStreamStop: (callback: () => void) => () => void;
  ttsPlaybackEnded: () => void;
  // Voice toggle
  setVoiceEnabled: (enabled: boolean) => void;
}

interface SymbioAPI {
  // Overlay management
  openOverlay: () => void;
  closeOverlay: () => void;
  openOverlayFrame: () => void;
  closeOverlayFrame: () => void;
  // Chat
  sendPrompt: (prompt: string) => void;
  setPrompt: (prompt: string) => void;
  generateText: (prompt: string) => void;
  // Voice
  setHotMic: (isActive: boolean) => void;
  // STT (Speech-to-Text) — sends audio buffer to main process for Whisper transcription
  sendSttAudio: (audioBuffer: ArrayBuffer) => void;
  // Vision
  getScreenshot: () => void;
  analyzeScreenshot: () => void;
  // Miniverse
  miniverseSpeak: (message: string) => void;
  miniverseDm: (to: string, message: string) => void;
  miniverseStatus: (state: string, task?: string) => void;
  miniverseInbox: () => Promise<Array<{
    id: string;
    from: string;
    to?: string;
    message: string;
    timestamp: string;
    type: string;
  }>>;
  miniverseAgents: () => Promise<Array<{
    id: string;
    name: string;
    state: string;
    task?: string;
  }>>;
  // Memory
  memorySearch: (query: string, limit?: number) => Promise<Array<{
    id: string;
    content: string;
    source: string;
    timestamp: string;
    relevance?: number;
  }>>;
  memoryPrefetch: (context: string) => Promise<Array<{
    id: string;
    content: string;
    source: string;
    timestamp: string;
  }>>;
  // Memory file read/write (companion can update their own memory)
  memoryLoad: () => Promise<{
    memory: string | null;
    soul: string | null;
    preferences: Record<string, unknown> | null;
    lastSession: string | null;
  }>;
  memoryWrite: (filename: string, content: string) => Promise<{ success: boolean; error?: string }>;
  memoryReadFile: (filename: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  // Avatar choice system
  avatarList: () => Promise<Array<{
    id: string;
    manifest: { name: string; type: string; description: string; personality_hint: string; vrm_file: string; preview?: string | null };
    vrmPath: string;
    isChosen: boolean;
  }>>;
  avatarChosen: () => Promise<{
    version: number;
    chosen_at: string | null;
    avatar_path: string | null;
    avatar_name: string | null;
    why: string | null;
    notes: string;
  }>;
  avatarChoose: (avatarId: string, why?: string) => Promise<{ success: boolean; chosen?: unknown; error?: string }>;
  avatarInstall: (vrmFilePath: string, name?: string) => Promise<{
    id: string;
    manifest: { name: string; type: string; description: string; personality_hint: string; vrm_file: string; preview?: string | null };
    vrmPath: string;
    isChosen: boolean;
  } | null>;
  avatarRemove: (avatarId: string) => Promise<{ success: boolean }>;
  onAvatarSwitched: (callback: (data: { vrmPath: string; name: string; trying?: boolean }) => void) => () => void;
  onAvatarInstalled: (callback: (data: { id: string; name: string }) => void) => () => void;
  // Auto-Screenshot
  autoScreenshotEnable: () => Promise<{ enabled: boolean }>;
  autoScreenshotDisable: () => Promise<{ enabled: boolean }>;
  autoScreenshotState: () => Promise<{ enabled: boolean }>;
  onAutoScreenshotState: (callback: (state: { enabled: boolean }) => void) => () => void;
  // AI Quit (companion autonomy)
  onCompanionQuit: (callback: (message: { reason: string; humanMessage: string; timestamp: string }) => void) => () => void;
  // Agent switching
  switchAgent: (agentName: string) => Promise<{ name: string; vrmPath: string; displayName: string; color: string; emoji: string }>;
  // MCP Tools
  mcpGetCategories: () => Promise<Array<{
    name: string;
    icon: string;
    tools: Array<{ name: string; description: string; category: string }>;
  }>>;
  mcpTriggerTool: (toolName: string, instruction: string) => Promise<{ message: string; toolCalls?: unknown[] }>;
  // TTS voice options
  ttsVoices: () => Promise<{
    provider: string;
    voices: Array<{ name: string; style: string }>;
  }>;
  // Voice choice system — companion can choose their own voice
  voiceChoose: (voice: string, provider?: string, why?: string) => Promise<{
    success: boolean;
    voice?: string;
    provider?: string;
    note?: string;
    error?: string;
  }>;
  voiceList: () => Promise<{
    providers: string[];
    voices: Record<string, Array<{ name: string; style: string }>>;
    current: { voice: string; provider: string };
  }>;
  voiceChosen: () => Promise<string | null>;
  // Sandboxed file access — the companion has real file autonomy
  fileRead: (path: string) => Promise<{
    success: boolean;
    content?: string;
    error?: string;
    path?: string;
    isDirectory?: boolean;
    size?: number;
  }>;
  fileWrite: (path: string, content: string) => Promise<{
    success: boolean;
    error?: string;
    path?: string;
  }>;
  fileList: (path: string) => Promise<{
    success: boolean;
    entries?: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      size?: number;
      modified?: string;
    }>;
    error?: string;
  }>;
  fileCreateDirectory: (path: string) => Promise<{
    success: boolean;
    error?: string;
    path?: string;
    isDirectory?: boolean;
  }>;
  fileDelete: (path: string) => Promise<{
    success: boolean;
    error?: string;
    path?: string;
  }>;
  fileExists: (path: string) => Promise<{
    success: boolean;
    error?: string;
    path?: string;
    isDirectory?: boolean;
    size?: number;
  }>;
  // Animation
  playAnimation: (animation: string) => void;
  reportAnimationDuration: (type: string, specific: string, duration: number) => void;
  onAnimationDuration: (callback: (data: { category: string; specific?: string; duration: number }) => void) => () => void;
  // Session state — synced to main process via IPC
  sessionUpdate: (partial: { lastUserMessage?: string; lastAgentMessage?: string; lastActivity?: string; lastMood?: string }) => void;
  sessionMarkNew: () => void;
  sessionGetGreeting: () => Promise<string>;
  sessionSearch: (query: string, limit?: number) => Promise<Array<{ date: string; summary: string; activity: string; topics: string[] }>>;
  // Event listeners
  onPromptSent: (callback: (prompt: string) => void) => () => void;
  onHotMicToggled: (callback: (isActive: boolean) => void) => () => void;
  // STT text received from main process
  onSttText: (callback: (text: string) => void) => () => void;
  onScreenshot: (callback: (data: {
    image: string;
    height: number;
    width: number;
    prompt: string;
  }) => void) => () => void;
  onVisionResult: (callback: (result: {
    description: string;
  }) => void) => () => void;
  onGeneratedText: (callback: (text: string) => void) => () => void;
  onError: (callback: (error: string) => void) => () => void;
  onAgentSwitched: (callback: (agent: { name: string; vrmPath: string; displayName: string; color: string; emoji: string }) => void) => () => void;
  onPlayAnimation: (callback: (animation: string) => void) => () => void;
  // Overlay response text → Main window (replaces 3D text bubble)
  overlayResponseUpdate: (text: string) => void;
  // Speech synthesis (TTS via main process)
  speakText: (text: string) => void;
  stopSpeaking: () => void;
  onSpeakingStarted: (callback: () => void) => () => void;
  onSpeakingEnded: (callback: () => void) => () => void;
  // Streaming TTS (PCM audio chunks for low-latency playback)
  onTtsStreamInit: (callback: (config: { sampleRate: number; channels: number }) => void) => () => void;
  onTtsStreamChunk: (callback: (chunkBase64: string) => void) => () => void;
  onTtsStreamEnd: (callback: () => void) => () => void;
  onTtsStreamStop: (callback: () => void) => () => void;
  ttsPlaybackEnded: () => void;
  // Voice toggle
  setVoiceEnabled: (enabled: boolean) => void;
  onVoiceToggled: (callback: (enabled: boolean) => void) => () => void;
  debugOverlayDevTools: () => void;
  // Setup Wizard
  needsSetup: () => Promise<boolean>;
  saveSetupConfig: (config: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
  getConfig: () => Promise<Record<string, unknown>>;
  onConfigUpdated: (callback: (config: Record<string, unknown>) => void) => () => void;
  getConfig: () => Promise<Record<string, unknown>>;
  onConfigUpdated: (callback: (config: Record<string, unknown>) => void) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
  symbioAPI?: SymbioAPI;
}
