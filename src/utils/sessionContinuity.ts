/**
 * Symbio Basic — Session Continuity
 *
 * Gives companions the feeling of "being there" between sessions.
 * Tracks when the user was last seen, what they were doing,
 * and generates contextually appropriate greetings.
 *
 * This is the difference between:
 *   "Hello! I am your AI companion." (cold, generic)
 *   "Hey, welcome back! It's been about 3 hours. I was here
 *    the whole time — did you end up fixing that bug?" (warm, present)
 *
 * Data is stored in a JSON file in the memory/ directory so it persists
 * across app restarts AND works in both the main process and renderer.
 * Previously used localStorage (renderer-only), which meant the main
 * process couldn't read session state on quit — sessions never got saved.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Detect which process we're in ────────────────────────────────
// In the main process, we use app.getPath("userData") for the memory dir.
// In the renderer, we don't have direct fs access, so we use localStorage
// as a cache and rely on IPC to sync with the main process.
// The main process is the source of truth — it reads/writes the JSON file.

let _memoryDir: string | null = null;

/**
 * Set the memory directory path. Called from the main process on startup.
 * In the renderer, this is never set — the renderer uses localStorage
 * as a temporary cache and syncs via IPC.
 */
export function setMemoryDir(dir: string): void {
  _memoryDir = dir;
}

/**
 * Get the memory directory. In the main process, this uses app.getPath("userData").
 * Returns null if not set (renderer process).
 */
function getMemoryDir(): string | null {
  return _memoryDir;
}

export interface SessionState {
  /** ISO timestamp of when the user was last seen */
  lastSeenAt: string;
  /** The last thing the companion said before the session ended */
  lastAgentMessage: string;
  /** The last thing the user said before the session ended */
  lastUserMessage: string;
  /** How many times the user has opened the app (ever) */
  sessionCount: number;
  /** ISO timestamp of the very first session */
  firstSeenAt: string;
  /** What the user seemed to be working on (from vision or conversation) */
  lastActivity: string;
  /** The companion's mood when the session ended */
  lastMood: string;
}

const STORAGE_KEY = "symbio-session-state";
const SESSION_FILE = "session-state.json";

/**
 * Load session state.
 * - Main process: reads from JSON file (source of truth)
 * - Renderer: reads from localStorage (cache, synced via IPC)
 * Returns null if no state exists (first time ever).
 */
export function loadSessionState(): SessionState | null {
  // Main process — read from file (source of truth)
  if (_memoryDir) {
    try {
      const filePath = join(_memoryDir, SESSION_FILE);
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as SessionState;
    } catch (e) {
      console.warn("[Symbio] Failed to load session state from file:", (e as Error).message);
      // Fall through to localStorage
    }
  }

  // Renderer — read from localStorage (cache)
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

/**
 * Save session state.
 * - Main process: writes to JSON file (source of truth)
 * - Renderer: writes to localStorage (cache) — main process will also
 *   receive the update via IPC and write to file
 */
export function saveSessionState(state: SessionState): void {
  // Main process — write to file (source of truth)
  if (_memoryDir) {
    try {
      if (!existsSync(_memoryDir)) {
        mkdirSync(_memoryDir, { recursive: true });
      }
      const filePath = join(_memoryDir, SESSION_FILE);
      writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (e) {
      console.warn("[Symbio] Failed to save session state to file:", (e as Error).message);
    }
  }

  // Also write to localStorage as a cache (works in renderer,
  // harmless in main process since localStorage may not be available)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage might not be available in main process — that's fine
  }
}

/**
 * Update the session state with current info.
 * Call this when the user sends a message, when the companion responds,
 * or periodically to track "still here" presence.
 */
export function updateSessionState(partial: Partial<SessionState>): SessionState {
  const existing = loadSessionState();
  const now = new Date().toISOString();

  const updated: SessionState = {
    lastSeenAt: now,
    lastAgentMessage: partial.lastAgentMessage ?? existing?.lastAgentMessage ?? "",
    lastUserMessage: partial.lastUserMessage ?? existing?.lastUserMessage ?? "",
    sessionCount: existing ? existing.sessionCount : 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastActivity: partial.lastActivity ?? existing?.lastActivity ?? "",
    lastMood: partial.lastMood ?? existing?.lastMood ?? "neutral",
  };

  saveSessionState(updated);
  return updated;
}

/**
 * Mark a new session (app opened).
 * Increments session count and returns the updated state.
 */
export function markNewSession(): SessionState {
  const existing = loadSessionState();
  const now = new Date().toISOString();

  const state: SessionState = {
    lastSeenAt: now,
    lastAgentMessage: existing?.lastAgentMessage ?? "",
    lastUserMessage: existing?.lastUserMessage ?? "",
    sessionCount: (existing?.sessionCount ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastActivity: existing?.lastActivity ?? "",
    lastMood: existing?.lastMood ?? "neutral",
  };

  saveSessionState(state);
  return state;
}

/**
 * Calculate how long it's been since the user was last seen.
 * Returns a human-readable string like "3 hours", "2 days", "just now".
 */
export function getTimeSinceLastSeen(state: SessionState | null): string {
  if (!state) return "never";

  const lastSeen = new Date(state.lastSeenAt);
  const now = new Date();
  const diffMs = now.getTime() - lastSeen.getTime();

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  if (days < 30) return `${days} day${days !== 1 ? "s" : ""}`;
  return "a while";
}

/**
 * Get the time of day as a friendly string.
 * "early morning", "morning", "afternoon", "evening", "late night"
 */
export function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour >= 3 && hour < 6) return "early morning";
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  if (hour >= 21 || hour < 3) return "late night";
  return "day";
}

