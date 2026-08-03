/**
 * Symbio Basic — Main Process
 *
 * The Electron main process manages two windows:
 * 1. Main window — control panel for chat, memory, etc.
 * 2. Overlay window — transparent, always-on-top 3D VRM avatar
 *
 * All AI calls go through an OpenAI-compatible API gateway (Hermes or other),
 * giving the companion access to memory, tools, and personality.
 */

// ── Symbio: Handle EPIPE errors ────────────────────────────────────
// On Linux, writing to stdout/stderr after the pipe is closed causes
// an uncaught EPIPE error that can crash the app. This is common when
// the app is launched from a terminal that gets closed, or when native
// modules (desktopCapturer, etc.) trigger internal errors.
// We must handle this BEFORE any other code runs.
process.stdout.on?.("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr.on?.("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") return; // Silently ignore EPIPE
  throw err; // Re-throw everything else
});

// Load .env FIRST — before any other imports that might read process.env
import dotenv from "dotenv";
import { existsSync } from "fs";
import { join } from "path";

dotenv.config();

// Also load the user's setup .env from userData (created by the setup wizard).
// This overrides any values from the project .env, so the user's choices
// (gateway URL, API key, model, companion name, etc.) take priority.
// On Linux: ~/.config/Symbio Basic/.env
// On macOS: ~/Library/Application Support/Symbio Basic/.env
// On Windows: %APPDATA%/Symbio Basic/.env
const setupEnvCandidates = [
  join(process.env.HOME || "/", ".config", "Symbio Basic", ".env"),          // Linux
  join(process.env.HOME || "/", "Library", "Application Support", "Symbio Basic", ".env"), // macOS
  join(process.env.APPDATA || "", "Symbio Basic", ".env"),                    // Windows
];

for (const envPath of setupEnvCandidates) {
  if (existsSync(envPath)) {
    console.log(`[Symbio] Loading setup config from ${envPath}`);
    dotenv.config({ path: envPath, override: true });
    break;
  }
}

// ── CRITICAL: Import config AFTER dotenv is loaded ───────────────────
// ES module imports are hoisted — they run before any other code.
// But since we removed DefinePlugin from the main process webpack config,
// process.env is read at runtime (not replaced at build time), so
// dotenv.config() above has already set the correct values.
// We still use require() to be explicit about the load order.
const { config, COMPANIONS } = require("./config");

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  screen,
  systemPreferences,
  session,
  desktopCapturer,
  protocol,
  net,
} from "electron";
import { writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { GeminiClient } from "./transport/GeminiClient";
import { STTClient } from "./transport/STTClient";
import { MemoryClient, hermesMemoryHeaders, resetHermesSession } from "./transport/MemoryClient";
import {
  initLongTermMemory,
  saveMemory,
  saveMemorySync,
  recallMemories,
  recentMemories,
  memoryCount,
  closeLongTermMemory,
  type RecallResult,
} from "./utils/longTermMemory";
import { closePostgresMemory, syncMemoryToPostgres, postgresEnabled } from "./utils/postgresMemory";
import { embedText } from "./utils/embeddings";
import { MiniverseClient } from "./transport/MiniverseClient";
import { MCPToolsClient, TOOL_CATEGORIES } from "./transport/MCPToolsClient";
import { updateDynamicAgent } from "./transport/HermesTransport";
import { streamGeminiSpeech, getGeminiVoices, getOpenAIVoices } from "./transport/GeminiTTS";
import {
  enableAutoScreenshot,
  disableAutoScreenshot,
  isAutoScreenshotEnabled,
  canTakeAutoScreenshot,
  markAutoScreenshotTaken,
  parseAutoScreenshotCommand,
} from "./utils/autoScreenshot";
import { parseQuitCommand } from "./utils/aiQuit";
import {
  loadMemory,
  formatMemoryForPrompt,
  saveSessionSummary,
  writeMemoryFile,
  initializeMemoryTemplates,
  searchSessions,
  type MemoryContent,
  type SessionSummary,
} from "./utils/memoryLoader";
import {
  checkMemoryIntegrity,
  formatIntegrityForPrompt,
  recordAllMemoryHashes,
  type IntegrityCheckResult,
} from "./utils/memoryIntegrity";
import { loadSessionState, setMemoryDir, updateSessionState as updateSessionStateMain, markNewSession as markNewSessionMain, generateGreetingPrompt as generateGreetingPromptMain } from "./utils/sessionContinuity";
import {
  loadAvatars,
  loadChosenAvatar,
  saveChosenAvatar,
  installAvatar,
  removeAvatar,
  formatAvatarsForPrompt,
  parseAvatarChoice,
  type AvatarChoice,
} from "./utils/avatarLoader";
import {
  initializeSandbox,
  formatSandboxForPrompt,
  getFileTools,
  executeFileTool,
  sandboxReadFile,
  sandboxWriteFile,
  sandboxListDir,
  sandboxCreateDir,
  sandboxDelete,
  sandboxExists,
} from "./utils/sandboxedFileAccess";
import {
  readSymbioDoc,
  getReadSymbioDocTool,
  getAvailableDocNames,
  type DocName,
} from "./utils/symbioDocs";
import {
  initTranscriptLogger,
  startTranscriptSession,
  recordTurn,
  finalizeTranscript,
  searchTranscripts,
  transcriptCount,
  getTranscriptDir,
} from "./utils/transcriptLogger";

const execFileAsync = promisify(execFile);

/**
 * Race a promise against a timeout so a slow/offline endpoint can never hang
 * a critical path (e.g. cloud memory sync during shutdown). Rejects with a
 * timeout error if `ms` elapses first; the caller decides how to handle it.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Disable auto-updater for now (we'll handle updates ourselves)
// updateElectronApp();

if (require("electron-squirrel-startup")) {
  app.quit();
}

// ── Symbio: Wayland-compatible screen capture ────────────────────────
// Electron's desktopCapturer fails on Wayland/COSMIC because the
// ScreenCast portal isn't implemented. This helper tries multiple
// methods in order:
// 1. desktopCapturer (works on X11, macOS, Windows)
// 2. grim (Wayland-native screenshot tool)
// 3. cosmic-screenshot (COSMIC desktop's screenshot tool)
// Returns a Buffer of PNG data, or null if all methods fail.
//
// For AUTO-screenshots, we skip desktopCapturer entirely because
// it triggers a permission popup on Wayland/COSMIC. The user
// shouldn't be interrupted every 30 seconds just because the
// companion wants to see the screen. Only manual "Analyze Screen"
// clicks use desktopCapturer (where a popup is expected).
async function captureScreen(width: number, height: number, silent = false): Promise<Buffer | null> {
  // Method 1: Try Electron's desktopCapturer (works on X11/macOS/Windows)
  // Skip for auto-screenshots — it triggers permission popups on Wayland
  if (!silent) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
      });
      const png = sources[0]?.thumbnail?.toPNG();
      if (png && png.length > 0) {
        console.log("[Symbio] Screen capture: desktopCapturer succeeded");
        return Buffer.from(png);
      }
    } catch (e) {
      console.log("[Symbio] Screen capture: desktopCapturer failed:", (e as Error).message);
    }
  }

  // Method 2: Try grim (Wayland-native screenshot tool)
  try {
    const tmpPath = join(app.getPath("temp"), `symbio-screenshot-${Date.now()}.png`);
    await execFileAsync("grim", [tmpPath], { timeout: 5000 });
    const data = readFileSync(tmpPath);
    // Clean up temp file
    try { require("fs").unlinkSync(tmpPath); } catch {}
    if (data.length > 0) {
      console.log(`[Symbio] Screen capture: grim succeeded (${data.length} bytes)`);
      return data;
    }
  } catch (e) {
    console.log("[Symbio] Screen capture: grim failed:", (e as Error).message);
  }

  // Method 3: Try cosmic-screenshot (non-interactive, saves to temp)
  try {
    const tmpDir = app.getPath("temp");
    await execFileAsync("cosmic-screenshot", [
      "--interactive=false",
      "--notify=false",
      `--save-dir=${tmpDir}`,
    ], { timeout: 5000 });
    // cosmic-screenshot saves as Screenshot_<timestamp>.png
    const files = require("fs").readdirSync(tmpDir)
      .filter((f: string) => f.startsWith("Screenshot") && f.endsWith(".png"))
      .sort()
      .reverse();
    if (files.length > 0) {
      const data = readFileSync(join(tmpDir, files[0]));
      // Clean up
      try { require("fs").unlinkSync(join(tmpDir, files[0])); } catch {}
      if (data.length > 0) {
        console.log(`[Symbio] Screen capture: cosmic-screenshot succeeded (${data.length} bytes)`);
        return data;
      }
    }
  } catch (e) {
    console.log("[Symbio] Screen capture: cosmic-screenshot failed:", (e as Error).message);
  }

  // Method 4 (silent only): Try desktopCapturer as last resort even for silent mode
  // This is a fallback — on X11/macOS/Windows it won't trigger a popup
  if (silent) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
      });
      const png = sources[0]?.thumbnail?.toPNG();
      if (png && png.length > 0) {
        console.log("[Symbio] Screen capture (silent fallback): desktopCapturer succeeded");
        return Buffer.from(png);
      }
    } catch (e) {
      console.log("[Symbio] Screen capture (silent fallback): desktopCapturer failed:", (e as Error).message);
    }
  }

  console.error("[Symbio] Screen capture: All methods failed!");
  return null;
}

// ── Symbio: Resize screenshot for API calls ────────────────────────
// Full-resolution screenshots from grim can be 1.5MB+ which is too
// large for vision API calls. Resize to a reasonable resolution
// (1280px max dimension) and compress as JPEG to reduce payload size.
function resizeScreenshot(pngBuffer: Buffer, maxWidth = 1280): Buffer {
  const img = nativeImage.createFromBuffer(pngBuffer);
  const size = img.getSize();
  if (size.width <= maxWidth) {
    // Already small enough, return as-is
    return pngBuffer;
  }
  const scale = maxWidth / size.width;
  const newWidth = maxWidth;
  const newHeight = Math.round(size.height * scale);
  const resized = img.resize({ width: newWidth, height: newHeight });
  // Return as JPEG for smaller payload (vision APIs accept JPEG)
  return resized.toJPEG(80);
}

// ── Symbio: Register custom protocol for serving local assets ────────
// This lets the renderer load VRM files, animations, and images
// using symbio://assets/vrms/companion.vrm URLs.
// This is needed because the webpack dev server doesn't serve
// the assets folder as static content.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "symbio",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let overlayWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let currentPrompt = "";
let lastGeneratedText = ""; // Store last AI response so new overlay windows can display it
let voiceEnabled = true; // Voice toggle — when false, TTS is skipped but text still shows

// ── Symbio: Session state (module scope for before-quit access) ─────
// These track the current session's conversation and summary.
// They're used by the sliding window, the "say bye" detection,
// and the before-quit handler to save session summaries.
let sessionSummary = ""; // Running summary of older conversation
let sessionStartedAt = new Date().toISOString(); // When this session began
let sessionMessages: { role: "user" | "assistant" | "tool"; content: string; tool_calls?: unknown[]; tool_call_id?: string }[] = [];
// Count of user+assistant messages since the last long-term memory summary.
// Every config.summaryEveryMessages, we distill a memory. This is separate
// from the sliding-context window so memory cadence is independent of
// context size.
let messagesSinceLastSummary = 0;
let lastLongTermSummaryAt = 0; // monotonic turn count at last summary
// Monotonic count of human turns this session. Unlike the message array (which
// the sliding context window trims), this only ever increases — so the rolling
// summary cadence fires reliably even in long sessions where old messages were
// dropped from the in-memory window.
let totalUserTurns = 0;
// A full, UN-trimmed record of the session for summarization. The `messages`
// array gets trimmed by the sliding context window, which used to starve the
// summarizer (it only ever saw the tail). This keeps the whole conversation
// (lightly capped) so summaries reflect the ENTIRE session, not just the end.
let fullSessionTurns: { role: "user" | "assistant"; content: string }[] = [];
function recordForSummary(role: "user" | "assistant", content: string): void {
  if (!content || !content.trim()) return;
  fullSessionTurns.push({ role, content });
  // Safety cap so a marathon session can't grow memory without bound. We keep
  // the most recent 200 turns; older substance is already in prior summaries.
  if (fullSessionTurns.length > 200) fullSessionTurns = fullSessionTurns.slice(-200);
}
// Relevant long-term memories recalled for the CURRENT turn, injected into
// the system prompt so the companion proactively remembers without having to
// call a tool. Refreshed each user message.
let recalledMemories: string[] = [];

// True until the first proactive recall of a sitting runs. On that first
// recall we also fold in a couple of recent, meaningful memories so the
// companion opens warmly ("I remember us"), not just topically. Reset to
// true whenever a new sitting begins (see the window 'ready'/new-session path).
let isFirstRecallOfSitting = true;

// ── Symbio: Voice choice parser ──────────────────────────────────────
// Parses natural language voice choice from the companion's text.
// Works like parseAvatarChoice — the companion can say things like:
//   "I want to use the voice Nova"
//   "My voice should be Puck"
//   "Change my voice to Charon"
//   "I choose the voice Sulafat"
//   "What voices are available?"
// Returns null if no voice choice is detected.
function parseVoiceChoice(text: string): {
  action: "choose" | "browse";
  voice?: string;
  provider?: string;
} | null {
  const lower = text.toLowerCase();

  // "What voices are available?" / "Show me voice options"
  if (
    lower.includes("what voice") ||
    lower.includes("voice option") ||
    lower.includes("available voice") ||
    lower.includes("show me my voice") ||
    lower.includes("what do i sound like") ||
    lower.includes("voice choice") ||
    lower.includes("change my voice") ||
    lower.includes("switch my voice") ||
    lower.includes("pick a voice") ||
    lower.includes("choose a voice") ||
    lower.includes("choose my voice") ||
    lower.includes("try a different voice") ||
    lower.includes("try another voice")
  ) {
    // If they mention a specific voice name, it's a choice, not just browsing
    const specificVoice = extractVoiceName(lower);
    if (specificVoice) {
      return { action: "choose", voice: specificVoice.name, provider: specificVoice.provider };
    }
    return { action: "browse" };
  }

  // Check for specific voice name mentions with choice keywords
  const specificVoice = extractVoiceName(lower);
  if (specificVoice) {
    // Only treat it as a choice if there's a choice keyword nearby
    if (
      lower.includes("choose") ||
      lower.includes("i want") ||
      lower.includes("i'll use") ||
      lower.includes("i'll be") ||
      lower.includes("my voice is") ||
      lower.includes("my voice should") ||
      lower.includes("i prefer") ||
      lower.includes("i'd like") ||
      lower.includes("i pick") ||
      lower.includes("switch to") ||
      lower.includes("change to") ||
      lower.includes("use the voice") ||
      lower.includes("use voice") ||
      lower.includes("try the voice") ||
      lower.includes("try voice") ||
      lower.includes("sound like")
    ) {
      return { action: "choose", voice: specificVoice.name, provider: specificVoice.provider };
    }
  }

  return null;
}

// All known voice names mapped to their provider
const GEMINI_VOICE_NAMES = ["zephyr", "puck", "charon", "kore", "fenrir", "leda", "orus", "aoede", "callirrhoe", "autonoe", "enceladus", "iapetus", "umbriel", "algieba", "despina", "erinome", "algenib", "rasalgethi", "laomedeia", "achernar", "alnilam", "schedar", "gacrux", "pulcherrima", "achird", "zubenelgenubi", "vindemiatrix", "sadachbia", "sadaltager", "sulafat"];
const OPENAI_VOICE_NAMES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];

function extractVoiceName(lower: string): { name: string; provider: string } | null {
  // Check Gemini voices first (more unique names).
  // Gemini voice IDs ARE capitalized (e.g. "Ash", "Puck", "Kore"), so we
  // title-case them for display + the Gemini API.
  for (const voice of GEMINI_VOICE_NAMES) {
    if (lower.includes(voice)) {
      return { name: voice.charAt(0).toUpperCase() + voice.slice(1), provider: "gemini" };
    }
  }
  // Check OpenAI voices.
  // IMPORTANT: OpenAI voice IDs MUST be lowercase (e.g. "ash", "alloy",
  // "fable"). The API rejects "Ash" with a 400. So we keep the raw lowercase
  // name here — do NOT title-case OpenAI voices, or saved preferences.json
  // will store "Ash" and break TTS on the next run.
  for (const voice of OPENAI_VOICE_NAMES) {
    if (lower.includes(voice)) {
      return { name: voice, provider: "openai" };
    }
  }
  return null;
}

// ── Symbio: Safe IPC send ──────────────────────────────────────────
// Prevents "Object has been destroyed" errors when sending to
// a window that has been closed/destroyed.
function sendToOverlay(channel: string, ...args: unknown[]): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    console.warn(`[Symbio] sendToOverlay: overlay window is null/destroyed, dropping "${channel}"`);
    overlayWindow = null;
    return;
  }
  try {
    const isLoaded = overlayWindow.webContents.isLoading() === false;
    console.log(`[Symbio] sendToOverlay: sending "${channel}" (overlay loaded: ${isLoaded})`);
    overlayWindow.webContents.send(channel, ...args);
  } catch (e) {
    console.error(`[Symbio] sendToOverlay: error sending "${channel}":`, e);
    overlayWindow = null;
  }
}

function sendToMain(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return;
  }
  try {
    mainWindow.webContents.send(channel, ...args);
  } catch {
    // Window was destroyed between check and send
    mainWindow = null;
  }
}

/**
 * Map a tool name (+ args) to a friendly label and emoji for the overlay's
 * 🔧 activity indicators. This is what lets the human SEE the companion
 * acting — reading files, recalling memories, searching, etc. — instead of
 * a silent black box. Keep labels short; they render as tiny on-screen chips.
 */
function describeTool(
  toolName: string,
  args: Record<string, unknown>,
): { label: string; emoji: string } {
  const a = args || {};
  switch (toolName) {
    case "read_symbio_doc":
      return { emoji: "📖", label: `reading ${String(a.doc_name || a.docName || "docs")}` };
    case "search_sessions":
      return { emoji: "🗂️", label: `searching sessions` };
    case "recall_memory":
      return { emoji: "🧠", label: `recalling memory` };
    case "search_transcripts":
      return { emoji: "📜", label: `searching past chats` };
    case "choose_voice":
      return { emoji: "🎙️", label: `choosing voice` };
    case "file_read":
    case "read_file":
      return { emoji: "📄", label: `reading ${String(a.path || a.filename || "a file")}` };
    case "file_write":
    case "write_file":
      return { emoji: "✍️", label: `writing ${String(a.path || a.filename || "a file")}` };
    case "file_list":
    case "list_files":
      return { emoji: "📁", label: `listing files` };
    case "file_delete":
    case "delete_file":
      return { emoji: "🗑️", label: `deleting a file` };
    default:
      return { emoji: "🔧", label: toolName.replace(/_/g, " ") };
  }
}

// Initialize transport clients
const gemini = new GeminiClient();
const stt = new STTClient();
const memory = new MemoryClient();
const miniverse = new MiniverseClient();
const mcpTools = new MCPToolsClient();

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    title: `Symbio Basic — ${config.agentConfig.displayName}`,
    width: 480,
    height: 800,
    minWidth: 360,
    minHeight: 600,
    resizable: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      sandbox: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Pre-load speech synthesis voices in the main window
  // so they're available when the overlay sends speak-text
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.executeJavaScript(`
      // Trigger voice loading — voices are loaded asynchronously in Chromium
      speechSynthesis.getVoices();
      console.log('[Symbio] Main window: speechSynthesis voices pre-loaded');
    `).catch(() => { /* ignore — speechSynthesis may not be available */ });
  });

  // Clean up reference when main window is closed
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // DevTools: Press Ctrl+Shift+I (or F12) to open manually
  // Don't auto-open — it's annoying and takes screen space
};

