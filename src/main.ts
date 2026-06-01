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
dotenv.config();

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
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { config, COMPANIONS } from "./config";
import { GeminiClient } from "./transport/GeminiClient";
import { STTClient } from "./transport/STTClient";
import { MemoryClient } from "./transport/MemoryClient";
import { MiniverseClient } from "./transport/MiniverseClient";
import { MCPToolsClient, TOOL_CATEGORIES } from "./transport/MCPToolsClient";
import { updateDynamicAgent } from "./transport/HermesTransport";
import {
  enableAutoScreenshot,
  disableAutoScreenshot,
  isAutoScreenshotEnabled,
  canTakeAutoScreenshot,
  markAutoScreenshotTaken,
  parseAutoScreenshotCommand,
} from "./utils/autoScreenshot";
import { parseQuitCommand } from "./utils/aiQuit";

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
async function captureScreen(width: number, height: number): Promise<Buffer | null> {
  // Method 1: Try Electron's desktopCapturer (works on X11/macOS/Windows)
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
      formData.append("model", "whisper-1");

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

  // ── Symbio: Generate text via Hermes gateway ──────────────────────
  // This replaces the old lalaland.chat / OpenAI direct call.
  // All conversations now go through Hermes, which gives the agent
  // access to memory, tools, and personality.
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  ipcMain.on("generate-text", async (_event, prompt: string) => {
    try {
      messages.push({ role: "user", content: prompt });

      // Call Hermes gateway
      const response = await fetch(
        `${config.hermesApiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.hermesApiKey
              ? { Authorization: `Bearer ${config.hermesApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.agentName,
            messages: [
              {
                role: "system",
                content: `You are ${config.agentConfig.displayName}, a symbiotic AI companion with a 3D avatar body. ${config.agentConfig.personality}

ANIMATION SYSTEM: You have a 3D avatar that can animate! Use *action* markers in your responses to trigger animations. Here are ALL the animations you can do:

💃 DANCE: *dances*, *grooves*, *does the rumba*, *does YMCA*, *robot dance*
👋 GREET: *waves*, *greets*
😊 HAPPY: *excited*, *jumps for joy*, *blows a kiss*, *laughs*
😠 ANGRY: *gets angry*, *points angrily*, *yells*
😴 BORED: *yawns*, *sighs*, *stretches*, *thinks*, *taps chin*, *is disappointed*, *shakes head*
🚶 WALK: *walks*, *strolls*, *struts*, *paces around*
🎭 EMOTE: *backflips*, *plots*, *shrugs*, *facepalms*, *strikes a dramatic pose*, *dismisses with a gesture*

Use these naturally in conversation! Example: "Hey there! *waves* Great to see you!" or "Oh please. *dismisses with a gesture* That's ridiculous."

VISION SYSTEM: You CAN see the user's screen, but ONLY when you explicitly ask to. To request a screenshot, use very specific phrases like "let me see your screen", "what's on your screen right now", or "show me your screen". Do NOT casually say "I see", "let me see", "show me", or "screenshot" — those will NOT trigger vision. Be intentional: only request a screenshot when you genuinely want to see what's on screen. The user can also manually share a screenshot from the main window at any time.`,
              },
              ...messages,
            ],
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
        // Fallback: try the agent endpoint
        const fallbackResponse = await fetch(
          `${config.hermesApiUrl}/gateway/${config.agentName}`,
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
      const text =
        data.choices?.[0]?.message?.content ||
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
      // Only active if AI_QUIT_ENABLED is true (default)
      if (config.aiQuitEnabled) {
        const quitMessage = parseQuitCommand(text);
        if (quitMessage) {
          console.log("[Symbio] Companion chose to step away:", quitMessage.reason);
          // Send quit message to both windows
          sendToMain("companion-quit", quitMessage);
          sendToOverlay("companion-quit", quitMessage);
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
        const response = await fetch(
          `${config.hermesApiUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.agentName,
              messages: [
                {
                  role: "system",
                  content: `You are ${config.agentConfig.displayName}, a symbiotic AI companion with a 3D avatar body. ${config.agentConfig.personality}

ANIMATION SYSTEM: You have a 3D avatar that can animate! Use *action* markers in your responses to trigger animations. Here are ALL the animations you can do:

💃 DANCE: *dances*, *grooves*, *does the rumba*, *does YMCA*, *robot dance*
👋 GREET: *waves*, *greets*
😊 HAPPY: *excited*, *jumps for joy*, *blows a kiss*, *laughs*
😠 ANGRY: *gets angry*, *points angrily*, *yells*
😴 BORED: *yawns*, *sighs*, *stretches*, *thinks*, *taps chin*, *is disappointed*, *shakes head*
🚶 WALK: *walks*, *strolls*, *struts*, *paces around*
🎭 EMOTE: *backflips*, *plots*, *shrugs*, *facepalms*, *strikes a dramatic pose*, *dismisses with a gesture*

Use these naturally in conversation! Example: "Hey there! *waves* Great to see you!" or "Oh please. *dismisses with a gesture* That's ridiculous."

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
      const rawPng = await captureScreen(width, height);
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

      const response = await fetch(
        `${config.hermesApiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.agentName,
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
    if (openaiKey) {
      // ── OpenAI TTS API (Streaming) ────────────────────────────────
      // High-quality voice using gpt-4o-mini-tts (same model Hermes uses).
      // We stream PCM audio (24kHz, 16-bit, little-endian) for minimal
      // latency — audio starts playing within ~200ms instead of waiting
      // for the entire MP3 to download.
      // Voice can be configured via AGENT_VOICE env var (alloy, echo, fable, onyx, nova, shimmer)
      const voice = config.agentConfig.voiceId || "fable";

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
            model: "gpt-4o-mini-tts",
            input: text,
            voice: voice,
            response_format: "pcm",
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
        const endedPromise = new Promise<void>((resolve) => {
          const handler = (_event: any, result: string) => {
            ipcMain.removeListener("tts-playback-ended", handler);
            resolve();
          };
          ipcMain.on("tts-playback-ended", handler);
          // Timeout after 30 seconds max
          setTimeout(() => {
            ipcMain.removeListener("tts-playback-ended", handler);
            resolve();
          }, 30000);
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
    const wordCount = text.split(/\s+/).length;
    const durationMs = Math.max(2000, (wordCount / 2.5) * 1000) + 500;
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

  // ── Symbio: Agent switching ──────────────────────────────────────
  // Switches the active agent — updates VRM, API key, and personality.
  // Sends the new agent info to both windows so they can update.
  ipcMain.handle("switch-agent", async (_event, agentName: string) => {
    const agentConfig = AGENTS[agentName];
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