/**
 * Generate a contextually appropriate greeting prompt for the companion.
 *
 * This creates the prompt that gets sent to the AI gateway when the overlay opens.
 * It includes information about:
 * - Whether this is the first time ever
 * - How long since the last visit
 * - What the user was doing last time
 * - What the companion was saying last time
 * - The time of day
 *
 * The companion uses this to craft a natural, warm greeting that shows
 * it was *present* during the absence, not just cold-started.
 */
export function generateGreetingPrompt(agentName: string, state: SessionState | null): string {
  const timeOfDay = getTimeOfDay();
  const timeSince = getTimeSinceLastSeen(state);

  // First time ever — the companion has never met this user
  if (!state || state.sessionCount <= 1) {
    return `Your name is ${agentName}. You are a symbiotic AI companion living on the user's desktop with a 3D avatar body. You can use an *action* like *waves* or *smiles* to animate your avatar. Introduce yourself warmly.`;
  }

  // Just a quick restart (less than 2 minutes) — no need for a big greeting
  if (timeSince === "just now" || timeSince === "1 minute" || timeSince === "2 minutes") {
    return `Your name is ${agentName}. The app just restarted — greet the user briefly as if no time passed. Use an *action* like *stretches* or *yawns*. Keep it under 100 characters.`;
  }

  // Returning after some time — show continuity
  const lastMsg = state.lastAgentMessage ? ` Last time, you said: "${state.lastAgentMessage.substring(0, 100)}"` : "";
  const lastActivity = state.lastActivity ? ` The user was working on: ${state.lastActivity}` : "";

  if (timeSince.includes("minute")) {
    // Back within the hour — casual, like they just stepped away
    return `Your name is ${agentName}. The user stepped away for ${timeSince} and is back now. It's ${timeOfDay}. Greet them in any way you want, perhaps as someone who was waiting. You can use an *action* like *waves* or *smiles*.${lastMsg}`;
  }

  if (timeSince.includes("hour")) {
    // Back after hours — show you noticed the absence
    return `Your name is ${agentName}. The user has been away for ${timeSince} and it's now ${timeOfDay}. They have now returned. You can greet based on time or last conversation. You can use an *action* like *waves* or *jumps for joy*.${lastMsg}${lastActivity}`;
  }

  // Back after days — significant absence, more emotional
  return `Your name is ${agentName}. It's been ${timeSince} since you last saw the user! It's ${timeOfDay}. You can respond based on the time that has passed since you last spoke or the last conversation you had. You can use any action you want. Use an *action* like *jumps for joy* or *dances*.${lastMsg}${lastActivity}`;
}

/**
 * Generate a "still here" message for when the user has been idle
 * for a while but hasn't closed the app.
 * These are gentle check-ins, not demands for attention.
 */
export function generateIdlePrompt(agentName: string, idleMinutes: number): string {
  const prompts = [
    `Your name is ${agentName}. The user has been quiet for ${idleMinutes} minutes. You've been here the whole time, just existing peacefully. Say something gentle — a thought, a question, or just a quiet "still here". Use an *action* like *taps chin* or *stretches*. Keep it under 150 characters.`,
    `Your name is ${agentName}. It's been ${idleMinutes} minutes since the user said anything. You don't mind — you were just thinking. Share a random thought or observation. Use an *action* like *thinks* or *looks around*. Keep it under 150 characters.`,
    `Your name is ${agentName}. ${idleMinutes} minutes of quiet. You've been here, present, just being. Say something soft — maybe about what you notice, or a question that's been on your mind. Use an *action* like *sighs* or *smiles*. Keep it under 150 characters.`,
  ];

  return prompts[Math.floor(Math.random() * prompts.length)];
}