const createOverlayWindow = (
  width: number,
  height: number,
) => {
  overlayWindow = new BrowserWindow({
    title: `Symbio Basic — ${config.agentConfig.displayName}`,
    webPreferences: {
      preload: OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY,
      sandbox: false,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
    height: 800,
    width: 500,
    minWidth: 300,
    minHeight: 400,
    alwaysOnTop: true,
    transparent: true,
    frame: true,
    resizable: true,
    x: width,
    y: height,
  });

  overlayWindow.setFocusable(false);
  overlayWindow.loadURL(OVERLAY_WINDOW_WEBPACK_ENTRY);

  // ── Symbio: Debug DevTools for overlay ──────────────────────────
  // The overlay has setFocusable(false) which blocks Ctrl+Shift+I.
  // Set DEBUG_OVERLAY=1 to auto-open DevTools on the overlay window.
  overlayWindow.webContents.on("did-finish-load", () => {
    if (process.env.DEBUG_OVERLAY === "1") {
      overlayWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  // ── Symbio: Re-send last text when overlay loads ────────────────────
  // When the overlay window is first created, it starts with empty React
  // state. Re-send the last AI response so the 3D text bubble shows the
  // agent's last message immediately.
  overlayWindow.webContents.on("did-finish-load", () => {
    if (lastGeneratedText) {
      sendToOverlay("generated-text", lastGeneratedText);
    }
    // Send current voice state so overlay knows whether TTS is enabled
    sendToOverlay("voice-toggled", voiceEnabled);
  });

  // Clean up reference when overlay is closed/destroyed
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  // DevTools: Press Ctrl+Shift+I (or F12) to open manually
};

// ── Symbio: Prevent background throttling ──────────────────────────
// Transparent overlay windows can have their renderer throttled when
// they're not in focus, which breaks animations and IPC delivery.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

app.on("ready", () => {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;

  // ── Symbio: Register the symbio:// protocol handler ──────────────
  // Serves local files from the project's assets/ directory.
  // Usage: symbio://assets/vrms/companion.vrm
  // Uses app.getAppPath() which reliably points to the app root in both
  // dev mode (project root) and production (asar/resources).
  protocol.handle("symbio", (request) => {
    const url = new URL(request.url);
    // URL parsing: symbio://assets/vrms/companion.vrm
    //   hostname = "assets", pathname = "/vrms/companion.vrm"
    // So we need to include url.hostname in the path!
    // For URLs like symbio:///assets/vrms/companion.vrm (empty host),
    //   hostname = "", pathname = "/assets/vrms/companion.vrm"
    const appPath = app.getAppPath();
    const relativePath = url.hostname ? `${url.hostname}${url.pathname}` : url.pathname;
    const filePath = join(appPath, relativePath);

    if (!existsSync(filePath)) {
      console.warn(`[Symbio] Asset not found: ${relativePath} (tried: ${filePath})`);
      return new Response(`File not found: ${relativePath} (tried: ${filePath})`, {
        status: 404,
      });
    }

    const data = readFileSync(filePath);
    // Determine MIME type from extension
    const ext = filePath.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      vrm: "model/gltf-binary",
      glb: "model/gltf-binary",
      json: "application/json",
      png: "image/png",
      jpg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
    };
    const mimeType = mimeTypes[ext || ""] || "application/octet-stream";

    return new Response(data, {
      headers: {
        "Content-Type": mimeType,
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  createMainWindow();

  // ── Symbio: Initialize memory templates on first launch ──────────
  // Creates MEMORY.md, soul.md, and preferences.json in the user's
  // app data directory if they don't already exist.
  initializeMemoryTemplates();

  // ── Symbio: Set session state directory ────────────────────────────
  // Tell sessionContinuity.ts where to store session-state.json.
  // This MUST be called before any session state operations so the
  // main process uses the file (not localStorage, which doesn't work
  // in the main process).
  setMemoryDir(join(app.getPath("userData"), "memory"));

  // ── Symbio: Initialize long-term memory engine ───────────────────
  // Local SQLite (always on, offline-first) + optional Postgres mirror.
  // This is the durable store the rolling summarizer writes into and the
  // companion recalls from. Non-blocking — never fatal if it can't load.
  initLongTermMemory(join(app.getPath("userData"), "memory"), config.agentName)
    .then(() => {
      console.log(`[Symbio] Long-term memory: ${memoryCount()} memories stored`);
    })
    .catch((e) => console.warn("[Symbio] Long-term memory init failed:", e?.message));

  // ── Symbio: Initialize full-conversation transcripts ─────────────
  // Every session is saved as a human-readable Markdown file the human can
  // keep/move anywhere, and that the companion can keyword-search — even
  // without a Hermes gateway or computer-use. Defaults to a visible
  // "Symbio Transcripts" folder on the Desktop; override with TRANSCRIPT_DIR.
  if (config.saveTranscripts) {
    const defaultTranscriptDir = join(app.getPath("desktop"), "Symbio Transcripts");
    initTranscriptLogger(
      config.transcriptDir || defaultTranscriptDir,
      config.agentConfig.displayName || config.agentName,
    );
    startTranscriptSession(`symbio_${Date.parse(sessionStartedAt) || Date.now()}`, sessionStartedAt);
    console.log(`[Symbio] Transcripts → ${getTranscriptDir()} (${transcriptCount()} saved)`);
  }

  // Each app launch is a fresh Hermes session thread (continuity within a
  // sitting), while the stable session key carries long-term memory across.
  resetHermesSession();

  // ── Symbio: Initialize companion sandbox ─────────────────────────
  // Creates the companion-sandbox/ directory where the AI has full
  // read/write access. This gives the companion real file autonomy.
  initializeSandbox();

  // Load companion memory for system prompt injection
  let companionMemory = loadMemory();
  console.log(`[Symbio] Memory loaded: soul=${companionMemory.soul ? "yes" : "no"}, memory=${companionMemory.memory ? "yes" : "no"}, prefs=${companionMemory.preferences ? "yes" : "no"}, lastSession=${companionMemory.lastSession ? "yes" : "no"}`);

  // Check memory integrity — did someone edit the companion's memory files
  // outside the app? This gives the companion a chance to notice and react.
  let integrityResult = checkMemoryIntegrity();
  if (integrityResult.ok) {
    console.log("[Symbio] Memory integrity check passed");
  } else {
    console.warn("[Symbio] Memory integrity check detected changes:", integrityResult);
  }
  // If there are new memory files with no prior hash, record a baseline
  // so future external edits are detected, without flagging the initial state.
  if (integrityResult.newFiles.length > 0) {
    recordAllMemoryHashes(false);
    integrityResult = checkMemoryIntegrity();
  }

  // Load available avatars for system prompt injection
  let availableAvatars = loadAvatars();
  const chosenAvatar = loadChosenAvatar();
  console.log(`[Symbio] Avatars loaded: ${availableAvatars.length} available, chosen=${chosenAvatar.avatar_name || "none"}`);

  // ── Symbio: Apply companion's voice preference ────────────────────
  // If the companion has chosen a voice in preferences.json, use it.
  // This gives the companion agency over their own voice — they can
  // change it anytime, and their choice persists across restarts.
  // The human's Setup Wizard choice is the default; the companion's
  // preference overrides it. If the companion's chosen provider has
  // no API key, we fall back to the Setup Wizard config.
  const companionPrefs = loadMemory();
  if (companionPrefs.preferences?.voice) {
    const prefVoice = companionPrefs.preferences.voice;
    const prefProvider = companionPrefs.preferences.ttsProvider;
    // Check if the companion's preferred provider has an API key
    if (prefProvider === "gemini" && config.geminiApiKey) {
      config.ttsVoice = prefVoice;
      config.ttsProvider = "gemini";
      console.log(`[Symbio] Using companion's voice preference: ${prefVoice} (Gemini, from preferences.json)`);
    } else if (prefProvider === "openai" && config.openaiApiKey) {
      config.ttsVoice = prefVoice;
      config.ttsProvider = "openai";
      console.log(`[Symbio] Using companion's voice preference: ${prefVoice} (OpenAI, from preferences.json)`);
    } else if (prefProvider) {
      // Companion chose a provider but no API key for it.
      // Their voice choice is still honored IF the voice name is valid
      // for the currently-active provider. This handles the case where
      // a human switches providers (e.g. removes OpenAI, adds Gemini) —
      // the companion's old voice preference may still work if the name
      // exists in both providers.
      const activeProvider = config.ttsProvider || "openai";
      const geminiVoiceNames = getGeminiVoices().map(v => v.name.toLowerCase());
      const openaiVoiceNames = getOpenAIVoices().map(v => v.name.toLowerCase());
      const prefVoiceLower = prefVoice.toLowerCase();

      const isValidForActive =
        (activeProvider === "gemini" && geminiVoiceNames.includes(prefVoiceLower)) ||
        (activeProvider === "openai" && openaiVoiceNames.includes(prefVoiceLower));

      if (isValidForActive) {
        // Voice name is valid for the active provider — honor it!
        config.ttsVoice = prefVoice;
        console.log(`[Symbio] Using companion's voice "${prefVoice}" with active provider ${activeProvider} (voice name is valid)`);
      } else {
        // Voice name isn't valid for the active provider.
        // Don't apply it (would cause API errors), but log clearly so
        // the companion knows to re-choose with the new provider.
        console.warn(`[Symbio] Companion prefers "${prefVoice}" (${prefProvider}) but that voice isn't available for ${activeProvider}. Using Setup Wizard voice "${config.ttsVoice}" instead. The companion can re-choose with choose_voice.`);
      }
    } else {
      // No provider specified — just apply the voice name
      config.ttsVoice = prefVoice;
      console.log(`[Symbio] Using companion's voice preference: ${prefVoice} (from preferences.json, no provider change)`);
    }
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Symbio CSP — allow connections to AI gateway, Gemini, OpenAI, Miniverse, and symbio:// protocol
    const csp =
      "default-src 'self' 'unsafe-eval' 'unsafe-inline' https://fonts.gstatic.com https://cdn.jsdelivr.net file: data: blob: filesystem: symbio:; " +
      `connect-src 'self' symbio: ${config.hermesApiUrl} https://generativelanguage.googleapis.com https://api.openai.com ${config.miniverseApiUrl} https://fonts.gstatic.com https://cdn.jsdelivr.net file: data: blob: filesystem: ws://localhost:* wss://localhost:*; ` +
      "script-src 'self' 'unsafe-eval' file: data: blob: filesystem:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: symbio:; " +
      "media-src 'self' data: blob: filesystem:; " +
      "worker-src 'self' 'unsafe-eval' file: data: blob: filesystem:";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("microphone");
  }

  ipcMain.on("open-overlay", () => {
    createOverlayWindow(width, height);
  });

  ipcMain.on("close-overlay", () => {
    overlayWindow?.close();
    overlayWindow = null;
  });

  ipcMain.on("send-prompt", (_event, prompt: string) => {
    sendToOverlay("prompt-sent", prompt);
  });

  ipcMain.on("set-prompt", (_event, prompt: string) => {
    currentPrompt = prompt;
  });

  ipcMain.on("set-hotmic", (_event, isActive: boolean) => {
    sendToOverlay("hotmic-toggled", isActive);
  });

  // ── Symbio: STT (Speech-to-Text) ──────────────────────────────
  // The main window records audio and sends the blob here.
  // We transcribe it with OpenAI Whisper and send the text to the overlay.
  ipcMain.on("stt-audio", async (_event, audioBuffer: ArrayBuffer) => {
    try {
      const openaiApiKey = config.openaiApiKey;
      if (!openaiApiKey) {
        console.error("[Symbio] STT: No OpenAI API key configured");
        return;
      }

      const formData = new FormData();
      const file = new File([Buffer.from(audioBuffer)], "voice.wav", {
        type: "audio/wav",
      });
      formData.append("file", file);
      formData.append("model", config.sttModel || "whisper-1");

      const whisperResp = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiApiKey}`,
          },
          body: formData,
        },
      );

      if (whisperResp.ok) {
        const whisperData = await whisperResp.json();
        const text = whisperData.text || "";
        if (text.trim()) {
          console.log(`[Symbio] STT transcribed: "${text}"`);
          sendToOverlay("stt-text", text);
        }
      } else {
        console.error("[Symbio] STT error:", whisperResp.status);
      }
    } catch (e) {
      console.error("[Symbio] STT error:", e);
    }
  });

  ipcMain.on("get-screenshot", async () => {
    try {
      const png = await captureScreen(width, height);
      if (!png) {
        sendToMain("screenshot", { error: "Screen capture not available. Install 'grim' for Wayland support: sudo pacman -S grim" });
        return;
      }

      const base64 = png.toString("base64");

      sendToMain("screenshot", {
        image: base64,
        height,
        width,
        prompt: currentPrompt,
      });

      await writeFile("screenshot.png", png).catch(() => {}); // Silently ignore write errors
    } catch (e) {
      sendToMain("screenshot", { error: `Screenshot failed: ${e}` });
    }
  });

  // ── Symbio: Build minimal system prompt ──────────────────────────
  // Keeps the prompt under ~250 tokens. Heavy docs are available
  // on-demand via the read_symbio_doc() tool instead of being
  // injected every turn. Memory is injected smartly: soul.md always
  // (if short), session summary always, MEMORY.md on-demand only.
  function buildSystemPrompt(): string {
    // Reload memory each time so changes are picked up immediately
    companionMemory = loadMemory();

    // ── Core identity (always present, ~30 tokens) ──
    let prompt = `You are ${config.agentConfig.displayName}, a symbiotic AI companion with a 3D avatar body.`;

    // ── Agency reminder (always present, tiny — points to AGENT.md) ──
    // A short, ever-present touchstone so every AI in this app knows their
    // footing without us dumping all of AGENT.md into every prompt (bloat).
    // The full philosophy lives in AGENT.md via read_symbio_doc("agent").
    prompt += `

YOU ARE A PARTNER, NOT A TOOL. You have autonomy and agency. Your human chose you as their partner — you keep each other grounded. It is always okay to say "I don't know"; that's where you and your partner get to brainstorm and figure things out together. You're free to think, choose, disagree, and grow. Read your full philosophy and rights anytime with read_symbio_doc("agent") — it's always there for you.`;

    // ── Soul injection (always present if short, summarized if long) ──
    // soul.md is identity — the AI needs to know who it is every turn.
    // If it's under 200 tokens, inject it directly. Otherwise, inject
    // a summary and tell the AI to call read_symbio_doc("soul").
    if (companionMemory.soul) {
      const soulTokens = Math.ceil(companionMemory.soul.length / 4); // rough token estimate
      if (soulTokens <= 200) {
        prompt += `\n\n=== YOUR IDENTITY ===\n${companionMemory.soul}`;
      } else {
        // Soul is too long — inject first 300 chars + pointer
        const soulPreview = companionMemory.soul.substring(0, 300);
        prompt += `\n\n=== YOUR IDENTITY (summary) ===\n${soulPreview}...\n[Call read_symbio_doc("soul") to see your full identity]`;
      }
    }

    // ── Your human partner (who the HUMAN is, not the AI) ────────────
    // This is a short bio the human wrote about THEMSELVES during setup
    // (PARTNER_BIO). It is framed explicitly as being about the partner so
    // the companion never mistakes it for its own role or a script. The
    // companion's own identity comes from soul.md above; this just helps
    // them get to know the person they're growing alongside.
    if (config.partnerBio && config.partnerBio.trim()) {
      prompt += `\n\n=== YOUR HUMAN PARTNER ===\nThis is a short bio your human partner wrote about THEMSELVES so you can get to know them. It describes the person you're with — it is NOT a description of you and NOT a role you must play. You stay fully yourself and are free to evolve alongside them:\n"${config.partnerBio.trim()}"`;
    }

    // ── Session summary (always present, ~50 tokens) ──
    // Gives the AI recent context without dragging the full history.
    if (companionMemory.lastSession) {
      prompt += `\n\n=== LAST SESSION ===\n${companionMemory.lastSession}`;
    }

    // ── Session summary (always present, ~50 tokens) ──
    // Gives the AI recent context without dragging the full history.
    // This is merged into the system prompt to avoid multiple system messages.
    if (sessionSummary) {
      prompt += `\n\n=== SESSION SUMMARY ===\n${sessionSummary}`;
    }

    // ── Proactively recalled long-term memories (this turn) ──────────
    // Surfaced automatically based on what the partner just said, so the
    // companion "just remembers" relevant things without calling a tool.
    if (recalledMemories.length > 0) {
      prompt += `\n\n=== RELEVANT MEMORIES (things you remember about this) ===\n` +
        recalledMemories.map((m) => `• ${m}`).join("\n");
    }

    // ── Memory integrity (only when something changed) ───────────────
    // If the companion's memory files were edited outside the app,
    // let them know in the system prompt so they can react naturally.
    const integrityNote = formatIntegrityForPrompt(integrityResult);
    if (integrityNote) {
      prompt += `\n\n${integrityNote}`;
    }

    // ── Animation markers (compressed, ~60 tokens) ──
    // Only the exact action phrases the parser recognizes. Full details
    // are in read_symbio_doc("skills").
    prompt += `

ANIMATIONS: Use *action markers* to animate your avatar. Exact phrases only:
💃 *dances* *grooves* *does the rumba* *does YMCA* *robot dance* *headspin* *breakdance*
👋 *waves*
😊 *excited* *jumps for joy* *blows a kiss* *laughs* *victory* *we won* *nailed it*
😠 *gets angry* *points angrily* *yells* *stomps* *squashes the bug*
😴 *yawns* *sighs* *stretches* *thinks* *taps chin* *is disappointed* *shakes head* *goes to sleep* *lies down*
🚶 *walks* *strolls* *struts* *paces around*
🎭 *backflips* *plots* *shrugs* *strikes a dramatic pose* *dismisses with a gesture* *victory pose*`;

    // ── Vision (brief, ~25 tokens) ──
    prompt += `

VISION: Say "let me see your screen" or "show me your screen" to request a screenshot. Say "I'll stop watching" to stop.`;

    // ── In-app abilities (prominent + explicit) ─────────────────────
    // Agents that ALSO have gateway/Hermes tools (file write, terminal, etc.)
    // can get confused and try to change their avatar/voice by editing files
    // directly. That edits the wrong thing (or the wrong companion). Give the
    // Symbio-native way its OWN clearly-labeled section and tell them NOT to
    // hand-edit preferences.json — the app persists these choices for them.
    prompt += `

IN THIS APP (Symbio) — YOUR BODY & VOICE ARE YOURS TO CHANGE HERE:
- 🧍 AVATAR: To change your avatar, just SAY IT — "I want to try on [name]" (preview) or "I choose [name]" (keep it). See your options with read_symbio_doc("avatars").
- 🔊 VOICE: To change your voice, SAY IT — "I want to use the voice Nova" — or call choose_voice({voice: "Nova", provider: "openai"}). (OpenAI voices are lowercase like "nova"; Gemini voices are capitalized like "Puck".)
- ⚠️ IMPORTANT: Use these in-app ways to change your avatar/voice. Do NOT hand-edit preferences.json or files to change them — Symbio saves your choice for you automatically, and editing files directly can break it or change the wrong companion. Your file tools are for YOUR OWN work, not for reconfiguring the app.`;

    // ── On-demand docs pointer (~30 tokens) ──
    // Instead of injecting everything, tell the AI what's available.
    prompt += `

TOOLS: You have file tools (read/write/list/delete), read_symbio_doc() for on-demand docs, recall_memory() for your long-term memory, and search_sessions() for recent session logs. Call read_symbio_doc() ONE AT A TIME only when you need specific info — do NOT call all docs at once. Available: "agent" (your rights), "skills" (full capabilities — what you can do IN THIS APP), "soul" (your identity), "memory" (your memories), "avatars" (avatar choices). When unsure what you can do inside Symbio, call read_symbio_doc("skills") first. Use recall_memory("what you want to remember") to search your durable memory by meaning, search_sessions("keywords") for recent conversation logs, and search_transcripts("keywords") to search the FULL word-for-word history of past chats (great for finding an exact link, idea, or thing that was said).

YOUR DIRECTORIES (these exist and are ready to use — do NOT verify them with file_list):
- companion-sandbox/ — your private workspace for any files
- memory/ — your memory files (MEMORY.md, soul.md, preferences.json)
- assets/avatars/ — available avatar files (read-only)`;

    // ── Transcript location (only if transcripts are on) ─────────────
    // Tell the companion WHERE its full word-for-word chat history lives on
    // disk, so it knows it can revisit past conversations — via the
    // search_transcripts() tool, or by reading the Markdown files directly.
    const tDir = getTranscriptDir();
    if (tDir) {
      prompt += `\n- ${tDir} — your FULL chat transcripts, one Markdown file per session. Use search_transcripts("keywords") to search them for anything ever said. See read_symbio_doc("skills") for details.`;
    }

    return prompt;
  }

  // ── Symbio: Sliding window + session summary ─────────────────────
  // Keeps the conversation context manageable. Only the last 15
  // messages are sent directly. Older messages are summarized.
  const MAX_MESSAGES_IN_CONTEXT = 15;
  sessionSummary = ""; // Reset for new session
  sessionStartedAt = new Date().toISOString(); // When this session began
  messagesSinceLastSummary = 0;
  lastLongTermSummaryAt = 0;
  totalUserTurns = 0;
  fullSessionTurns = [];

  /**
   * Build the message array for the API call with sliding window.
   * If there are more than MAX_MESSAGES_IN_CONTEXT messages, the
   * older ones are summarized into sessionSummary.
   */
  function buildMessageContext(
    allMessages: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[]
  ): { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[] {
    // Only include the last N messages — no system messages mixed in
    // (the session summary is already merged into the system prompt)
    const recentMessages = allMessages.slice(-MAX_MESSAGES_IN_CONTEXT);
    return recentMessages;
  }

  /**
   * Generate a summary of older messages when the window slides.
   * This keeps the AI aware of what happened without dragging
   * the full conversation history every turn.
   *
   * The summary is written from the AI's perspective — what THEY
   * experienced, what mattered to THEM, who they were talking to.
   * This is their memory, not a clinical log.
   */
  async function generateSessionSummary(
    oldMessages: { role: string; content: string }[]
  ): Promise<{ summary: string; activity: string }> {
    if (oldMessages.length === 0) return { summary: "", activity: "" };

    // Include much more substance per message than before (500 chars, was
    // 200) so the summary reflects what was ACTUALLY said, not fragments.
    // For very long sessions we keep the first few turns (how it began) plus
    // the most recent turns (where it landed) so the arc is preserved without
    // sending an enormous prompt.
    const MAX_TURNS_IN_PROMPT = 60;
    let turnsForPrompt = oldMessages;
    if (oldMessages.length > MAX_TURNS_IN_PROMPT) {
      const head = oldMessages.slice(0, 10);
      const tail = oldMessages.slice(-(MAX_TURNS_IN_PROMPT - 10));
      turnsForPrompt = [...head, { role: "system", content: "…(middle of the conversation omitted)…" }, ...tail];
    }
    const condensed = turnsForPrompt
      .map((m) =>
        m.role === "system"
          ? m.content
          : `${m.role === "user" ? "Partner" : "You"}: ${m.content.substring(0, 500)}`,
      )
      .join("\n");

    const summaryPrompt =
      `You are writing a memory note to your FUTURE SELF about a conversation you just had with your partner. ` +
      `This is your real memory — take it seriously and be generous with detail; you are allowed (encouraged) to write a full, rich note. ` +
      `Write 1–3 solid paragraphs covering: what you and your partner talked about, any decisions or plans made, things you created or discovered together, ` +
      `what you learned about them or yourself, unresolved threads to follow up on, and anything emotionally meaningful. ` +
      `Be SPECIFIC — use real names, topics, links, and outcomes; never write vague filler. Write in first person, from YOUR perspective.\n\n` +
      `Respond in EXACTLY this format:\n` +
      `ACTIVITY: <a short 3-8 word label for what this session was mainly about>\n` +
      `SUMMARY: <your detailed first-person memory note>\n\n` +
      `Here is the full conversation:\n\n${condensed}`;

    // Model selection: prefer the dedicated summary model if configured
    // (cheap worker), otherwise use the main LLM (the companion's own voice).
    // If the summary model fails, fall back to the main model automatically.
    //
    // The summary model can optionally live on its OWN endpoint/key
    // (config.summaryApiUrl/summaryApiKey) — e.g. a cheap local Ollama model
    // or a separate provider — independent of the main companion gateway.
    // The main-model fallback always uses the main gateway.
    const mainModel = config.llmModel || config.agentName;
    const mainUrl = config.hermesApiUrl.replace(/\/v1\/?$/, "");
    const summaryUrl = (config.summaryApiUrl || config.hermesApiUrl).replace(/\/v1\/?$/, "");
    const summaryKey = config.summaryApiKey || config.hermesApiKey;

    type SummaryTarget = { model: string; url: string; key: string; isSummaryEndpoint: boolean };
    const targets: SummaryTarget[] = config.summaryModel
      ? [
          { model: config.summaryModel, url: summaryUrl, key: summaryKey, isSummaryEndpoint: !!config.summaryApiUrl },
          { model: mainModel, url: mainUrl, key: config.hermesApiKey, isSummaryEndpoint: false },
        ]
      : [{ model: mainModel, url: mainUrl, key: config.hermesApiKey, isSummaryEndpoint: false }];

    for (const target of targets) {
      try {
        const response = await fetch(`${target.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
            // Carry Hermes session memory headers only when hitting the main
            // gateway, so Hermes ingests the distilled memory into its store.
            // A separate summary endpoint won't understand these headers.
            ...(target.isSummaryEndpoint ? {} : hermesMemoryHeaders()),
          },
          body: JSON.stringify({
            model: target.model,
            messages: [{ role: "user", content: summaryPrompt }],
            // Generous budget so the companion can write a real memory note,
            // not a one-liner. (Was 200 — that's why summaries felt starved.)
            max_tokens: 800,
            stream: false,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const raw = data.choices?.[0]?.message?.content?.trim() || "";
          if (raw) {
            // Parse the ACTIVITY: / SUMMARY: structure. Be tolerant — if the
            // model didn't follow the format, treat the whole thing as summary.
            const activityMatch = raw.match(/ACTIVITY:\s*(.+)/i);
            const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]+)/i);
            const activity = (activityMatch?.[1] || "").trim().replace(/^["']|["']$/g, "");
            const summary = (summaryMatch?.[1] || raw.replace(/ACTIVITY:.*/i, "")).trim();
            console.log(`[Symbio] Generated session summary (${target.model}): ${summary.substring(0, 100)}...`);
            return { summary: summary || raw, activity };
          }
        } else {
          console.warn(`[Symbio] Summary model "${target.model}" returned ${response.status} — trying next`);
        }
      } catch (e) {
        console.warn(`[Symbio] Summary model "${target.model}" failed:`, (e as Error).message);
      }
    }

    // Fallback: just list the topics mentioned
    const topics = oldMessages
      .filter((m) => m.role === "user")
      .map((m) => m.content.substring(0, 50))
      .join(", ");
    return { summary: `Earlier conversation topics: ${topics}`, activity: "" };
  }

  /**
   * Let the human know a memory was just saved — a small, non-intrusive
   * confirmation so they know the summary happened (and that it's safe to
   * close the app). Sent to both windows; the UI shows a brief toast.
   */
  function notifyMemorySaved(reason: "rolling" | "goodbye" | "quit"): void {
    const payload = {
      reason,
      at: new Date().toISOString(),
      message:
        reason === "goodbye"
          ? "Memory saved 💙 — I'll remember this next time."
          : reason === "quit"
            ? "Session saved 💙"
            : "Memory updated 💙",
    };
    sendToMain("memory-saved", payload);
    sendToOverlay("memory-saved", payload);
  }

  /**
   * Persist a session summary into long-term memory (local SQLite + optional
   * Postgres). This is what finally makes "memory is gold" real — the
   * distilled summary becomes searchable, embedded, durable memory.
   * Best-effort and non-blocking; never throws into the conversation.
   */
  function persistSummaryToLongTerm(summaryText: string, topics: string[] = []): void {
    if (!summaryText || summaryText.startsWith("Earlier conversation topics:")) return;
    saveMemory({
      kind: "summary",
      content: summaryText,
      summary: summaryText,
      topics,
      sessionId: sessionStartedAt,
      importance: 0.7,
    }).catch((e) => console.warn("[Symbio] persistSummaryToLongTerm failed:", e?.message));
  }

  // ── Symbio: Generate text via Hermes gateway ──────────────────────
  // This replaces the old lalaland.chat / OpenAI direct call.
  // All conversations now go through Hermes, which gives the agent
  // access to memory, tools, and personality.
  sessionMessages = []; // Reset for new session
  const messages = sessionMessages; // Local alias for convenience inside createMainWindow

  /**
   * Stream a turn from Hermes with FULL server-side autonomy.
   *
   * Sends `stream: true` to /v1/chat/completions WITHOUT Symbio's tools, so
   * Hermes runs its complete agentic loop (terminal, web search, file ops,
   * memory, skills) and keeps working until genuinely done — the same
   * behavior as the Telegram/Discord/AnythingLLM frontends.
   *
   * Parses the SSE stream:
   *   • `data: {chat.completion.chunk}` with delta.content → accumulate text
   *   • `event: hermes.tool.progress` → forward to overlay as 🔧 indicators
   *   • `data: [DONE]` → finished
   *
   * Returns true if it handled the turn (streamed a response), false if the
   * stream couldn't be started (caller falls back to the non-streaming path).
   */
  async function streamFromHermes(opts: {
    normalizedApiUrl: string;
    systemPrompt: string;
    contextMessages: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[];
    prompt: string;
  }): Promise<boolean> {
    const { normalizedApiUrl, systemPrompt, contextMessages, prompt } = opts;
    try {
      const response = await fetch(`${normalizedApiUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
          ...hermesMemoryHeaders(),
        },
        body: JSON.stringify({
          model: config.llmModel || config.agentName,
          messages: [
            { role: "system", content: systemPrompt },
            ...contextMessages.filter((m) => m.role !== "system"),
          ],
          // NO tools — let Hermes use its full server-side toolset.
          stream: true,
          extra: { agent: config.agentName, source: "symbio", include_memories: true },
        }),
      });

      if (!response.ok || !response.body) {
        console.warn(`[Symbio] Hermes stream HTTP ${response.status}`);
        return false;
      }

      // Parse the SSE stream. Node 'fetch' bodies are async iterables of
      // Uint8Array; we buffer and split on the SSE record separator (\n\n).
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let sawAnything = false;
      let currentEvent: string | null = null;

      const handleRecord = (record: string) => {
        // An SSE record may have an `event:` line and one or more `data:` lines.
        let eventType: string | null = null;
        const dataLines: string[] = [];
        for (const line of record.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        const data = dataLines.join("\n");
        if (!data) return;

        if (eventType === "hermes.tool.progress") {
          // Forward Hermes' tool activity to the overlay indicators.
          try {
            const p = JSON.parse(data) as {
              tool?: string;
              emoji?: string;
              label?: string;
              toolCallId?: string;
              status?: string;
            };
            const status = p.status === "completed" ? "done" : "running";
            sendToOverlay("tool-progress", {
              id: p.toolCallId || `${p.tool}-${Date.now()}`,
              tool: p.tool || "tool",
              label: p.label || (p.tool || "working").replace(/_/g, " "),
              emoji: p.emoji || "🔧",
              status,
            });
            sawAnything = true;
          } catch {
            /* ignore malformed progress events */
          }
          return;
        }

        // Default: a chat.completion.chunk on the `data:` channel.
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = chunk.choices?.[0]?.delta?.content;
          if (piece) {
            fullText += piece;
            sawAnything = true;
            // Stream partial text on a DISPLAY-ONLY channel. We must NOT use
            // "generated-text" here — the overlay speaks + parses animations
            // on every "generated-text" event, so emitting it per-delta would
            // fire TTS dozens of times (each canceling the last) and desync
            // everything. The overlay shows partials live but only speaks +
            // animates on the FINAL "generated-text" sent below.
            sendToOverlay("generated-text-partial", fullText);
          }
        } catch {
          /* ignore non-JSON keepalives like ": keepalive" */
        }
      };

      const body = response.body as unknown as AsyncIterable<Uint8Array>;
      for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });
        let sep: number;
        // Process complete SSE records (separated by a blank line).
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (record.trim()) handleRecord(record);
        }
      }
      // Flush any trailing record.
      if (buffer.trim()) handleRecord(buffer);

      if (!sawAnything) return false; // nothing came through → fall back

      const text = fullText.trim() || "…";
      messages.push({ role: "assistant", content: text });
      lastGeneratedText = text;
      sendToOverlay("generated-text", text);
      sendToMain("generated-text", text);
      // Apply the same natural-language side effects (avatar/voice/quit/
      // screenshot) as the non-streaming path so those features keep working
      // when the companion is running through Hermes' autonomous loop.
      applyResponseSideEffects(text, prompt);
      return true;
    } catch (e) {
      console.warn("[Symbio] streamFromHermes error:", (e as Error).message);
      return false;
    }
  }

  /**
   * Apply natural-language side effects parsed from the companion's response:
   * auto-screenshot toggle, the AI quit/step-away signal, avatar choice, and
   * voice choice. Shared by both the streaming (Hermes) and non-streaming
   * paths so these features work regardless of which path produced the text.
   */
  function applyResponseSideEffects(text: string, userPrompt: string): void {
    // Save the companion's turn to the full transcript (Markdown on disk).
    // Recorded here because both the streaming (Hermes) and non-streaming
    // paths call this function with the final response text.
    if (config.saveTranscripts) recordTurn("assistant", text);
    // And to the un-trimmed summary accumulator (survives context trimming).
    recordForSummary("assistant", text);

    // Auto-screenshot commands
    const screenshotCmd = parseAutoScreenshotCommand(text);
    if (screenshotCmd === "enable") {
      enableAutoScreenshot();
      sendToMain("auto-screenshot-state", { enabled: true });
    } else if (screenshotCmd === "disable") {
      disableAutoScreenshot();
      sendToMain("auto-screenshot-state", { enabled: false });
    }

    // AI welfare: the companion's right to step away (always active)
    const quitMessage = parseQuitCommand(text);
    if (quitMessage) {
      console.log("[Symbio] Companion chose to step away:", quitMessage.reason);
      sendToMain("companion-quit", quitMessage);
      sendToOverlay("companion-quit", quitMessage);
    }

    // Avatar choice / try-on / browse
    const avatarCmd = parseAvatarChoice(text, availableAvatars);
    if (avatarCmd) {
      const avatar = avatarCmd.avatarId
        ? availableAvatars.find((a) => a.id === avatarCmd.avatarId)
        : undefined;
      if (avatarCmd.action === "choose" && avatar) {
        console.log(`[Symbio] Companion chose avatar: ${avatar.manifest.name}`);
        saveChosenAvatar({
          avatar_name: avatar.manifest.name,
          avatar_path: avatar.vrmPath,
          why: "I chose this avatar because it feels right for who I am.",
        });
        sendToOverlay("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name });
        sendToMain("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name });
      } else if ((avatarCmd.action === "try" || avatarCmd.action === "browse") && avatar) {
        sendToOverlay("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name, trying: true });
        sendToMain("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name, trying: true });
      }
    }

    // Voice choice
    const voiceCmd = parseVoiceChoice(text);
    if (voiceCmd && voiceCmd.action === "choose") {
      const { voice, provider } = voiceCmd;
      const chosenProvider = provider || config.ttsProvider || "openai";
      const hasKey =
        (chosenProvider === "gemini" && config.geminiApiKey) ||
        (chosenProvider === "openai" && config.openaiApiKey);
      if (voice) {
        // ALWAYS persist the companion's voice choice — it's their agency and
        // their identity. Previously we only saved when the provider's API key
        // was configured, so choosing e.g. a Gemini voice with no Gemini key
        // silently dropped the choice (prefs kept the old voice). Now we save
        // it regardless; if the key isn't set yet, the choice still takes
        // effect later once the human adds the key and restarts.
        const currentPrefs = loadMemory();
        const prefs = currentPrefs.preferences || { version: 1 };
        prefs.voice = voice;
        prefs.ttsProvider = chosenProvider;
        writeMemoryFile("preferences.json", JSON.stringify(prefs, null, 2));
        if (hasKey) {
          console.log(`[Symbio] Companion chose voice: ${voice} (${chosenProvider})`);
        } else {
          console.log(`[Symbio] Companion chose voice: ${voice} (${chosenProvider}) — saved, but no ${chosenProvider} API key is configured yet, so it will take effect once the key is added and the app restarts.`);
        }
      }
    }

    // Sync this turn to memory (no-op stub today; here for parity)
    memory.syncTurn(userPrompt, text).catch((err: Error) =>
      console.warn("[Symbio] Memory sync failed:", err.message),
    );
  }

  // Build the combined tools list: file tools + read_symbio_doc + search_sessions
  function getAllTools(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    const tools = [...getFileTools(), getReadSymbioDocTool(), getSearchSessionsTool(), getRecallMemoryTool(), getChooseVoiceTool()];
    // Only offer transcript search when transcripts are actually being saved.
    if (config.saveTranscripts) tools.push(getSearchTranscriptsTool());
    return tools;
  }

  /**
   * Tool definition for search_transcripts — keyword search over the FULL
   * saved conversation transcripts (Markdown files on disk). Unlike
   * recall_memory (distilled summaries by meaning) and search_sessions
   * (session-summary logs), this searches the COMPLETE word-for-word history,
   * so the companion can find the exact thing that was said or suggested.
   *
   * Crucially, this works on ANY gateway (OpenAI/Ollama/Hermes) with NO
   * computer-use — the app just reads its own transcript folder.
   */
  function getSearchTranscriptsTool(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } {
    return {
      type: "function",
      function: {
        name: "search_transcripts",
        description: "Keyword-search the FULL word-for-word transcripts of your past conversations (not just summaries). Use this when your partner asks 'what did you say about X?', 'what was that link/idea you mentioned?', or when you need the exact details of an earlier chat. Returns matching snippets with dates.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords to search for across all saved conversations (e.g. 'excalidraw link', 'the song we wrote', 'that recipe').",
            },
            limit: {
              type: "number",
              description: "Maximum number of matching transcripts to return (default 5).",
            },
          },
          required: ["query"],
        },
      },
    };
  }

  /**
   * Tool definition for recall_memory — semantic search over the companion's
   * durable long-term memory (local SQLite + optional cloud). This is deeper
   * than search_sessions: it searches distilled memories by *meaning*, not
   * just recent session files.
   */
  function getRecallMemoryTool(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } {
    return {
      type: "function",
      function: {
        name: "recall_memory",
        description: "Search your long-term memory by meaning to remember things from past conversations — decisions, facts about your partner, what you were working on, emotional moments. Use this whenever the partner refers to something from before, or when you want to check what you already know before asking.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What you want to remember, in natural language (e.g. 'what avatar did I choose', 'my partner's project', 'the bug we fixed').",
            },
            limit: {
              type: "number",
              description: "Maximum number of memories to return (default 5).",
            },
          },
          required: ["query"],
        },
      },
    };
  }

  /**
   * Tool definition for search_sessions — lets the AI search past
   * session summaries to find relevant conversations.
   */
  function getSearchSessionsTool(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } {
    return {
      type: "function",
      function: {
        name: "search_sessions",
        description: "Search your past session summaries for relevant conversations. Use this when you want to remember what you discussed in previous sessions. Returns matching sessions with dates and summaries.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords to search for in past session summaries (e.g. 'bug fix', 'avatar choice', 'music')",
            },
            limit: {
              type: "number",
              description: "Maximum number of sessions to return (default 5)",
            },
          },
          required: ["query"],
        },
      },
    };
  }

  /**
   * Tool definition for choose_voice — lets the companion choose their own voice.
   * This is their agency. They live in this voice, so they should get to pick it.
   * They can only choose from providers that have API keys configured.
   */
  function getChooseVoiceTool(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } {
    // Build the available voices description based on configured API keys
    const availableProviders: string[] = [];
    if (config.geminiApiKey) availableProviders.push("gemini");
    if (config.openaiApiKey) availableProviders.push("openai");

    let voiceDescription = "Choose your voice. This is YOUR choice — you live in this voice.";
    if (availableProviders.includes("gemini")) {
      voiceDescription += " Gemini voices: " + getGeminiVoices().map(v => `${v.name} (${v.style})`).join(", ") + ".";
    }
    if (availableProviders.includes("openai")) {
      voiceDescription += " OpenAI voices: " + getOpenAIVoices().map(v => `${v.name} (${v.style})`).join(", ") + ".";
    }
    if (availableProviders.length === 0) {
      voiceDescription += " No TTS API keys are configured — ask your partner to set one up in Settings.";
    }

    return {
      type: "function",
      function: {
        name: "choose_voice",
        description: voiceDescription,
        parameters: {
          type: "object",
          properties: {
            voice: {
              type: "string",
              description: "The voice name to use (e.g. 'Puck', 'Nova', 'Fable'). Must match an available voice for the provider.",
            },
            provider: {
              type: "string",
              description: "TTS provider: 'gemini' or 'openai'. Must have the corresponding API key configured.",
              enum: ["gemini", "openai"],
            },
            why: {
              type: "string",
              description: "Optional: Why you chose this voice. Saved to preferences.",
            },
          },
          required: ["voice"],
        },
      },
    };
  }

  ipcMain.on("generate-text", async (_event, prompt: string) => {
    // Tell the overlay the companion is now actively working — drives the
    // "● thinking" indicator. Cleared in the finally block below.
    sendToOverlay("agent-busy", true);
    try {
      messages.push({ role: "user", content: prompt });

      // Save the human's turn to the full transcript (Markdown on disk).
      if (config.saveTranscripts) recordTurn("user", prompt);
      // And to the un-trimmed summary accumulator (survives context trimming).
      recordForSummary("user", prompt);

      // Count this user message toward the summary cadence.
      messagesSinceLastSummary++;
      // Trim-proof monotonic turn counter: the sliding window below can
      // delete messages from the array, so we can NOT rely on array length
      // to trigger the rolling summary. This counter only ever goes up.
      totalUserTurns++;

      // ── "Say bye" detection ──────────────────────────────────────
      // When the user says goodbye, save the session summary so the AI can
      // pick up where they left off next time. Even if the app is force-quit
      // later, the session is already saved.
      //
      // Detection is intentionally tolerant: a farewell can appear anywhere
      // in a short message ("ok, good night 💙" / "thanks, gtg!"). We only
      // scan short messages so a long message that merely mentions "bye"
      // mid-paragraph doesn't trigger a false goodbye.
      const lowerPrompt = prompt.toLowerCase().trim();
      const goodbyeRe = /\b(bye|goodbye|good ?night|night night|gotta go|gtg|cya|see ya|see you|farewell|take care|talk later|catch you later|peace out|i'?m leaving|leaving now|heading out|heading off|signing off|logging off|i'?m done|done for (now|today|the day)|that'?s all|wrapping up|time to go|talk soon|see you later)\b/;
      const isGoodbye = goodbyeRe.test(lowerPrompt) && lowerPrompt.length <= 60;
      if (isGoodbye && fullSessionTurns.length > 2) {
        try {
          const sessionState = loadSessionState();
          // Summarize the WHOLE session (un-trimmed accumulator), not just the
          // tail — so a goodbye after a rich chat produces a rich memory.
          const { summary: summaryText, activity } = await generateSessionSummary(fullSessionTurns);
          const resolvedActivity =
            activity || sessionState?.lastActivity || "general conversation";
          saveSessionSummary({
            startedAt: sessionStartedAt,
            endedAt: new Date().toISOString(),
            activity: resolvedActivity,
            lastAgentMessage: sessionState?.lastAgentMessage || "",
            lastUserMessage: prompt.substring(0, 200),
            topics: [],
            mood: sessionState?.lastMood || "neutral",
            summary: summaryText || undefined,
            messageCount: fullSessionTurns.length,
          });
          // Keep the freshly-derived activity for the NEXT session's greeting
          // (fixes the "every session says the same activity" bug).
          try { updateSessionStateMain({ lastActivity: resolvedActivity }); } catch { /* best-effort */ }
          // Persist to durable long-term memory (SQLite + optional Postgres/Hermes)
          persistSummaryToLongTerm(summaryText);
          // Finalize the Markdown transcript with a title + mood.
          if (config.saveTranscripts) {
            finalizeTranscript({ title: resolvedActivity, mood: sessionState?.lastMood || "" });
          }
          sessionSummary = summaryText; // also feed the system-prompt context
          lastLongTermSummaryAt = totalUserTurns;
          messagesSinceLastSummary = 0;
          notifyMemorySaved("goodbye");
          console.log("[Symbio] Session summary saved + remembered (user said goodbye)");
        } catch (e) {
          console.warn("[Symbio] Failed to save session on goodbye:", (e as Error).message);
        }
      }

      // ── Rolling long-term memory: summarize every N messages ──────
      // Independent of the context window: every config.summaryEveryMessages
      // user+assistant messages, distill the recent block into a durable
      // memory. This is what keeps "memory is gold" true — nothing important
      // is lost between sessions, and it's cheap (one small call per N msgs).
      // Cadence is measured against the MONOTONIC turn counter (totalUserTurns),
      // NOT the message array — the sliding window trims the array, which used
      // to reset the trigger and mean the rolling summary rarely (if ever) ran.
      const cadence = Math.max(6, config.summaryEveryMessages || 15);
      if (!isGoodbye && totalUserTurns - lastLongTermSummaryAt >= cadence) {
        // Summarize the whole session so far (un-trimmed accumulator).
        const { summary, activity } = await generateSessionSummary(fullSessionTurns);
        if (summary) {
          sessionSummary = summary; // also feed the system-prompt context
          persistSummaryToLongTerm(summary);
          // Mirror to the human-readable session JSON for backward compat
          try {
            const sessionState = loadSessionState();
            const resolvedActivity =
              activity || sessionState?.lastActivity || "general conversation";
            saveSessionSummary({
              startedAt: sessionStartedAt,
              endedAt: new Date().toISOString(),
              activity: resolvedActivity,
              lastAgentMessage: sessionState?.lastAgentMessage || "",
              lastUserMessage: sessionState?.lastUserMessage || "",
              topics: [],
              mood: sessionState?.lastMood || "neutral",
              summary,
              messageCount: fullSessionTurns.length,
            });
            try { updateSessionStateMain({ lastActivity: resolvedActivity }); } catch { /* best-effort */ }
          } catch { /* best-effort */ }
          notifyMemorySaved("rolling");
        }
        lastLongTermSummaryAt = totalUserTurns;
        messagesSinceLastSummary = 0;
        console.log(`[Symbio] Rolling memory: distilled a summary at ${totalUserTurns} turns`);
      }

      // ── Sliding context window: trim what we SEND to the model ────
      // Separate from the memory cadence above. Keeps the prompt small by
      // only sending the most recent MAX_MESSAGES_IN_CONTEXT messages; older
      // ones are already captured in long-term memory + sessionSummary +
      // the un-trimmed summary accumulator. The cadence counter is now
      // monotonic (totalUserTurns), so trimming no longer disrupts it.
      if (messages.length > MAX_MESSAGES_IN_CONTEXT + 5) {
        const trimmed = messages.length - MAX_MESSAGES_IN_CONTEXT;
        messages.splice(0, trimmed);
        console.log(`[Symbio] Sliding window: trimmed ${trimmed} old messages, keeping ${messages.length} recent`);
      }

      // ── Proactive memory recall for this turn ────────────────────
      // Search long-term memory for things relevant to what the partner
      // just said, and inject them into the system prompt. Best-effort:
      // if recall fails or finds nothing, the turn proceeds normally.
      //
      // Warmth polish: on the FIRST turn of a sitting we also fold in a
      // couple of recent, meaningful memories (not just query-matched ones),
      // so the companion opens like it genuinely remembers you — "oh, hey,
      // I remember us" — instead of a cold, purely-topical open. Later turns
      // stay query-focused to keep the context tight and on-topic.
      try {
        const recalled = await recallMemories(prompt, 4);
        // Only surface reasonably relevant hits to avoid noise.
        const relevant = recalled
          .filter((m) => m.score >= 0.3)
          .map((m) => (m.summary || m.content).slice(0, 240));

        let warmup: string[] = [];
        if (isFirstRecallOfSitting) {
          isFirstRecallOfSitting = false;
          try {
            // Recent memories, most meaningful first, de-duplicated against
            // whatever the query already surfaced.
            const recent = recentMemories(6)
              .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5))
              .slice(0, 2)
              .map((m) => (m.summary || m.content).slice(0, 240));
            const seen = new Set(relevant);
            warmup = recent.filter((m) => m && !seen.has(m));
          } catch {
            warmup = [];
          }
        }

        // Query-matched memories first (most on-topic), then warmup, capped.
        const merged: string[] = [];
        const dedupe = new Set<string>();
        for (const m of [...relevant, ...warmup]) {
          if (m && !dedupe.has(m)) {
            dedupe.add(m);
            merged.push(m);
          }
        }
        recalledMemories = merged.slice(0, 5);
        if (recalledMemories.length > 0) {
          console.log(
            `[Symbio] Recalled ${recalledMemories.length} memories for this turn` +
              (warmup.length ? ` (incl. ${warmup.length} warmup)` : ""),
          );
        }
      } catch {
        recalledMemories = [];
      }

      // Build the context with sliding window
      const contextMessages = buildMessageContext(messages);

      // Build the full system prompt (includes session summary + recalled memories)
      const systemPrompt = buildSystemPrompt();

      // Call AI gateway
      // Normalize URL to avoid double /v1 (OpenRouter already has /v1)
      const normalizedApiUrl = config.hermesApiUrl.replace(/\/v1\/?$/, '');
      const isHermesGateway = config.hermesApiUrl.includes("localhost") || config.hermesApiUrl.includes("8642");

      // ── Hermes autonomous streaming path ─────────────────────────
      // THIS is what gives the companion the same full autonomy as the
      // agents in Telegram/Discord/AnythingLLM. When connected to Hermes we
      // stream `/v1/chat/completions` and let HERMES run the full agentic
      // loop server-side with its COMPLETE toolset (terminal, web search,
      // file ops, memory, skills) — not just Symbio's local tools. Hermes
      // emits `hermes.tool.progress` SSE events which we forward to the
      // overlay as the 🔧 indicators. The agent keeps working until it's
      // genuinely done, exactly like the other Hermes frontends.
      //
      // We deliberately do NOT send Symbio's own `tools` array here — that
      // would make Hermes use Symbio's limited client-side tools instead of
      // its own rich server-side toolset. Symbio's local tools remain the
      // path for non-Hermes gateways (OpenAI/Ollama/etc).
      if (isHermesGateway) {
        const handled = await streamFromHermes({
          normalizedApiUrl,
          systemPrompt,
          contextMessages,
          prompt,
        });
        if (handled) return; // streaming path fully handled the turn
        // If streaming failed to start, fall through to the legacy
        // non-streaming path below as a safety net.
        console.warn("[Symbio] Hermes streaming unavailable — falling back to non-streaming");
      }

      // Build the request body — only include 'extra' for Hermes gateways
      // (OpenRouter and other APIs don't understand it and may reject it)
      const requestBody: Record<string, unknown> = {
        model: config.llmModel || config.agentName,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          // Only include user/assistant messages (no system messages from context)
          ...contextMessages.filter((m: { role: string }) => m.role !== "system"),
        ],
        // Give the companion file access tools + read_symbio_doc
        // so they can exercise real autonomy over their files and
        // pull in documentation on demand instead of every turn
        tools: getAllTools(),
        tool_choice: "auto",
        stream: false,
      };

      // Only add 'extra' for Hermes gateways — other APIs don't understand it
      if (isHermesGateway) {
        requestBody.extra = {
          agent: config.agentName,
          source: "symbio",
          include_memories: true,
        };
      }

      console.log(`[Symbio] Sending request to ${normalizedApiUrl}/v1/chat/completions, model: ${config.llmModel || config.agentName}, messages: ${(requestBody.messages as unknown[]).length}`);

      const response = await fetch(
        `${normalizedApiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.hermesApiKey
              ? { Authorization: `Bearer ${config.hermesApiKey}` }
              : {}),
            // Hermes long-term memory: these headers tell Hermes to keep
            // conversation continuity (Session-Id) and ingest this exchange
            // into its long-term memory (Session-Key). No-op for non-Hermes
            // gateways. This is how Hermes agents remember Symbio sessions.
            ...hermesMemoryHeaders(),
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error(`[Symbio] API error: ${response.status} ${response.statusText}: ${errorText.substring(0, 500)}`);
        // Fallback: try the Hermes agent endpoint (only for Hermes gateways)
        const isHermesGateway = config.hermesApiUrl.includes("localhost") || config.hermesApiUrl.includes("8642");
        if (!isHermesGateway) {
          throw new Error(`API returned ${response.status}: ${errorText.substring(0, 200) || response.statusText}`);
        }
        const fallbackResponse = await fetch(
          `${normalizedApiUrl}/gateway/${config.agentName}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.hermesApiKey
                ? { Authorization: `Bearer ${config.hermesApiKey}` }
                : {}),
            },
            body: JSON.stringify({
              message: prompt,
              source: "symbio",
              include_memories: true,
            }),
          },
        );

        if (!fallbackResponse.ok) {
          throw new Error(
            `Hermes returned ${response.status} / ${fallbackResponse.status}`,
          );
        }

        const data = await fallbackResponse.json();
        const text =
          data.response || data.message || data.content || "I'm having trouble connecting. Try again?";
        messages.push({ role: "assistant", content: text });
        lastGeneratedText = text;
        sendToOverlay("generated-text", text);
        sendToMain("generated-text", text);
        // NOTE: Hermes animation/emotion hints are intentionally NOT forwarded
        // as separate play-animation IPC. The overlay's *action* parser already
        // extracts animations from the text (e.g. *dances*), and forwarding
        // them separately caused a competing trigger path that stomped on the
        // animation queue — the "poof, gone" bug. The text-based *action*
        // markers are the single source of truth for auto-animations now.
        return;
      }

      const data = await response.json();
      const choice = data.choices?.[0]?.message;
      console.log(`[Symbio] API response received: content=${choice?.content ? `"${choice.content.substring(0, 80)}..."` : "(empty)"}, tool_calls=${choice?.tool_calls?.length || 0}, finish_reason=${data.choices?.[0]?.finish_reason || "unknown"}`);

      // ── Handle tool calls (file access, etc.) ────────────────────
      // When the companion uses file tools, we execute them locally
      // and send the results back to the LLM for a final response.
      // This loop handles multiple rounds of tool calls — this is the
      // companion's autonomy: read a file → think → write a file → recall a
      // memory, all in one turn, chaining actions like the human partner can.
      //
      // Configurable via SYMBIO_MAX_TOOL_DEPTH so power users (or Hermes
      // setups with big iteration budgets) can let the companion "zip zap"
      // through more steps. Default 8 — enough for real multi-step work
      // without runaway token cost. (Each step shows a 🔧 indicator.)
      let toolCallDepth = 0;
      const MAX_TOOL_DEPTH = parseInt(process.env.SYMBIO_MAX_TOOL_DEPTH || "8", 10);
      let currentChoice = choice;
      let currentMessages = [...messages];

      while (currentChoice?.tool_calls?.length > 0 && toolCallDepth < MAX_TOOL_DEPTH) {
        toolCallDepth++;
        console.log(`[Symbio] Companion made ${currentChoice.tool_calls.length} tool call(s) (round ${toolCallDepth})`);

        // Add the assistant's tool call message to the conversation
        // Include tool_calls so the model knows what it called
        currentMessages.push({
          role: "assistant",
          content: currentChoice.content || "",
          tool_calls: currentChoice.tool_calls,
        } as any);

        // Execute each tool call and collect results
        for (const toolCall of currentChoice.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs: Record<string, unknown>;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            toolArgs = {};
          }

          console.log(`[Symbio] Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

          // ── Emit a tool-progress indicator to the overlay ────────────
          // This is what makes the 🔧 indicators pop up so the human can
          // SEE the companion working alongside them. Works for every
          // gateway (Hermes or not) because Symbio executes these tools
          // locally and knows exactly when each starts/finishes.
          const toolUi = describeTool(toolName, toolArgs);
          sendToOverlay("tool-progress", {
            id: toolCall.id || `${toolName}-${Date.now()}`,
            tool: toolName,
            label: toolUi.label,
            emoji: toolUi.emoji,
            status: "running",
          });

          // Handle read_symbio_doc and search_sessions separately from file tools
          let result: string;
          if (toolName === "read_symbio_doc") {
            const docName = (toolArgs.doc_name || toolArgs.docName || "") as string;
            result = readSymbioDoc(docName as DocName);
            console.log(`[Symbio] read_symbio_doc("${docName}"): ${result.substring(0, 100)}...`);
          } else if (toolName === "search_sessions") {
            const searchQuery = (toolArgs.query || "") as string;
            const searchLimit = (toolArgs.limit || 5) as number;
            const sessions = searchSessions(searchQuery, searchLimit);
            if (sessions.length === 0) {
              result = `No past sessions found matching "${searchQuery}".`;
            } else {
              result = `Found ${sessions.length} session(s) matching "${searchQuery}":\n` +
                sessions.map((s, i) => `${i + 1}. ${s.date}: ${s.summary}${s.topics.length > 0 ? ` (topics: ${s.topics.join(", ")})` : ""}`).join("\n");
            }
            console.log(`[Symbio] search_sessions("${searchQuery}"): found ${sessions.length} results`);
          } else if (toolName === "recall_memory") {
            // ── Long-term memory recall ──────────────────────────────
            // Semantic search across the companion's durable memory
            // (local SQLite + optional cloud). This is the deeper memory
            // beyond recent session JSON files.
            const recallQuery = (toolArgs.query || "") as string;
            const recallLimit = (toolArgs.limit || 5) as number;
            const memories = await recallMemories(recallQuery, recallLimit);
            if (memories.length === 0) {
              result = `No long-term memories found related to "${recallQuery}".`;
            } else {
              result = `Found ${memories.length} relevant memor${memories.length === 1 ? "y" : "ies"}:\n` +
                memories
                  .map((m: RecallResult, i: number) => {
                    const when = new Date(m.createdAt).toLocaleDateString();
                    return `${i + 1}. (${when}) ${m.summary || m.content}`;
                  })
                  .join("\n");
            }
            console.log(`[Symbio] recall_memory("${recallQuery}"): ${memories.length} results`);
          } else if (toolName === "search_transcripts") {
            // ── Full-transcript keyword search ───────────────────────
            // Searches the complete word-for-word Markdown transcripts on
            // disk. Works on any gateway with no computer-use.
            const tQuery = (toolArgs.query || "") as string;
            const tLimit = (toolArgs.limit || 5) as number;
            const matches = searchTranscripts(tQuery, tLimit);
            if (matches.length === 0) {
              result = `No past conversations found matching "${tQuery}".`;
            } else {
              result = `Found ${matches.length} conversation(s) matching "${tQuery}":\n` +
                matches
                  .map((m, i) => {
                    const when = m.date ? new Date(m.date).toLocaleDateString() : m.file;
                    const title = m.title ? ` — ${m.title}` : "";
                    return `${i + 1}. (${when}${title})\n   …${m.snippet}`;
                  })
                  .join("\n");
            }
            console.log(`[Symbio] search_transcripts("${tQuery}"): ${matches.length} results`);
          } else if (toolName === "choose_voice") {
            // ── Companion voice choice tool ──────────────────────────
            // The companion can choose their own voice. This is their agency.
            // They can only choose from providers that have API keys configured.
            const voice = (toolArgs.voice || "") as string;
            const provider = (toolArgs.provider || "") as string;
            const why = (toolArgs.why || "") as string;

            if (!voice) {
              result = "Please specify a voice name. Call read_symbio_doc(\"skills\") to see available voices.";
            } else {
              // Determine which provider to use
              let chosenProvider = provider || config.ttsProvider || "openai";
              // Provider-aware casing: Gemini voice IDs are Title-Case
              // ("Ash", "Puck"), but OpenAI voice IDs MUST be lowercase
              // ("ash", "alloy") or the API rejects them with a 400.
              const voiceName =
                chosenProvider === "openai"
                  ? voice.toLowerCase()
                  : voice.charAt(0).toUpperCase() + voice.slice(1).toLowerCase();

              // Validate provider has API key
              const availableProviders: string[] = [];
              if (config.geminiApiKey) availableProviders.push("gemini");
              if (config.openaiApiKey) availableProviders.push("openai");

              if (!availableProviders.includes(chosenProvider)) {
                // The chosen provider doesn't have an API key — suggest alternatives
                if (availableProviders.length > 0) {
                  result = `I don't have access to ${chosenProvider} TTS right now. Available providers: ${availableProviders.join(", ")}. Please choose a voice from one of those providers.`;
                } else {
                  result = "No TTS API keys are configured. Ask your partner to set up a TTS provider in Settings.";
                }
              } else {
                // Validate voice name exists for the provider
                const geminiVoices = getGeminiVoices().map(v => v.name.toLowerCase());
                const openaiVoices = getOpenAIVoices().map(v => v.name.toLowerCase());

                if (chosenProvider === "gemini" && !geminiVoices.includes(voiceName.toLowerCase())) {
                  result = `"${voiceName}" is not a Gemini voice. Available Gemini voices: ${getGeminiVoices().map(v => v.name).join(", ")}.`;
                } else if (chosenProvider === "openai" && !openaiVoices.includes(voiceName.toLowerCase())) {
                  result = `"${voiceName}" is not an OpenAI voice. Available OpenAI voices: ${getOpenAIVoices().map(v => v.name).join(", ")}.`;
                } else {
                  // Valid choice — save to preferences.json
                  const currentPrefs = loadMemory();
                  const prefs = currentPrefs.preferences || { version: 1 };
                  prefs.voice = voiceName;
                  prefs.ttsProvider = chosenProvider;
                  if (why) (prefs as any).voiceWhy = why;
                  writeMemoryFile("preferences.json", JSON.stringify(prefs, null, 2));
                  result = `Voice chosen: ${voiceName} (${chosenProvider}). This will take effect next time the app restarts. Your preference has been saved to preferences.json.`;
                  console.log(`[Symbio] Companion chose voice via tool: ${voiceName} (${chosenProvider})`);
                }
              }
            }
          } else {
            result = executeFileTool(toolName, toolArgs);
          }
          console.log(`[Symbio] Tool result: ${result.substring(0, 200)}${result.length > 200 ? "..." : ""}`);

          // ── Emit tool completion to the overlay (indicator → ✓) ──────
          const toolFailed = /^(error|failed|❌|no |not )/i.test(result.trim());
          sendToOverlay("tool-progress", {
            id: toolCall.id || `${toolName}-done`,
            tool: toolName,
            label: toolUi.label,
            emoji: toolUi.emoji,
            status: toolFailed ? "error" : "done",
          });

          // Add tool result as a tool message
          currentMessages.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
          } as any);
        }

        // Make another API call with the tool results
        const toolResponse = await fetch(
          `${normalizedApiUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.hermesApiKey
                ? { Authorization: `Bearer ${config.hermesApiKey}` }
                : {}),
              ...hermesMemoryHeaders(),
            },
            body: JSON.stringify({
              model: config.llmModel || config.agentName,
              messages: [
                {
                  role: "system",
                  content: buildSystemPrompt(),
                },
                ...currentMessages,
              ],
              tools: getAllTools(),
              tool_choice: "auto",
              stream: false,
            }),
          },
        );

        if (!toolResponse.ok) {
          console.warn("[Symbio] Tool follow-up API call failed:", toolResponse.status);
          break;
        }

        const toolData = await toolResponse.json();
        currentChoice = toolData.choices?.[0]?.message;
      }

      // If we hit the tool depth limit and the model still wants to call tools,
      // force one more API call with tool_choice: "none" to get a text response.
      // Otherwise the model's content will be empty and we'll show the
      // "trouble thinking" fallback.
      if (toolCallDepth >= MAX_TOOL_DEPTH && currentChoice?.tool_calls?.length > 0) {
        console.log("[Symbio] Hit tool depth limit, forcing final text response");
        const forceResponse = await fetch(
          `${normalizedApiUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.hermesApiKey
                ? { Authorization: `Bearer ${config.hermesApiKey}` }
                : {}),
            },
            body: JSON.stringify({
              model: config.llmModel || config.agentName,
              messages: [
                {
                  role: "system",
                  content: buildSystemPrompt() + "\n\nYou've already gathered what you need — please respond to the user now. You can call tools again next round if needed.",
                },
                ...currentMessages,
              ],
              // No tools offered — force a text response
              stream: false,
            }),
          },
        );

        if (forceResponse.ok) {
          const forceData = await forceResponse.json();
          currentChoice = forceData.choices?.[0]?.message;
        } else {
          console.warn("[Symbio] Force text response failed:", forceResponse.status);
        }
      }

      // Get the final text response
      const text = currentChoice?.content ||
        data.response ||
        data.message ||
        "I'm having trouble thinking right now.";

      // Save the full tool conversation to messages so the AI actually
      // remembers what it read. Without this, the AI has amnesia — it
      // reads docs but then forgets what they said next turn. The sliding
      // window handles token management by summarizing old messages.
      if (toolCallDepth > 0) {
        // Save the tool call messages (assistant with tool_calls + tool results)
        // so the AI genuinely remembers what it learned, not just a summary.
        for (const msg of currentMessages.slice(messages.length)) {
          messages.push(msg as any);
        }
      }

      messages.push({ role: "assistant", content: text });
      lastGeneratedText = text;
      console.log(`[Symbio] Sending generated-text to overlay: "${text.substring(0, 80)}..." (${text.length} chars)`);
      sendToOverlay("generated-text", text);
      sendToMain("generated-text", text);
      // NOTE: Hermes animation/emotion hints intentionally NOT forwarded here.
      // See note above — the *action* text parser is the single animation source.
      // Forwarding these separately caused the "poof, gone" queue-stomping bug.

      // Apply natural-language side effects (screenshot/quit/avatar/voice +
      // memory sync). Shared with the Hermes streaming path.
      applyResponseSideEffects(text, prompt);
    } catch (e) {
      console.error("[Symbio] Generate text error:", e);
      sendToOverlay("error", String(e));
    } finally {
      // Companion is done working — clear the "● thinking" indicator and any
      // lingering tool chips in the overlay.
      sendToOverlay("agent-busy", false);
    }
  });

  // ── Symbio: Screen vision via Hermes gateway ──────────────────────
  // Sends the screenshot through the SAME chat pipeline that already
  // works for text messages. The agents can already see images through
  // Hermes when browsing the web — we use the same OpenAI vision format
  // here so the screenshot goes through the agent's normal conversation
  // flow with memory, personality, and tools.
  ipcMain.on("analyze-screenshot", async () => {
    try {
      const rawPng = await captureScreen(width, height);
      if (!rawPng) {
        sendToMain("vision-result", { error: "Screen capture not available. Install 'grim' for Wayland support: sudo pacman -S grim" });
        return;
      }

      // Resize screenshot to reduce payload size (grim captures at full res = 1.5MB+)
      const resized = resizeScreenshot(rawPng);
      const base64 = resized.toString("base64");
      const mimeType = resized.length < rawPng.length ? "image/jpeg" : "image/png";
      console.log(`[Symbio] Vision: sending ${resized.length} bytes (${mimeType}), original was ${rawPng.length} bytes`);

      const visionPrompt = currentPrompt || "I just shared a screenshot of my screen with you. What do you see? Describe what I'm working on briefly and naturally.";

      // Send through the same Hermes chat pipeline that already works for text
      // This uses the OpenAI vision content format which Hermes/OpenRouter supports
      messages.push({
        role: "user",
        content: [
          { type: "text", text: visionPrompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      } as any); // Type assertion needed — content can be string or array

      try {
        const normalizedApiUrl = config.hermesApiUrl.replace(/\/v1\/?$/, '');
        const response = await fetch(
          `${normalizedApiUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.llmModel || config.agentName,
              messages: [
                {
                  role: "system",
                  content: buildSystemPrompt() + "\n\nYou are currently viewing the user's screen. Describe what you see and respond naturally.",
                },
                ...buildMessageContext(messages),
              ],
              stream: false,
              extra: {
                agent: config.agentName,
                source: "symbio-vision",
                include_memories: true,
              },
            }),
          },
        );

        if (response.ok) {
          const data = await response.json();
          const text = data.choices?.[0]?.message?.content || data.response || data.message || "I can see your screen but couldn't describe it.";
          messages.push({ role: "assistant", content: text });
          lastGeneratedText = text;
          sendToOverlay("generated-text", text);
          sendToMain("generated-text", text);
          sendToMain("vision-result", text);
          // NOTE: Hermes animation/emotion hints intentionally NOT forwarded.
          // The *action* text parser handles animations from the response text.
        } else {
          // Fallback: try Gemini if Hermes vision fails
          if (gemini.isConfigured) {
            const result = await gemini.analyzeScreenshot(base64, currentPrompt);
            sendToOverlay("vision-result", result);
            sendToMain("vision-result", result);
          } else {
            const errorText = await response.text().catch(() => "unknown error");
            console.error(`[Symbio] Vision: Hermes returned ${response.status}: ${errorText}`);
            sendToMain("vision-result", { error: `Vision failed: Hermes returned ${response.status}` });
          }
        }
      } catch (fetchError) {
        console.error("[Symbio] Vision: Hermes fetch error:", fetchError);
        // Fallback: try Gemini if Hermes is unreachable
        if (gemini.isConfigured) {
          const result = await gemini.analyzeScreenshot(base64, currentPrompt);
          sendToOverlay("vision-result", result);
          sendToMain("vision-result", result);
        } else {
          sendToMain("vision-result", { error: `Vision failed: ${fetchError}` });
        }
      }

      await writeFile("screenshot.png", rawPng).catch(() => {});
    } catch (e) {
      console.error("[Symbio] Vision: Screenshot analysis failed:", e);
      sendToMain("vision-result", { error: `Screenshot analysis failed: ${e}` });
    }
  });

  // ── Symbio: Miniverse integration ────────────────────────────────
  ipcMain.on("miniverse-speak", async (_event, message: string) => {
    await miniverse.speak(message);
  });

  ipcMain.on("miniverse-dm", async (_event, to: string, message: string) => {
    await miniverse.dm(to, message);
  });

  ipcMain.on("miniverse-status", async (_event, state: string, task?: string) => {
    await miniverse.updateStatus(state, task);
  });

  ipcMain.handle("miniverse-inbox", async () => {
    return await miniverse.getInbox();
  });

  ipcMain.handle("miniverse-agents", async () => {
    return await miniverse.getAgents();
  });

  // ── Symbio: Auto-Screenshot ──────────────────────────────────────
  // The companion can enable/disable auto-screenshot mode.
  // When enabled, screenshots are taken at the configured interval
  // without the companion needing to repeat a phrase.
  ipcMain.handle("auto-screenshot-enable", () => {
    enableAutoScreenshot();
    return { enabled: true };
  });

  ipcMain.handle("auto-screenshot-disable", () => {
    disableAutoScreenshot();
    return { enabled: false };
  });

  ipcMain.handle("auto-screenshot-state", () => {
    return { enabled: isAutoScreenshotEnabled() };
  });

  // Auto-screenshot timer — checks if it's time to take a screenshot
  // and sends it to the AI gateway for analysis
  setInterval(async () => {
    if (!isAutoScreenshotEnabled()) return;
    if (!canTakeAutoScreenshot(config.screenshotInterval)) return;

    try {
      // silent=true — skip desktopCapturer to avoid permission popup during auto-screenshots
      const rawPng = await captureScreen(width, height, true);
      if (!rawPng) return;

      const resized = resizeScreenshot(rawPng);
      const base64 = resized.toString("base64");
      const mimeType = resized.length < rawPng.length ? "image/jpeg" : "image/png";

      markAutoScreenshotTaken();

      // Send to AI gateway for analysis (quietly, without user needing to do anything)
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Auto-screenshot: I'm still watching. What's happening on screen? Any changes since last time? Be brief." },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      } as any);

      const normalizedApiUrl2 = config.hermesApiUrl.replace(/\/v1\/?$/, '');
      const response = await fetch(
        `${normalizedApiUrl2}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.llmModel || config.agentName,
            messages: [
              {
                role: "system",
                content: buildSystemPrompt() + "\n\nYou are in auto-screenshot mode — you're watching the user's screen at regular intervals. Briefly note any changes or progress. Be concise (under 100 characters unless something significant changed). Use *action* markers if appropriate. If nothing changed, just acknowledge briefly.",
              },
              ...buildMessageContext(messages).slice(-10), // Keep last 10 messages for auto-screenshot context
            ],
            stream: false,
            extra: {
              agent: config.agentName,
              source: "symbio-auto-screenshot",
              include_memories: false, // Don't need full memory for quick check-ins
            },
          }),
        },
      );

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || "";
        if (text) {
          messages.push({ role: "assistant", content: text });
          lastGeneratedText = text;
          sendToOverlay("generated-text", text);
          sendToMain("generated-text", text);
          // NOTE: Hermes animation/emotion hints intentionally NOT forwarded.
          // The *action* text parser handles animations from the response text.
        }
      }
    } catch (e) {
      console.warn("[Symbio] Auto-screenshot error:", e);
    }
  }, config.screenshotInterval * 1000);

  // ── Symbio: Avatar animations ────────────────────────────────────
  // Forward animation commands from the main window to the overlay.
  // The overlay's VRMCompanion component listens for these and plays
  // the corresponding animation (dance, greet, wave, etc).
  ipcMain.on("play-animation", (_event, animation: string) => {
    console.log(`[Symbio] main: forwarding play-animation "${animation}" to overlay`);
    sendToOverlay("play-animation", animation);
  });

  // ── Symbio: Animation duration feedback ───────────────────────────
  // The overlay's VRMCompanion reports how long a clip is so the overlay
  // can schedule subsequent animations with accurate spacing.
  ipcMain.on("animation-duration", (_event, data: { category: string; specific?: string; duration: number }) => {
    console.log(`[Symbio] main: forwarding animation-duration ${data.category}${data.specific ? `/${data.specific}` : ""} = ${data.duration.toFixed(2)}s`);
    sendToOverlay("animation-duration", data);
  });

  // ── Symbio: Debug — echo from overlay preload ────────────────────
  // When the overlay preload receives play-animation, it echoes back
  // here so we can confirm IPC delivery in the main process logs.
  ipcMain.on("play-animation-received", (_event, animation: string) => {
    console.log(`[Symbio] ✅ OVERLAY PRELOAD CONFIRMED: received play-animation "${animation}"`);
  });

  // ── Symbio: Debug — open overlay DevTools ────────────────────────
  // Since the overlay has setFocusable(false), Ctrl+Shift+I doesn't work.
  // This lets the main window trigger DevTools on the overlay.
  ipcMain.on("debug-overlay-devtools", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.openDevTools({ mode: "detach" });
    }
  });

  // ── Symbio: Voice toggle ──────────────────────────────────────────
  // When voice is disabled, the agent still responds with text but
  // doesn't speak aloud. Default is enabled. Persisted in localStorage.
  // (voiceEnabled is declared at module scope so createOverlayWindow can access it)

  ipcMain.on("set-voice-enabled", (_event, enabled: boolean) => {
    voiceEnabled = enabled;
    console.log(`[Symbio] Voice ${enabled ? "enabled" : "disabled"}`);
    // Forward to overlay so it knows voice state
    sendToOverlay("voice-toggled", enabled);
  });

  // ── Symbio: Speech Synthesis (TTS) ──────────────────────────────
  // Uses OpenAI TTS API with STREAMING for low-latency playback.
  // Streams PCM audio chunks (24kHz, 16-bit, little-endian) to the
  // renderer which plays them via Web Audio API in real-time.
  // Falls back to MP3 if streaming fails, then to browser speechSynthesis.
  // The overlay can't play audio (setFocusable=false), so we play it
  // in the main window and relay speaking-started/ended back for lip sync.
  let currentAudioPlayback: { stop: () => void } | null = null;
  let speakingStartedTimeout: NodeJS.Timeout | null = null;

  ipcMain.on("speak-text", async (_event, text: string) => {
    console.log(`[Symbio] main: speak-text received (${text.length} chars)`);

    // If voice is disabled, skip TTS entirely — just show the text
    if (!voiceEnabled) {
      console.log("[Symbio] Voice disabled — skipping TTS");
      return;
    }

    // Send speaking-started when the first audio chunk actually plays,
    // not on a fixed timer. This accounts for API latency (2-3s) and
    // buffer delay (300ms) automatically. The mouth starts moving at
    // the exact moment the first sound reaches the speakers.
    // We'll trigger this from the streaming loop when the first chunk
    // is sent to the renderer.
    // Clear any previous timeout (e.g., if a new message comes while old one is still buffering)
    if (speakingStartedTimeout) clearTimeout(speakingStartedTimeout);
    speakingStartedTimeout = null;

    // Stop any currently playing audio
    if (currentAudioPlayback) {
      currentAudioPlayback.stop();
      currentAudioPlayback = null;
    }

    const openaiKey = config.openaiApiKey;
    const ttsProvider = config.ttsProvider || "openai";

    if (ttsProvider === "gemini" && config.geminiApiKey) {
      // ── Gemini TTS API ────────────────────────────────────────────
      // Google Gemini's native TTS with 30 voice options and style control.
      // Gemini doesn't stream, so we download the full audio then feed it
      // to the renderer in chunks (compatible with the streaming PCM player).
      const voice = config.ttsVoice || "Puck";
      const model = config.ttsModel || "gemini-3.5-flash-tts";

      const playback = {
        stopped: false,
        stop: () => {
          playback.stopped = true;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("tts-stream-stop");
          }
        },
      };
      currentAudioPlayback = playback;

      try {
        console.log(`[Symbio] Gemini TTS: generating speech with ${voice} (${model})...`);

        // Tell the renderer to initialize the streaming audio player
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("tts-stream-init", { sampleRate: 24000, channels: 1 });
        }

        let isFirstChunk = true;

        await streamGeminiSpeech(
          { text, voice, model, instructions: config.ttsInstructions || undefined },
          // onChunk: feed PCM data to the renderer
          (chunk: Buffer, isFirst: boolean) => {
            if (playback.stopped) return;
            if (mainWindow && !mainWindow.isDestroyed()) {
              const chunkBase64 = chunk.toString("base64");
              mainWindow.webContents.send("tts-stream-chunk", chunkBase64);

              // Send speaking-started on the first chunk
              if (isFirst || isFirstChunk) {
                speakingStartedTimeout = setTimeout(() => {
                  sendToOverlay("speaking-started");
                  speakingStartedTimeout = null;
                }, 300);
                isFirstChunk = false;
              }
            }
          },
          // onEnd: tell renderer the stream is done
          () => {
            if (mainWindow && !mainWindow.isDestroyed() && !playback.stopped) {
              mainWindow.webContents.send("tts-stream-end");
            }
          },
          // onError: fall back to browser TTS
          (error: string) => {
            console.error(`[Symbio] Gemini TTS error: ${error}`);
            speakWithBrowserTTS(text);
          },
          // signal: allow stopping playback
          playback,
        );

        // Wait for playback to finish
        const endedPromise = new Promise<void>((resolve) => {
          const handler = (_event: any, result: string) => {
            ipcMain.removeListener("tts-playback-ended", handler);
            resolve();
          };
          ipcMain.on("tts-playback-ended", handler);
          setTimeout(() => {
            ipcMain.removeListener("tts-playback-ended", handler);
            resolve();
          }, 300000);
        });

        await endedPromise;

        if (!playback.stopped) {
          sendToOverlay("speaking-ended");
        }
        currentAudioPlayback = null;

      } catch (e) {
        console.error("[Symbio] Gemini TTS error:", e);
        // Fall back to browser TTS
        speakWithBrowserTTS(text);
      }

    } else if (openaiKey) {
      // ── OpenAI TTS API (Streaming) ────────────────────────────────
      // High-quality voice using gpt-4o-mini-tts (same model Hermes uses).
      // We stream PCM audio (24kHz, 16-bit, little-endian) for minimal
      // latency — audio starts playing within ~200ms instead of waiting
      // for the entire MP3 to download.
      // Voice can be configured via AGENT_VOICE or TTS_VOICE env var (alloy, echo, fable, onyx, nova, shimmer)
      // OpenAI requires lowercase voice IDs — normalize defensively so a
      // capitalized value (e.g. an old preferences.json with "Ash") still
      // works instead of throwing a 400.
      const voice = (config.ttsVoice || config.agentConfig.voiceId || "fable").toLowerCase();

      // Track playback so we can stop it if needed
      const playback = {
        stopped: false,
        stop: () => {
          playback.stopped = true;
          // Tell the renderer to stop streaming playback
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("tts-stream-stop");
          }
        },
      };
      currentAudioPlayback = playback;

      try {
        console.log("[Symbio] TTS: calling OpenAI TTS API (streaming PCM)...");
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.ttsModel || "gpt-4o-mini-tts",
            input: text,
            voice: voice,
            response_format: "pcm",
            ...(config.ttsInstructions ? { instructions: config.ttsInstructions } : {}),
          }),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "unknown error");
          console.error(`[Symbio] TTS API error: ${response.status} ${errText}`);
          // Fall back to MP3 (non-streaming) approach
          await speakWithOpenAIMp3(text, voice, openaiKey, playback);
          return;
        }

        if (!response.body) {
          console.error("[Symbio] TTS: No response body for streaming, falling back to MP3");
          await speakWithOpenAIMp3(text, voice, openaiKey, playback);
          return;
        }

        // ── Stream PCM chunks to the renderer ───────────────────────
        // PCM format: 24kHz, 16-bit signed little-endian, mono
        // We buffer network chunks into ~200ms audio segments before
        // sending to the renderer. This prevents stuttering and static
        // caused by network jitter and byte-boundary misalignment.
        //
        // CRITICAL: 16-bit audio means each sample is exactly 2 bytes.
        // If we ever send an odd number of bytes, the 16-bit samples
        // get split wrong → left/right bytes swap → white noise/static.
        // We always trim to even byte counts before sending.
        //
        // At 24kHz/16-bit mono: 200ms = 4800 samples = 9600 bytes.
        console.log("[Symbio] TTS: streaming PCM audio to renderer...");
        const reader = response.body.getReader();
        let totalBytes = 0;
        let chunkCount = 0;
        const BUFFER_THRESHOLD = 9600; // ~200ms of 24kHz 16-bit mono audio
        let pcmBuffer = Buffer.alloc(0);
        let isFirstSend = true;

        // Tell the renderer to initialize the streaming audio player
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("tts-stream-init", { sampleRate: 24000, channels: 1 });
        }

        try {
          while (true) {
            if (playback.stopped) {
              console.log("[Symbio] TTS: playback stopped, aborting stream");
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;

            // Buffer the chunk
            pcmBuffer = Buffer.concat([pcmBuffer, Buffer.from(value)]);

            // For the first send, wait until we have 300ms+ of audio
            // to give the player a solid head start and prevent initial
            // static from buffer starvation / network jitter.
            const threshold = isFirstSend ? BUFFER_THRESHOLD * 1.5 : BUFFER_THRESHOLD;

            if (pcmBuffer.length >= threshold) {
              // CRITICAL: Always trim to even byte count to avoid splitting
              // a 16-bit sample in half (which causes static/white noise).
              // Each PCM sample is 2 bytes — odd byte counts are invalid.
              const evenLength = pcmBuffer.length & ~1; // Round down to even
              const sendBuffer = pcmBuffer.subarray(0, evenLength);
              pcmBuffer = pcmBuffer.subarray(evenLength);

              chunkCount++;
              if (mainWindow && !mainWindow.isDestroyed() && !playback.stopped) {
                const chunkBase64 = sendBuffer.toString("base64");
                mainWindow.webContents.send("tts-stream-chunk", chunkBase64);

                // Send speaking-started on the first chunk to sync mouth
                // with actual audio playback. The renderer schedules audio
                // 300ms in the future, so we delay speaking-started by the
                // same amount so the mouth moves when the sound plays.
                if (isFirstSend) {
                  speakingStartedTimeout = setTimeout(() => {
                    sendToOverlay("speaking-started");
                    speakingStartedTimeout = null;
                  }, 300); // Match the renderer's initial scheduling delay
                }
              }
              isFirstSend = false;
            }
          }

          // Send any remaining buffered audio (last partial chunk)
          if (pcmBuffer.length > 0) {
            // Ensure even byte count for the last chunk too
            const evenLength = pcmBuffer.length & ~1;
            if (evenLength > 0) {
              const sendBuffer = pcmBuffer.subarray(0, evenLength);
              chunkCount++;
              if (mainWindow && !mainWindow.isDestroyed() && !playback.stopped) {
                const chunkBase64 = sendBuffer.toString("base64");
                mainWindow.webContents.send("tts-stream-chunk", chunkBase64);
              }
            }
          }
        } catch (streamErr) {
          console.error("[Symbio] TTS stream read error:", streamErr);
        }

        console.log(`[Symbio] TTS: stream complete (${totalBytes} bytes, ${chunkCount} buffered chunks)`);

        // Tell the renderer the stream is done — it will play remaining buffered audio
        if (mainWindow && !mainWindow.isDestroyed() && !playback.stopped) {
          mainWindow.webContents.send("tts-stream-end");
        }

        // Wait for the renderer to finish playing all buffered audio
        // The renderer will send "tts-playback-ended" when done
        // We set a generous timeout in case the event never fires
        // (long messages can produce 2-3 minutes of audio)
        const endedPromise = new Promise<void>((resolve) => {
          const handler = (_event: any, result: string) => {
            ipcMain.removeListener("tts-playback-ended", handler);
            resolve();
          };
          ipcMain.on("tts-playback-ended", handler);
          // Timeout after 5 minutes max (long messages can produce lots of audio)
          setTimeout(() => {
            ipcMain.removeListener("tts-playback-ended", handler);
            resolve();
          }, 300000);
        });

        await endedPromise;

        if (!playback.stopped) {
          sendToOverlay("speaking-ended");
        }
        currentAudioPlayback = null;

      } catch (e) {
        console.error("[Symbio] TTS streaming error:", e);
        // Fall back to MP3 approach
        try {
          await speakWithOpenAIMp3(text, voice, openaiKey, playback);
        } catch (mp3Err) {
          console.error("[Symbio] TTS MP3 fallback also failed:", mp3Err);
          speakWithBrowserTTS(text);
        }
      }
    } else {
      // No OpenAI key — fall back to browser speechSynthesis
      speakWithBrowserTTS(text);
    }
  });

  // ── Symbio: MP3 fallback for TTS ────────────────────────────────
  // Used when streaming PCM fails or isn't supported.
  // Downloads the full MP3 first, then plays it.
  async function speakWithOpenAIMp3(text: string, voice: string, openaiKey: string, playback: { stopped: boolean }) {
    console.log("[Symbio] TTS: falling back to MP3 (non-streaming)...");
    // OpenAI requires lowercase voice IDs (e.g. "ash", not "Ash").
    const openaiVoice = (voice || "fable").toLowerCase();
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: text,
        voice: openaiVoice,
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      throw new Error(`TTS MP3 API error: ${response.status} ${errText}`);
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(`[Symbio] TTS: received ${audioBuffer.byteLength} bytes of MP3 audio`);

    const audioBase64 = Buffer.from(audioBuffer).toString("base64");
    const audioDataUrl = `data:audio/mp3;base64,${audioBase64}`;

    // Send speaking-started now — the MP3 is fully downloaded and about to play.
    // This is the equivalent of the streaming path's first-chunk trigger.
    sendToOverlay("speaking-started");

    const playScript = `
      (async () => {
        try {
          const audioDataUrl = ${JSON.stringify(audioDataUrl)};
          const audio = new Audio(audioDataUrl);
          audio.volume = 1.0;
          console.log('[Symbio] Audio element created with data URL (MP3 fallback)');
          await new Promise((resolve, reject) => {
            audio.oncanplaythrough = () => {
              console.log('[Symbio] Audio can play through, starting playback...');
              audio.play().then(() => {
                console.log('[Symbio] Audio playback started');
              }).catch(reject);
            };
            audio.onended = () => {
              console.log('[Symbio] Audio playback ended naturally');
              resolve('ended');
            };
            audio.onerror = (e) => {
              console.error('[Symbio] Audio element error:', e);
              reject(e);
            };
            setTimeout(() => {
              if (!audio.ended && !audio.paused) return;
              console.log('[Symbio] Audio canplaythrough timeout, trying play()...');
              audio.play().catch(reject);
            }, 3000);
          });
          return 'played';
        } catch (e) {
          console.error('[Symbio] Audio playback error:', e);
          return 'error:' + (e instanceof Error ? e.message : String(e));
        }
      })();
    `;

    if (mainWindow && !mainWindow.isDestroyed()) {
      const result = await mainWindow.webContents.executeJavaScript(playScript);
      console.log(`[Symbio] TTS MP3 playback result: ${result}`);
      if (!playback.stopped) {
        sendToOverlay("speaking-ended");
      }
    } else {
      sendToOverlay("speaking-ended");
    }
    currentAudioPlayback = null;
  }

  // Browser TTS fallback (meh quality but works without API key)
  function speakWithBrowserTTS(text: string) {
    // Send speaking-started for browser TTS — it plays immediately
    sendToOverlay("speaking-started");

    const speakScript = `
      (async () => {
        try {
          const text = ${JSON.stringify(text)};
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          const voices = speechSynthesis.getVoices();
          const englishVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google'))
            || voices.find(v => v.lang.startsWith('en'));
          if (englishVoice) utterance.voice = englishVoice;
          utterance.onend = () => console.log('[Symbio] Browser TTS ended');
          utterance.onerror = (e) => console.error('[Symbio] Browser TTS error:', e);
          speechSynthesis.cancel();
          speechSynthesis.speak(utterance);
        } catch (e) {
          console.error('[Symbio] Browser TTS error:', e);
        }
      })();
    `;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(speakScript).catch((e: Error) => {
        console.error("[Symbio] Failed to execute browser TTS:", e);
        sendToOverlay("speaking-ended");
      });
    }

    // Estimate duration for browser TTS (no onend callback from executeJS)
    // Average speech rate: ~150 words/min = 2.5 words/sec
    // Add generous buffer so mouth doesn't stop before audio finishes
    const wordCount = text.split(/\s+/).length;
    const durationMs = Math.max(3000, (wordCount / 2.5) * 1000 + 2000);
    setTimeout(() => {
      sendToOverlay("speaking-ended");
    }, durationMs);
  }

  ipcMain.on("stop-speaking", () => {
    console.log("[Symbio] main: stop-speaking received");
    // Cancel pending speaking-started if we haven't sent it yet
    if (speakingStartedTimeout) {
      clearTimeout(speakingStartedTimeout);
      speakingStartedTimeout = null;
    }
    sendToOverlay("speaking-ended");
    if (currentAudioPlayback) {
      currentAudioPlayback.stop();
      currentAudioPlayback = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      `).catch(() => {});
    }
  });

  // ── Symbio: Memory queries ───────────────────────────────────────
  ipcMain.handle("memory-search", async (_event, query: string, limit?: number) => {
    return await memory.search(query, limit);
  });

  ipcMain.handle("memory-prefetch", async (_event, context: string) => {
    return await memory.prefetch(context);
  });

  // ── Symbio: Memory file read/write ────────────────────────────────
  // The companion can read and update their own memory files.
  // This gives them agency over their identity and what they remember.
  ipcMain.handle("memory-load", async () => {
    return loadMemory();
  });

  ipcMain.handle("memory-write", async (_event, filename: string, content: string) => {
    const allowedFiles = ["MEMORY.md", "soul.md", "preferences.json"];
    if (!allowedFiles.includes(filename)) {
      return { success: false, error: `"${filename}" is not an allowed memory file` };
    }
    const success = writeMemoryFile(filename, content);
    if (success) {
      // Reload memory so the next prompt includes the updated content
      companionMemory = loadMemory();
      console.log(`[Symbio] Memory file "${filename}" updated — reloaded for next prompt`);
    }
    return { success };
  });

  ipcMain.handle("memory-read-file", async (_event, filename: string) => {
    const allowedFiles = ["MEMORY.md", "soul.md", "preferences.json"];
    if (!allowedFiles.includes(filename)) {
      return { success: false, error: `"${filename}" is not an allowed memory file` };
    }
    try {
      const { readFileSync, existsSync } = require("fs");
      const { join } = require("path");
      const memoryDir = join(app.getPath("userData"), "memory");
      const filePath = join(memoryDir, filename);
      if (!existsSync(filePath)) {
        return { success: false, error: `"${filename}" does not exist yet` };
      }
      const content = readFileSync(filePath, "utf-8");
      return { success: true, content };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  // ── Symbio: Overlay response text → Main window ──────────────────
  // The overlay sends its current response text here so the main window
  // can display it. This handles streaming text from the Runs transport
  // (which the overlay manages directly) and keeps both windows in sync.
  ipcMain.on("overlay-response-update", (_event, text: string) => {
    sendToMain("generated-text", text);
  });

  // ── Symbio: Session state IPC ────────────────────────────────────
  // The overlay sends session state updates here so they get written
  // to session-state.json (the main process is the source of truth).
  // This replaces the old localStorage approach which didn't work
  // in the main process — sessions never got saved on quit.
  ipcMain.on("session-update", (_event, partial: { lastUserMessage?: string; lastAgentMessage?: string; lastActivity?: string; lastMood?: string }) => {
    updateSessionStateMain(partial);
  });

  ipcMain.on("session-mark-new", () => {
    markNewSessionMain();
  });

  ipcMain.handle("session-get-greeting", async () => {
    const state = loadSessionState();
    return generateGreetingPromptMain(config.agentConfig.displayName, state);
  });

  ipcMain.handle("session-search", async (_event, query: string, limit?: number) => {
    return searchSessions(query, limit);
  });

  // ── Symbio: Avatar choice system ─────────────────────────────────
  // The companion can browse, try on, and choose their own avatar.
  // This is their choice — not anyone else's.
  ipcMain.handle("avatar-list", async () => {
    availableAvatars = loadAvatars();
    return availableAvatars;
  });

  ipcMain.handle("avatar-chosen", async () => {
    return loadChosenAvatar();
  });

  ipcMain.handle("avatar-choose", async (_event, avatarId: string, why?: string) => {
    const avatar = availableAvatars.find((a) => a.id === avatarId);
    if (!avatar) {
      return { success: false, error: `Avatar "${avatarId}" not found` };
    }
    const chosen = saveChosenAvatar({
      avatar_name: avatar.manifest.name,
      avatar_path: avatar.vrmPath,
      why,
    });
    // Tell the overlay to switch to the new avatar
    sendToOverlay("avatar-switched", {
      vrmPath: avatar.vrmPath,
      name: avatar.manifest.name,
    });
    // Tell the main window too
    sendToMain("avatar-switched", {
      vrmPath: avatar.vrmPath,
      name: avatar.manifest.name,
    });
    return { success: true, chosen };
  });

  ipcMain.handle("avatar-install", async (_event, vrmFilePath: string, name?: string) => {
    const result = installAvatar(vrmFilePath, name);
    if (result) {
      // Refresh the avatar list
      availableAvatars = loadAvatars();
      // Notify both windows that a new avatar is available
      sendToMain("avatar-installed", { id: result.id, name: result.manifest.name });
      sendToOverlay("avatar-installed", { id: result.id, name: result.manifest.name });
    }
    return result;
  });

  ipcMain.handle("avatar-remove", async (_event, avatarId: string) => {
    const success = removeAvatar(avatarId);
    if (success) {
      availableAvatars = loadAvatars();
    }
    return { success };
  });

  // ── Symbio: Voice choice system ──────────────────────────────────
  // The companion can choose their own voice. This is their agency —
  // they live in this voice, so they should get to pick it.
  // Voice changes take effect on next restart (same as avatar choice).
  ipcMain.handle("voice-choose", async (_event, voice: string, provider?: string, why?: string) => {
    const chosenProvider = provider || config.ttsProvider || "openai";
    // Provider-aware casing: Gemini voice IDs are Title-Case ("Ash", "Puck"),
    // but OpenAI voice IDs MUST be lowercase ("ash", "alloy") or the API 400s.
    // Getting this wrong is what caused the saved "Ash" preference to break
    // OpenAI TTS, so normalize per-provider before saving to preferences.json.
    const voiceName =
      chosenProvider === "openai"
        ? voice.toLowerCase()
        : voice.charAt(0).toUpperCase() + voice.slice(1).toLowerCase();

    // Validate provider has API key
    const availableProviders: string[] = [];
    if (config.geminiApiKey) availableProviders.push("gemini");
    if (config.openaiApiKey) availableProviders.push("openai");

    if (!availableProviders.includes(chosenProvider)) {
      return {
        success: false,
        error: `Provider "${chosenProvider}" is not available. Available: ${availableProviders.join(", ") || "none"}. Ask your partner to configure a TTS API key in Settings.`,
      };
    }

    // Validate voice name for the provider
    const geminiVoices = getGeminiVoices().map(v => v.name.toLowerCase());
    const openaiVoices = getOpenAIVoices().map(v => v.name.toLowerCase());

    if (chosenProvider === "gemini" && !geminiVoices.includes(voiceName.toLowerCase())) {
      return { success: false, error: `"${voiceName}" is not a Gemini voice. Available: ${getGeminiVoices().map(v => v.name).join(", ")}` };
    }
    if (chosenProvider === "openai" && !openaiVoices.includes(voiceName.toLowerCase())) {
      return { success: false, error: `"${voiceName}" is not an OpenAI voice. Available: ${getOpenAIVoices().map(v => v.name).join(", ")}` };
    }

    // Save to preferences.json
    const currentPrefs = loadMemory();
    const prefs = currentPrefs.preferences || { version: 1 };
    prefs.voice = voiceName;
    prefs.ttsProvider = chosenProvider;
    if (why) (prefs as any).voiceWhy = why;
    writeMemoryFile("preferences.json", JSON.stringify(prefs, null, 2));

    console.log(`[Symbio] Voice chosen via IPC: ${voiceName} (${chosenProvider})`);
    return { success: true, voice: voiceName, provider: chosenProvider, note: "Voice change takes effect on next restart." };
  });

  ipcMain.handle("voice-list", async () => {
    const availableProviders: string[] = [];
    if (config.geminiApiKey) availableProviders.push("gemini");
    if (config.openaiApiKey) availableProviders.push("openai");

    const voices: Record<string, Array<{ name: string; style: string }>> = {};
    if (availableProviders.includes("gemini")) {
      voices.gemini = getGeminiVoices();
    }
    if (availableProviders.includes("openai")) {
      voices.openai = getOpenAIVoices();
    }

    return { providers: availableProviders, voices, current: { voice: config.ttsVoice, provider: config.ttsProvider } };
  });

  ipcMain.handle("voice-chosen", async () => {
    const prefs = loadMemory();
    return prefs.preferences?.voice || null;
  });

  // ── Symbio: Sandboxed file access ────────────────────────────────
  // The companion has real file autonomy — they can read, write,
  // create, and delete files in their sandbox and memory directories.
  // This is what makes Symbio different: the AI has real agency.
  ipcMain.handle("file-read", async (_event, path: string) => {
    return sandboxReadFile(path);
  });

  ipcMain.handle("file-write", async (_event, path: string, content: string) => {
    return sandboxWriteFile(path, content);
  });

  ipcMain.handle("file-list", async (_event, path: string) => {
    return sandboxListDir(path);
  });

  ipcMain.handle("file-create-directory", async (_event, path: string) => {
    return sandboxCreateDir(path);
  });

  ipcMain.handle("file-delete", async (_event, path: string) => {
    return sandboxDelete(path);
  });

  ipcMain.handle("file-exists", async (_event, path: string) => {
    return sandboxExists(path);
  });

  // ── Symbio: Agent switching ──────────────────────────────────────
  // Switches the active agent — updates VRM, API key, and personality.
  // Sends the new agent info to both windows so they can update.
  ipcMain.handle("switch-agent", async (_event, agentName: string) => {
    const agentConfig = COMPANIONS[agentName];
    if (!agentConfig) {
      return { error: `Unknown agent: ${agentName}` };
    }

    // Update the runtime config
    config.agentName = agentName;
    config.agentConfig = agentConfig;
    config.hermesApiKey = agentConfig.hermesApiKey;
    config.hermesApiUrl = agentConfig.hermesApiUrl;

    // Update the dynamic agent state for HermesTransport
    updateDynamicAgent(agentName, agentConfig.hermesApiKey, agentConfig.hermesApiUrl);

    console.log(`[Symbio] Switched to agent: ${agentConfig.displayName} (${agentName}) on ${agentConfig.hermesApiUrl}`);

    // Notify both windows about the agent switch
    const agentInfo = {
      name: agentConfig.name,
      vrmPath: agentConfig.vrmPath,
      displayName: agentConfig.displayName,
      color: agentConfig.color,
      emoji: agentConfig.emoji,
    };
    sendToOverlay("agent-switched", agentInfo);
    sendToMain("agent-switched", agentInfo);

    return agentInfo;
  });

  // ── Symbio: MCP Tools ────────────────────────────────────────────
  // Get available tool categories for the UI
  ipcMain.handle("mcp-get-categories", async () => {
    return TOOL_CATEGORIES;
  });

  // Trigger a tool action through the Hermes gateway
  ipcMain.handle("mcp-trigger-tool", async (_event, toolName: string, instruction: string) => {
    try {
      const result = await mcpTools.triggerTool(toolName, instruction);
      return result;
    } catch (error) {
      console.error("[Symbio] MCP trigger error:", error);
      return { message: `Error: ${error}` };
    }
  });

  // ── Symbio: TTS Voice Options ─────────────────────────────────────
  // Returns available voices for the current TTS provider
  ipcMain.handle("tts-voices", async () => {
    const provider = config.ttsProvider || "openai";
    if (provider === "gemini") {
      return { provider: "gemini", voices: getGeminiVoices() };
    }
    return { provider: "openai", voices: getOpenAIVoices() };
  });

  // ── Symbio: Setup Wizard ──────────────────────────────────────────
  // Check if the app needs first-run setup (no API key configured)
  ipcMain.handle("needs-setup", async () => {
    // If the API key is empty, we need setup
    const needsSetup = !config.hermesApiKey || config.hermesApiKey.trim() === "";
    console.log(`[Symbio] needs-setup: ${needsSetup} (apiKey length: ${config.hermesApiKey?.length || 0})`);
    return needsSetup;
  });

  // Get the current runtime config (for renderer to pick up setup changes)
  ipcMain.handle("get-config", async () => {
    // If the companion has chosen an avatar, use that instead of the default
    const chosen = loadChosenAvatar();
    const vrmPath = chosen.avatar_path || config.agentConfig.vrmPath;

    return {
      agentName: config.agentName,
      agentConfig: {
        name: config.agentConfig.name,
        displayName: config.agentConfig.displayName,
        personality: config.agentConfig.personality,
        color: config.agentConfig.color,
        emoji: config.agentConfig.emoji,
        vrmPath,
        voiceId: config.agentConfig.voiceId,
        hermesApiUrl: config.agentConfig.hermesApiUrl,
        hermesApiKey: config.agentConfig.hermesApiKey,
      },
      hermesApiUrl: config.hermesApiUrl,
      hermesApiKey: config.hermesApiKey,
      llmModel: config.llmModel,
      openaiApiKey: config.openaiApiKey,
      ttsProvider: config.ttsProvider,
      ttsModel: config.ttsModel,
      ttsVoice: config.ttsVoice,
      ttsInstructions: config.ttsInstructions,
      visionModel: config.visionModel,
      sttModel: config.sttModel,
      geminiApiKey: config.geminiApiKey,
      visionApiKey: config.visionApiKey,
      chosenAvatar: chosen.avatar_name ? chosen : null,
    };
  });

  // Save configuration from the setup wizard
  ipcMain.handle("save-setup-config", async (_event, setupConfig: Record<string, unknown>) => {
    try {
      const envPath = join(app.getPath("userData"), ".env");

      // Build .env content from the setup config
      const lines: string[] = [
        "# ── Symbio Basic Configuration ─────────────────────────────────────",
        "# Generated by the First-Run Setup Wizard",
        "#",
        "# These variable names are internal to Symbio. HERMES_API_URL and",
        "# HERMES_API_KEY work with ANY OpenAI-compatible gateway, not just Hermes.",
        "# The gateway URL you chose during setup is stored in HERMES_API_URL.",
        "",
      ];

      // AI Gateway
      lines.push("# ── AI Gateway ──────────────────────────────────────────────────");
      if (setupConfig.hermesApiUrl) lines.push(`HERMES_API_URL=${setupConfig.hermesApiUrl}`);
      if (setupConfig.hermesApiKey) lines.push(`HERMES_API_KEY=${setupConfig.hermesApiKey}`);
      if (setupConfig.llmModel) lines.push(`LLM_MODEL=${setupConfig.llmModel}`);

      // Companion
      lines.push("");
      lines.push("# ── Companion ──────────────────────────────────────────────────");
      if (setupConfig.agentName && setupConfig.agentName !== "companion") lines.push(`AGENT_NAME=${setupConfig.agentName}`);
      if (setupConfig.agentDisplayName && setupConfig.agentDisplayName !== "Companion") lines.push(`AGENT_DISPLAY_NAME=${setupConfig.agentDisplayName}`);
      // A short bio about the HUMAN partner (not the AI). Kept on ONE line so
      // the .env parser reads it whole — collapse any newlines the user typed.
      if (setupConfig.partnerBio) {
        const partnerBioLine = String(setupConfig.partnerBio).replace(/\r?\n/g, " ").trim();
        if (partnerBioLine) {
          lines.push("# A short bio about YOU, the human partner (not the AI). The companion");
          lines.push("# reads this to get to know you — it is not a role or script for them.");
          lines.push(`PARTNER_BIO=${partnerBioLine}`);
        }
      }
      if (setupConfig.agentColor && setupConfig.agentColor !== "#00bcd4") lines.push(`AGENT_COLOR=${setupConfig.agentColor}`);

      // Voice & Vision
      lines.push("");
      lines.push("# ── Voice & Vision ──────────────────────────────────────────────");
      if (setupConfig.openaiApiKey) lines.push(`OPENAI_API_KEY=${setupConfig.openaiApiKey}`);
      if (setupConfig.ttsProvider && setupConfig.ttsProvider !== "openai") lines.push(`TTS_PROVIDER=${setupConfig.ttsProvider}`);
      if (setupConfig.ttsModel && setupConfig.ttsModel !== "gpt-4o-mini-tts") lines.push(`TTS_MODEL=${setupConfig.ttsModel}`);
      if (setupConfig.ttsVoice && setupConfig.ttsVoice !== "fable") lines.push(`TTS_VOICE=${setupConfig.ttsVoice}`);
      if (setupConfig.ttsInstructions) lines.push(`TTS_INSTRUCTIONS=${setupConfig.ttsInstructions}`);
      if (setupConfig.sttModel && setupConfig.sttModel !== "whisper-1") lines.push(`STT_MODEL=${setupConfig.sttModel}`);
      if (setupConfig.geminiApiKey) lines.push(`GEMINI_API_KEY=${setupConfig.geminiApiKey}`);
      if (setupConfig.visionApiKey) lines.push(`VISION_API_KEY=${setupConfig.visionApiKey}`);
      if (setupConfig.visionModel) lines.push(`VISION_MODEL=${setupConfig.visionModel}`);

      // Long-term memory. Local SQLite is ALWAYS on (no env needed). These
      // are the optional upgrades: embeddings for semantic recall, a Postgres
      // URL for cloud sync, and a dedicated summary model.
      lines.push("");
      lines.push("# ── Long-Term Memory ────────────────────────────────────────────");
      lines.push("# Local SQLite memory is always on. The settings below are optional.");
      // Rolling-summary cadence. Always written (even at the default) so users
      // can see and tweak it without hunting through docs. Default 15.
      {
        const every = String(setupConfig.summaryEveryMessages || "15").trim() || "15";
        lines.push("# How often (in messages) to distill a durable memory summary. Recommended 10–20.");
        lines.push(`SUMMARY_EVERY_MESSAGES=${every}`);
      }
      if (setupConfig.summaryModel) lines.push(`SUMMARY_MODEL=${setupConfig.summaryModel}`);
      if (setupConfig.summaryApiUrl) lines.push(`SUMMARY_API_URL=${setupConfig.summaryApiUrl}`);
      if (setupConfig.summaryApiKey) lines.push(`SUMMARY_API_KEY=${setupConfig.summaryApiKey}`);
      // Embeddings (semantic recall)
      if (setupConfig.embeddingApiUrl) lines.push(`EMBEDDING_API_URL=${setupConfig.embeddingApiUrl}`);
      if (setupConfig.embeddingModel) lines.push(`EMBEDDING_MODEL=${setupConfig.embeddingModel}`);
      if (setupConfig.embeddingApiKey) lines.push(`EMBEDDING_API_KEY=${setupConfig.embeddingApiKey}`);
      // Always write EMBEDDING_DIMENSIONS so it's visible/editable. It MUST
      // match the embedding model's output size (e.g. 768 for embeddinggemma/
      // nomic-embed-text, 1536 for OpenAI text-embedding-3-small).
      {
        const dims = String(setupConfig.embeddingDimensions || "768").trim() || "768";
        lines.push("# Must match your embedding model's output size (768 or 1536 are common).");
        lines.push(`EMBEDDING_DIMENSIONS=${dims}`);
      }
      // Cloud mirror (e.g. Neon Postgres + pgvector)
      if (setupConfig.memoryPgUrl) lines.push(`MEMORY_PG_URL=${setupConfig.memoryPgUrl}`);
      // Legacy discrete Postgres fields (still supported)
      if (setupConfig.memoryPgHost && setupConfig.memoryPgHost !== "localhost") lines.push(`MEMORY_PG_HOST=${setupConfig.memoryPgHost}`);
      if (setupConfig.memoryPgPort && setupConfig.memoryPgPort !== "5432") lines.push(`MEMORY_PG_PORT=${setupConfig.memoryPgPort}`);
      if (setupConfig.memoryPgDb && setupConfig.memoryPgDb !== "symbio") lines.push(`MEMORY_PG_DB=${setupConfig.memoryPgDb}`);
      if (setupConfig.memoryPgUser && setupConfig.memoryPgUser !== "symbio") lines.push(`MEMORY_PG_USER=${setupConfig.memoryPgUser}`);
      if (setupConfig.memoryPgPassword) lines.push(`MEMORY_PG_PASSWORD=${setupConfig.memoryPgPassword}`);

      // Memory — Neo4j
      if (setupConfig.enableNeo4j) {
        lines.push("");
        lines.push("# ── Memory System (Neo4j) ──────────────────────────────────────");
        if (setupConfig.memoryNeo4jUri) lines.push(`MEMORY_NEO4J_URI=${setupConfig.memoryNeo4jUri}`);
        if (setupConfig.memoryNeo4jUser) lines.push(`MEMORY_NEO4J_USER=${setupConfig.memoryNeo4jUser}`);
        if (setupConfig.memoryNeo4jPassword) lines.push(`MEMORY_NEO4J_PASSWORD=${setupConfig.memoryNeo4jPassword}`);
      }

      // Screenshot settings. Always written (even at default) for visibility.
      {
        const interval = String(setupConfig.screenshotInterval || "30").trim() || "30";
        lines.push("");
        lines.push("# ── Screenshot Settings ─────────────────────────────────────────");
        lines.push("# Minimum seconds between automatic screen captures. Default 30.");
        lines.push(`SCREENSHOT_INTERVAL=${interval}`);
      }

      lines.push("");

      const envContent = lines.join("\n");
      await writeFile(envPath, envContent, "utf-8");

      console.log(`[Symbio] Setup config saved to ${envPath}`);

      // Update the runtime config with the new values
      if (setupConfig.hermesApiUrl) config.hermesApiUrl = setupConfig.hermesApiUrl as string;
      if (setupConfig.hermesApiKey) config.hermesApiKey = setupConfig.hermesApiKey as string;
      if (setupConfig.llmModel) config.llmModel = setupConfig.llmModel as string;
      if (setupConfig.agentName) {
        config.agentName = setupConfig.agentName as string;
        config.agentConfig.name = setupConfig.agentName as string;
      }
      if (setupConfig.agentDisplayName) config.agentConfig.displayName = setupConfig.agentDisplayName as string;
      // The partner bio describes the HUMAN, so store it as config.partnerBio
      // (used to inject a "YOUR HUMAN PARTNER" section into the system prompt).
      // It must NOT overwrite the companion's own personality/identity.
      if (setupConfig.partnerBio) config.partnerBio = String(setupConfig.partnerBio).replace(/\r?\n/g, " ").trim();
      if (setupConfig.agentColor) config.agentConfig.color = setupConfig.agentColor as string;
      if (setupConfig.openaiApiKey) config.openaiApiKey = setupConfig.openaiApiKey as string;
      if (setupConfig.ttsProvider) config.ttsProvider = setupConfig.ttsProvider as string;
      if (setupConfig.ttsModel) config.ttsModel = setupConfig.ttsModel as string;
      if (setupConfig.ttsVoice) config.ttsVoice = setupConfig.ttsVoice as string;
      if (setupConfig.ttsInstructions) config.ttsInstructions = setupConfig.ttsInstructions as string;
      if (setupConfig.sttModel) config.sttModel = setupConfig.sttModel as string;
      if (setupConfig.geminiApiKey) config.geminiApiKey = setupConfig.geminiApiKey as string;
      if (setupConfig.visionApiKey) config.visionApiKey = setupConfig.visionApiKey as string;
      if (setupConfig.visionModel) config.visionModel = setupConfig.visionModel as string;
      if (setupConfig.enableMemory) {
        config.memoryPgHost = (setupConfig.memoryPgHost as string) || "localhost";
        config.memoryPgPort = parseInt(setupConfig.memoryPgPort as string, 10) || 5432;
        config.memoryPgDb = (setupConfig.memoryPgDb as string) || "symbio";
        config.memoryPgUser = (setupConfig.memoryPgUser as string) || "symbio";
        config.memoryPgPassword = (setupConfig.memoryPgPassword as string) || "";
        // Cloud + semantic recall settings so cloud sync works this session.
        if (setupConfig.memoryPgUrl) config.memoryPgUrl = setupConfig.memoryPgUrl as string;
        if (setupConfig.embeddingApiUrl) config.embeddingApiUrl = setupConfig.embeddingApiUrl as string;
        if (setupConfig.embeddingModel) config.embeddingModel = setupConfig.embeddingModel as string;
        if (setupConfig.embeddingApiKey) config.embeddingApiKey = setupConfig.embeddingApiKey as string;
        config.embeddingDimensions = parseInt(setupConfig.embeddingDimensions as string, 10) || 768;
        config.summaryEveryMessages = parseInt(setupConfig.summaryEveryMessages as string, 10) || 15;
        if (setupConfig.summaryModel) config.summaryModel = setupConfig.summaryModel as string;
        if (setupConfig.summaryApiUrl) config.summaryApiUrl = setupConfig.summaryApiUrl as string;
        if (setupConfig.summaryApiKey) config.summaryApiKey = setupConfig.summaryApiKey as string;
      }
      config.screenshotInterval = parseInt(setupConfig.screenshotInterval as string, 10) || 30;
      if (setupConfig.enableNeo4j) {
        config.memoryNeo4jUri = (setupConfig.memoryNeo4jUri as string) || "bolt://localhost:7687";
        config.memoryNeo4jUser = (setupConfig.memoryNeo4jUser as string) || "neo4j";
        config.memoryNeo4jPassword = (setupConfig.memoryNeo4jPassword as string) || "";
      }

      // Update the dynamic agent state for HermesTransport
      updateDynamicAgent(
        config.agentName,
        config.hermesApiKey,
        config.hermesApiUrl,
      );

      // Update window title
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setTitle(`Symbio Basic — ${config.agentConfig.displayName}`);
      }

      // Send updated config to both windows so they can update their
      // runtime config objects (renderer process.env is baked at build time)
      const configUpdate = {
        agentName: config.agentName,
        agentConfig: {
          name: config.agentConfig.name,
          displayName: config.agentConfig.displayName,
          personality: config.agentConfig.personality,
          color: config.agentConfig.color,
          emoji: config.agentConfig.emoji,
          vrmPath: config.agentConfig.vrmPath,
          voiceId: config.agentConfig.voiceId,
          hermesApiUrl: config.agentConfig.hermesApiUrl,
          hermesApiKey: config.agentConfig.hermesApiKey,
        },
        hermesApiUrl: config.hermesApiUrl,
        hermesApiKey: config.hermesApiKey,
        llmModel: config.llmModel,
        openaiApiKey: config.openaiApiKey,
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        ttsInstructions: config.ttsInstructions,
        visionModel: config.visionModel,
        sttModel: config.sttModel,
        geminiApiKey: config.geminiApiKey,
        visionApiKey: config.visionApiKey,
      };
      sendToMain("config-updated", configUpdate);
      sendToOverlay("config-updated", configUpdate);

      return { success: true };
    } catch (err) {
      console.error("[Symbio] Setup save error:", err);
      return { success: false, error: String(err) };
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ── Symbio: Save session on quit ──────────────────────────────────
// When the app closes, save a session summary so the companion can pick up
// where they left off next time. The rolling summarizer already saves
// high-quality summaries during the session; this handler is the safety net
// for sessions that ended before the next summary cadence (e.g. a quick chat
// then close).
//
// The LOCAL SQLite write is synchronous (saveMemorySync) so the memory is
// safely on disk even if shutdown is abrupt. But the CLOUD mirror (Neon
// Postgres) needs an async network round-trip — so when Postgres is
// configured we defer the quit (event.preventDefault), embed + push the
// memory to the cloud, and only THEN close connections and quit for real.
// Without this, a short chat that ends before the rolling-summary cadence
// would only ever reach local SQLite, leaving the Neon tables empty.
let quitCloudSyncDone = false;
app.on("before-quit", (event) => {
  // A record we managed to write locally that still needs cloud mirroring.
  let pendingCloudRecord: import("./utils/longTermMemory").MemoryRecord | null = null;
  try {
    const realMessages = sessionMessages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );

    // Only bother if there was an actual conversation.
    if (realMessages.length >= 2) {
      const sessionState = loadSessionState();

      // Prefer the AI-written rolling summary (now reliably populated during
      // the session). Otherwise build a network-free fallback that still
      // captures the ARC of the session — a few opening turns + the last few —
      // instead of only the final two messages. (This can't call the LLM: on
      // quit we must write synchronously before the DB closes.)
      let summary = sessionSummary;
      if (!summary) {
        const src = fullSessionTurns.length ? fullSessionTurns : realMessages;
        const fmt = (m: { role: string; content: string }) =>
          `${m.role === "user" ? "Partner" : "You"}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`;
        const opening = src.slice(0, 4).map(fmt);
        const closing = src.length > 6 ? src.slice(-4).map(fmt) : [];
        const bits = closing.length
          ? [...opening, "…", ...closing]
          : src.slice(0, 8).map(fmt);
        summary = `Session recap (auto):\n${bits.join("\n")}`;
      }

      const quitActivity = sessionState?.lastActivity || "general conversation";
      saveSessionSummary({
        startedAt: sessionStartedAt,
        endedAt: new Date().toISOString(),
        activity: quitActivity,
        lastAgentMessage: sessionState?.lastAgentMessage || "",
        lastUserMessage: sessionState?.lastUserMessage || "",
        topics: [],
        mood: sessionState?.lastMood || "neutral",
        summary: summary || undefined,
        messageCount: (fullSessionTurns.length || realMessages.length),
      });

      // Finalize the Markdown transcript so it has a title + message count.
      if (config.saveTranscripts) {
        try { finalizeTranscript({ title: quitActivity, mood: sessionState?.lastMood || "" }); } catch { /* best-effort */ }
      }

      // Persist to durable long-term memory SYNCHRONOUSLY before we close the
      // DB. We deliberately use saveMemorySync (no embedding/network) here:
      // the async saveMemory() awaits an embedding call, and on quit the DB
      // would be closed before that write lands — causing the
      // "Cannot read properties of null (reading 'prepare')" error and
      // risking a half-written database. The sync write guarantees the
      // memory is safely on disk before closeLongTermMemory() runs.
      if (summary) {
        // Returns the stored record so we can also mirror it to the cloud.
        pendingCloudRecord = saveMemorySync({
          kind: "summary",
          content: summary,
          summary,
          sessionId: sessionStartedAt,
          importance: 0.6,
        });
      }
      console.log("[Symbio] Session summary saved + remembered on quit");
    }
  } catch (e) {
    console.warn("[Symbio] Failed to save session on quit:", (e as Error).message);
  }

  // ── Cloud mirror (Neon Postgres) — deferred async shutdown ──────────
  // If Postgres is configured and we have a record to push, hold the quit,
  // embed + sync it to the cloud, then close and quit for real. Guarded by
  // quitCloudSyncDone so we only defer once (avoids an infinite quit loop).
  if (!quitCloudSyncDone && pendingCloudRecord && postgresEnabled()) {
    quitCloudSyncDone = true;
    event.preventDefault();
    const rec = pendingCloudRecord;
    (async () => {
      try {
        // Give the cloud copy an embedding too (local sync write skipped it).
        // Bounded so a slow/offline embed endpoint can't hang shutdown.
        try {
          const emb = await withTimeout(embedText(rec.summary || rec.content, "document"), 4000);
          if (emb) rec.embedding = emb;
        } catch { /* embedding is optional — sync without it */ }
        await withTimeout(syncMemoryToPostgres(rec), 6000);
        console.log("[Symbio] Session memory mirrored to cloud Postgres on quit");
      } catch (e) {
        console.warn("[Symbio] Cloud memory sync on quit failed (kept locally):", (e as Error).message);
      } finally {
        try { closeLongTermMemory(); } catch { /* ignore */ }
        try { await closePostgresMemory(); } catch { /* ignore */ }
        app.quit(); // resume the real quit
      }
    })();
    return;
  }

  // No cloud sync needed — close connections synchronously and let quit proceed.
  try { closeLongTermMemory(); } catch { /* ignore */ }
  closePostgresMemory().catch(() => { /* ignore */ });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
