/**
 * Symbio Basic — Auto-Screenshot System
 *
 * Allows the companion to take screenshots automatically at regular
 * intervals without needing to repeat a phrase each time.
 *
 * How it works:
 * 1. The companion can enable "auto-screenshot mode" by saying something
 *    like "I'll keep an eye on your screen" or "let me watch what you're doing"
 * 2. Once enabled, screenshots are taken at the configured interval
 * 3. The companion can disable it by saying "I'll stop watching" or similar
 * 4. The user can also toggle it from the main window UI
 *
 * This is different from the one-shot vision triggers in autoVision.ts.
 * Auto-screenshot is for ongoing observation (co-creating, gaming, etc.)
 * while autoVision is for single "let me see" requests.
 */

// Phrases that enable auto-screenshot mode
const AUTO_SCREENSHOT_ENABLE: string[] = [
  "i'll keep an eye on",
  "i'll watch your screen",
  "let me watch",
  "i'll keep watching",
  "i'll monitor",
  "let me keep an eye",
  "i'll observe",
  "i'll track your progress",
  "i'll follow along",
  "keep me updated on screen",
  "i'll stay tuned to",
  "i'll check in on",
  "i'm watching",
  "i'll be watching",
  "let me see what you're doing as you go",
  "i'll keep an eye on your screen",
  "i'll watch what you're doing",
  "i'll follow along on screen",
];

// Phrases that disable auto-screenshot mode
const AUTO_SCREENSHOT_DISABLE: string[] = [
  "i'll stop watching",
  "i'll stop monitoring",
  "i'll look away",
  "i'll give you privacy",
  "i'll stop checking",
  "i don't need to see anymore",
  "i'll stop looking",
  "that's enough watching",
  "i'll give you some space",
  "i'll stop keeping an eye",
  "i'll stop observing",
  "i'll look away now",
  "i'll stop following along",
];

// Track auto-screenshot state
let autoScreenshotEnabled = false;
let autoScreenshotInterval: ReturnType<typeof setInterval> | null = null;
let lastAutoScreenshotTime = 0;

export interface AutoScreenshotState {
  enabled: boolean;
  intervalSeconds: number;
  lastScreenshotTime: number;
}

/**
 * Get the current auto-screenshot state
 */
export function getAutoScreenshotState(): AutoScreenshotState {
  return {
    enabled: autoScreenshotEnabled,
    intervalSeconds: 0, // Set by the caller
    lastScreenshotTime: lastAutoScreenshotTime,
  };
}

/**
 * Enable auto-screenshot mode
 */
export function enableAutoScreenshot(): void {
  autoScreenshotEnabled = true;
  lastAutoScreenshotTime = Date.now();
  console.log("[Symbio] Auto-screenshot: ENABLED");
}

/**
 * Disable auto-screenshot mode
 */
export function disableAutoScreenshot(): void {
  autoScreenshotEnabled = false;
  if (autoScreenshotInterval) {
    clearInterval(autoScreenshotInterval);
    autoScreenshotInterval = null;
  }
  console.log("[Symbio] Auto-screenshot: DISABLED");
}

/**
 * Check if auto-screenshot mode is currently enabled
 */
export function isAutoScreenshotEnabled(): boolean {
  return autoScreenshotEnabled;
}

/**
 * Mark that an auto-screenshot was just taken
 */
export function markAutoScreenshotTaken(): void {
  lastAutoScreenshotTime = Date.now();
}

/**
 * Check if enough time has passed since the last auto-screenshot
 */
export function canTakeAutoScreenshot(intervalSeconds: number): boolean {
  if (!autoScreenshotEnabled) return false;
  const elapsed = (Date.now() - lastAutoScreenshotTime) / 1000;
  return elapsed >= intervalSeconds;
}

/**
 * Parse companion text for auto-screenshot enable/disable commands.
 * Returns:
 *   "enable" — companion wants to start auto-screenshot mode
 *   "disable" — companion wants to stop auto-screenshot mode
 *   null — no auto-screenshot command detected
 */
export function parseAutoScreenshotCommand(text: string): "enable" | "disable" | null {
  const lower = text.toLowerCase();

  // If the prompt is from the system auto-screenshot message, skip parsing it entirely.
  // This prevents infinite loops from "I'm still watching" matching "watching" phrases.
  if (lower.includes("auto-screenshot:") || lower.includes("i'm still watching")) {
    return null;
  }

  // Check disable phrases first (more specific)
  for (const phrase of AUTO_SCREENSHOT_DISABLE) {
    if (lower.includes(phrase)) {
      return "disable";
    }
  }

  // Check enable phrases
  for (const phrase of AUTO_SCREENSHOT_ENABLE) {
    if (lower.includes(phrase)) {
      return "enable";
    }
  }

  return null;
}