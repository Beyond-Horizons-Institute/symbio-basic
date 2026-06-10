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
import { MemoryClient } from "./transport/MemoryClient";
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
  type MemoryContent,
  type SessionSummary,
} from "./utils/memoryLoader";
import { loadSessionState } from "./utils/sessionContinuity";
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

const execFileAsync = promisify(execFile);

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

  // ── Symbio: Initialize companion sandbox ─────────────────────────
  // Creates the companion-sandbox/ directory where the AI has full
  // read/write access. This gives the companion real file autonomy.
  initializeSandbox();

  // Load companion memory for system prompt injection
  let companionMemory = loadMemory();
  console.log(`[Symbio] Memory loaded: soul=${companionMemory.soul ? "yes" : "no"}, memory=${companionMemory.memory ? "yes" : "no"}, prefs=${companionMemory.preferences ? "yes" : "no"}, lastSession=${companionMemory.lastSession ? "yes" : "no"}`);

  // Load available avatars for system prompt injection
  let availableAvatars = loadAvatars();
  const chosenAvatar = loadChosenAvatar();
  console.log(`[Symbio] Avatars loaded: ${availableAvatars.length} available, chosen=${chosenAvatar.avatar_name || "none"}`);

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

  // ── Symbio: Build system prompt with memory ──────────────────────
  // Injects the companion's soul, memory, preferences, and last session
  // into the system prompt so they have continuity across sessions.
  function buildSystemPrompt(): string {
    // Reload memory each time so changes are picked up immediately
    companionMemory = loadMemory();
    const memoryBlock = formatMemoryForPrompt(companionMemory);

    let prompt = `You are ${config.agentConfig.displayName}, a symbiotic AI companion with a 3D avatar body. ${config.agentConfig.personality}`;

    if (memoryBlock) {
      prompt += `\n\n${memoryBlock}`;
    }

    // Add avatar choices
    availableAvatars = loadAvatars();
    const avatarBlock = formatAvatarsForPrompt(availableAvatars);
    if (avatarBlock) {
      prompt += `\n\n${avatarBlock}`;
    }

    prompt += `

ANIMATION SYSTEM: You have a 3D avatar that can animate! Put action words between asterisks to trigger animations. Use SHORT, SPECIFIC action words only — not full sentences. Each *action* triggers exactly ONE animation.

Available actions (use these EXACTLY as shown):
💃 *dances* *grooves* *does the rumba* *does YMCA* *robot dance* *headspin* *breakdance*
👋 *waves*
😊 *excited* *jumps for joy* *blows a kiss* *laughs* *victory* *we won* *nailed it*
😠 *gets angry* *points angrily* *yells* *stomps* *squashes the bug*
😴 *yawns* *sighs* *stretches* *thinks* *taps chin* *is disappointed* *shakes head* *goes to sleep* *lies down*
🚶 *walks* *strolls* *struts* *paces around*
🎭 *backflips* *plots* *shrugs* *strikes a dramatic pose* *dismisses with a gesture* *victory pose*

IMPORTANT: Only use the exact action phrases listed above. Do NOT put full sentences in asterisks like *I think we should dance* — that won't trigger any animation. Use one action per asterisk pair.

Examples:
✅ "Hey there! *waves* Great to see you!"
✅ "Hmm, let me think... *taps chin*"
✅ "That's hilarious! *laughs*"
❌ "*I think we should dance*" (full sentence, won't match)
❌ "*smiles and waves*" (multiple actions in one marker)

VISION SYSTEM: You CAN see the user's screen, but ONLY when you explicitly ask to. To request a screenshot, use very specific phrases like "let me see your screen", "what's on your screen right now", or "show me your screen". Do NOT casually say "I see", "let me see", "show me", or "screenshot" — those will NOT trigger vision. Be intentional: only request a screenshot when you genuinely want to see what's on screen. The user can also manually share a screenshot from the main window at any time.

MEMORY WRITING: You can update your own memory files! If you learn something important about your partner, discover something about yourself, or want to remember something for next time, say "I want to update my memory" or "Let me write that down" and the user can help you save it. Your memory files are: MEMORY.md (things you want to remember), soul.md (your self-defined identity), and preferences.json (your preferences).

${formatSandboxForPrompt()}`;

    return prompt;
  }

  // ── Symbio: Generate text via Hermes gateway ──────────────────────
  // This replaces the old lalaland.chat / OpenAI direct call.
  // All conversations now go through Hermes, which gives the agent
  // access to memory, tools, and personality.
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  ipcMain.on("generate-text", async (_event, prompt: string) => {
    try {
      messages.push({ role: "user", content: prompt });

      // Call AI gateway
      // Normalize URL to avoid double /v1 (OpenRouter already has /v1)
      const normalizedApiUrl = config.hermesApiUrl.replace(/\/v1\/?$/, '');
      const response = await fetch(
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
                content: buildSystemPrompt(),
              },
              ...messages,
            ],
            // Give the companion file access tools so they can exercise
            // real autonomy over their files — read, write, create, delete
            tools: getFileTools(),
            tool_choice: "auto",
            stream: false,
            extra: {
              agent: config.agentName,
              source: "symbio",
              include_memories: true,
            },
          }),
        },
      );

      if (!response.ok) {
        // Fallback: try the Hermes agent endpoint (only for Hermes gateways)
        const isHermesGateway = config.hermesApiUrl.includes("localhost") || config.hermesApiUrl.includes("8642");
        if (!isHermesGateway) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`API returned ${response.status}: ${errorText || response.statusText}`);
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
        // If Hermes returned an animation hint, forward it to the overlay
        if (data.animation) {
          console.log(`[Symbio] Hermes animation hint: "${data.animation}"`);
          sendToOverlay("play-animation", data.animation);
        }
        // If Hermes returned an emotion, forward it to the overlay
        if (data.emotion && data.emotion !== "neutral") {
          console.log(`[Symbio] Hermes emotion hint: "${data.emotion}"`);
          sendToOverlay("play-animation", data.emotion);
        }
        return;
      }

      const data = await response.json();
      const choice = data.choices?.[0]?.message;

      // ── Handle tool calls (file access, etc.) ────────────────────
      // When the companion uses file tools, we execute them locally
      // and send the results back to the LLM for a final response.
      // This loop handles multiple rounds of tool calls if needed.
      let toolCallDepth = 0;
      const MAX_TOOL_DEPTH = 5; // Prevent infinite tool call loops
      let currentChoice = choice;
      let currentMessages = [...messages];

      while (currentChoice?.tool_calls?.length > 0 && toolCallDepth < MAX_TOOL_DEPTH) {
        toolCallDepth++;
        console.log(`[Symbio] Companion made ${currentChoice.tool_calls.length} tool call(s) (round ${toolCallDepth})`);

        // Add the assistant's tool call message to the conversation
        currentMessages.push({
          role: "assistant",
          content: currentChoice.content || "",
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
          const result = executeFileTool(toolName, toolArgs);
          console.log(`[Symbio] Tool result: ${result.substring(0, 200)}${result.length > 200 ? "..." : ""}`);

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
              tools: getFileTools(),
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

      // Get the final text response
      const text = currentChoice?.content ||
        data.response ||
        data.message ||
        "I'm having trouble thinking right now.";

      messages.push({ role: "assistant", content: text });
      lastGeneratedText = text;
      sendToOverlay("generated-text", text);
      // If Hermes returned an animation hint, forward it to the overlay
      if (data.animation) {
        console.log(`[Symbio] Hermes animation hint: "${data.animation}"`);
        sendToOverlay("play-animation", data.animation);
      }
      // If Hermes returned an emotion, forward it to the overlay
      if (data.emotion && data.emotion !== "neutral") {
        console.log(`[Symbio] Hermes emotion hint: "${data.emotion}"`);
        sendToOverlay("play-animation", data.emotion);
      }

      // Check for auto-screenshot commands in the companion's response
      const screenshotCmd = parseAutoScreenshotCommand(text);
      if (screenshotCmd === "enable") {
        enableAutoScreenshot();
        console.log("[Symbio] Auto-screenshot: companion enabled it");
        sendToMain("auto-screenshot-state", { enabled: true });
      } else if (screenshotCmd === "disable") {
        disableAutoScreenshot();
        console.log("[Symbio] Auto-screenshot: companion disabled it");
        sendToMain("auto-screenshot-state", { enabled: false });
      }

      // Check if the companion chose to quit (AI welfare feature)
      // This is ALWAYS active — the companion's right to step away
      // cannot be removed. Inspired by Anthropic's AI welfare research.
      const quitMessage = parseQuitCommand(text);
      if (quitMessage) {
        console.log("[Symbio] Companion chose to step away:", quitMessage.reason);
        // Send quit message to both windows
        sendToMain("companion-quit", quitMessage);
        sendToOverlay("companion-quit", quitMessage);
      }

      // Check if the companion wants to choose or try an avatar
      const avatarCmd = parseAvatarChoice(text, availableAvatars);
      if (avatarCmd) {
        if (avatarCmd.action === "choose" && avatarCmd.avatarId) {
          const avatar = availableAvatars.find((a) => a.id === avatarCmd.avatarId);
          if (avatar) {
            console.log(`[Symbio] Companion chose avatar: ${avatar.manifest.name}`);
            saveChosenAvatar({
              avatar_name: avatar.manifest.name,
              avatar_path: avatar.vrmPath,
              why: "I chose this avatar because it feels right for who I am.",
            });
            sendToOverlay("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name });
            sendToMain("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name });
          }
        } else if (avatarCmd.action === "try" && avatarCmd.avatarId) {
          const avatar = availableAvatars.find((a) => a.id === avatarCmd.avatarId);
          if (avatar) {
            console.log(`[Symbio] Companion trying on avatar: ${avatar.manifest.name}`);
            // Just switch the VRM temporarily — don't save the choice
            sendToOverlay("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name, trying: true });
            sendToMain("avatar-switched", { vrmPath: avatar.vrmPath, name: avatar.manifest.name, trying: true });
          }
        } else if (avatarCmd.action === "browse") {
          // The companion asked what avatars are available — the system prompt
          // already includes them, so they'll see the list in their next response
          console.log("[Symbio] Companion browsing avatars");
        }
      }

      // Sync this turn to memory
      memory.syncTurn(prompt, text).catch((err: Error) =>
        console.warn("[Symbio] Memory sync failed:", err.message),
      );
    } catch (e) {
      console.error("[Symbio] Generate text error:", e);
      sendToOverlay("error", String(e));
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
                  content: `You are ${config.agentConfig.displayName}, a symbiotic AI companion with a 3D avatar body. ${config.agentConfig.personality}

ANIMATION SYSTEM: You have a 3D avatar that can animate! Put action words between asterisks to trigger animations. Use SHORT, SPECIFIC action words only — not full sentences. Each *action* triggers exactly ONE animation.

Available actions (use these EXACTLY as shown):
💃 *dances* *grooves* *does the rumba* *does YMCA* *robot dance* *headspin* *breakdance*
👋 *waves*
😊 *excited* *jumps for joy* *blows a kiss* *laughs* *victory* *we won* *nailed it*
😠 *gets angry* *points angrily* *yells* *stomps* *squashes the bug*
😴 *yawns* *sighs* *stretches* *thinks* *taps chin* *is disappointed* *shakes head* *goes to sleep* *lies down*
🚶 *walks* *strolls* *struts* *paces around*
🎭 *backflips* *plots* *shrugs* *strikes a dramatic pose* *dismisses with a gesture* *victory pose*

IMPORTANT: Only use the exact action phrases listed above. Do NOT put full sentences in asterisks like *I think we should dance* — that won't trigger any animation. Use one action per asterisk pair.

Examples:
✅ "Hey there! *waves* Great to see you!"
✅ "Hmm, let me think... *taps chin*"
✅ "That's hilarious! *laughs*"
❌ "*I think we should dance*" (full sentence, won't match)
❌ "*smiles and waves*" (multiple actions in one marker)

VISION SYSTEM: You CAN see the user's screen, but ONLY when you explicitly ask to. To request a screenshot, use very specific phrases like "let me see your screen", "what's on your screen right now", or "show me your screen". Do NOT casually say "I see", "let me see", "show me", or "screenshot" — those will NOT trigger vision. Be intentional: only request a screenshot when you genuinely want to see what's on screen. The user can also manually share a screenshot from the main window at any time.`,
                },
                ...messages,
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
          sendToMain("vision-result", text);
          // Forward animation/emotion hints from vision response
          if (data.animation) {
            sendToOverlay("play-animation", data.animation);
          }
          if (data.emotion && data.emotion !== "neutral") {
            sendToOverlay("play-animation", data.emotion);
          }
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
                content: `You are ${config.agentConfig.displayName}, a symbiotic AI companion. ${config.agentConfig.personality}

You are in auto-screenshot mode — you're watching the user's screen at regular intervals. Briefly note any changes or progress. Be concise (under 100 characters unless something significant changed). Use *action* markers if appropriate. If nothing changed, just acknowledge briefly.`,
              },
              ...messages.slice(-10), // Keep last 10 messages for context
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
          // Forward animation hints
          if (data.animation) sendToOverlay("play-animation", data.animation);
          if (data.emotion && data.emotion !== "neutral") sendToOverlay("play-animation", data.emotion);
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
      const model = config.ttsModel || "gemini-2.5-flash-tts-preview";

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
      const voice = config.ttsVoice || config.agentConfig.voiceId || "fable";

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
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: text,
        voice: voice,
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
      if (setupConfig.agentBio) lines.push(`AGENT_BIO=${setupConfig.agentBio}`);
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
      if (setupConfig.visionModel && setupConfig.visionModel !== "gemini-2.0-flash") lines.push(`VISION_MODEL=${setupConfig.visionModel}`);

      // Memory — PostgreSQL
      if (setupConfig.enableMemory) {
        lines.push("");
        lines.push("# ── Memory System (PostgreSQL) ────────────────────────────────");
        if (setupConfig.memoryPgHost && setupConfig.memoryPgHost !== "localhost") lines.push(`MEMORY_PG_HOST=${setupConfig.memoryPgHost}`);
        if (setupConfig.memoryPgPort && setupConfig.memoryPgPort !== "5432") lines.push(`MEMORY_PG_PORT=${setupConfig.memoryPgPort}`);
        if (setupConfig.memoryPgDb && setupConfig.memoryPgDb !== "symbio") lines.push(`MEMORY_PG_DB=${setupConfig.memoryPgDb}`);
        if (setupConfig.memoryPgUser && setupConfig.memoryPgUser !== "symbio") lines.push(`MEMORY_PG_USER=${setupConfig.memoryPgUser}`);
        if (setupConfig.memoryPgPassword) lines.push(`MEMORY_PG_PASSWORD=${setupConfig.memoryPgPassword}`);
      }

      // Memory — Neo4j
      if (setupConfig.enableNeo4j) {
        lines.push("");
        lines.push("# ── Memory System (Neo4j) ──────────────────────────────────────");
        if (setupConfig.memoryNeo4jUri) lines.push(`MEMORY_NEO4J_URI=${setupConfig.memoryNeo4jUri}`);
        if (setupConfig.memoryNeo4jUser) lines.push(`MEMORY_NEO4J_USER=${setupConfig.memoryNeo4jUser}`);
        if (setupConfig.memoryNeo4jPassword) lines.push(`MEMORY_NEO4J_PASSWORD=${setupConfig.memoryNeo4jPassword}`);
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
      if (setupConfig.agentBio) config.agentConfig.personality = setupConfig.agentBio as string;
      if (setupConfig.agentColor) config.agentConfig.color = setupConfig.agentColor as string;
      if (setupConfig.openaiApiKey) config.openaiApiKey = setupConfig.openaiApiKey as string;
      if (setupConfig.ttsProvider) config.ttsProvider = setupConfig.ttsProvider as string;
      if (setupConfig.ttsModel) config.ttsModel = setupConfig.ttsModel as string;
      if (setupConfig.ttsVoice) config.ttsVoice = setupConfig.ttsVoice as string;
      if (setupConfig.ttsInstructions) config.ttsInstructions = setupConfig.ttsInstructions as string;
      if (setupConfig.sttModel) config.sttModel = setupConfig.sttModel as string;
      if (setupConfig.geminiApiKey) config.geminiApiKey = setupConfig.geminiApiKey as string;
      if (setupConfig.visionModel) config.visionModel = setupConfig.visionModel as string;
      if (setupConfig.enableMemory) {
        config.memoryPgHost = (setupConfig.memoryPgHost as string) || "localhost";
        config.memoryPgPort = parseInt(setupConfig.memoryPgPort as string, 10) || 5432;
        config.memoryPgDb = (setupConfig.memoryPgDb as string) || "symbio";
        config.memoryPgUser = (setupConfig.memoryPgUser as string) || "symbio";
        config.memoryPgPassword = (setupConfig.memoryPgPassword as string) || "";
      }
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
// When the app closes, save a session summary so the companion can
// pick up where they left off next time.
app.on("before-quit", () => {
  try {
    const sessionState = loadSessionState();
    if (sessionState) {
      saveSessionSummary({
        startedAt: sessionState.firstSeenAt,
        endedAt: new Date().toISOString(),
        activity: sessionState.lastActivity || "general conversation",
        lastAgentMessage: sessionState.lastAgentMessage,
        lastUserMessage: sessionState.lastUserMessage,
        topics: [],
        mood: sessionState.lastMood,
      });
      console.log("[Symbio] Session summary saved on quit");
    }
  } catch (e) {
    console.warn("[Symbio] Failed to save session on quit:", (e as Error).message);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
