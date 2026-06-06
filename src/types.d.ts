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
  // Animation
  playAnimation: (animation: string) => void;
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
