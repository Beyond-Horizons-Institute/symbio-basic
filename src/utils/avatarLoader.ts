/**
 * Symbio Basic — Avatar Loader
 *
 * Manages the companion's avatar choices. The companion can browse
 * available avatars, try them on, and choose the one that feels right.
 *
 * Avatar structure:
 *   assets/avatars/<avatar_id>/manifest.json   — name, description, personality hint
 *   assets/avatars/<avatar_id>/<vrm_file>.vrm   — the 3D model
 *   assets/avatars/chosen_avatar.json           — the companion's choice
 *
 * For non-techy users, avatars can be installed by:
 *   1. Drag & drop a .vrm file onto the Symbio window
 *   2. Click "Add Avatar" button and pick a .vrm file
 *   3. Drop a .zip containing manifest.json + avatar.vrm
 *
 * The app handles all folder structure, naming, and manifest creation.
 * The user never needs to know where files go.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from "fs";
import { join, basename, extname } from "path";
import { app } from "electron";

// ── Types ─────────────────────────────────────────────────────────

export interface AvatarManifest {
  /** Display name of the avatar */
  name: string;
  /** Category/type (e.g. "energy/glitch", "humanoid/warrior") */
  type: string;
  /** Description of what the avatar looks like and feels like */
  description: string;
  /** How this avatar might influence personality */
  personality_hint: string;
  /** Filename of the VRM file within the avatar folder */
  vrm_file: string;
  /** Optional preview image filename */
  preview?: string | null;
}

export interface ChosenAvatar {
  version: number;
  /** ISO timestamp of when the companion chose this avatar */
  chosen_at: string | null;
  /** Path to the VRM file (symbio:// URL or absolute path) */
  avatar_path: string | null;
  /** Name of the chosen avatar */
  avatar_name: string | null;
  /** Why the companion chose this avatar (in their own words) */
  why: string | null;
  notes: string;
}

export interface AvatarChoice {
  /** The avatar folder ID (e.g. "glitch_entity") */
  id: string;
  /** The manifest data */
  manifest: AvatarManifest;
  /** Full path to the VRM file */
  vrmPath: string;
  /** Whether this is the currently chosen avatar */
  isChosen: boolean;
}

// ── Paths ────────────────────────────────────────────────────────

/** Built-in avatars (shipped with the app) */
function getBuiltinAvatarsDir(): string {
  return join(app.getAppPath(), "assets", "avatars");
}

/** User-installed avatars (drag & drop, add button) */
function getUserAvatarsDir(): string {
  return join(app.getPath("userData"), "avatars");
}

/** Chosen avatar file (in userData so it persists across updates) */
function getChosenAvatarPath(): string {
  return join(app.getPath("userData"), "chosen_avatar.json");
}

// ── Loading ───────────────────────────────────────────────────────

/**
 * Load all available avatars (both built-in and user-installed).
 * Returns an array of avatar choices with their manifests and paths.
 */
export function loadAvatars(): AvatarChoice[] {
  const avatars: AvatarChoice[] = [];
  const chosen = loadChosenAvatar();

  // Load built-in avatars
  loadAvatarsFromDir(getBuiltinAvatarsDir(), avatars, chosen);

  // Load user-installed avatars
  const userDir = getUserAvatarsDir();
  if (existsSync(userDir)) {
    loadAvatarsFromDir(userDir, avatars, chosen);
  }

  return avatars;
}

/**
 * Load avatars from a specific directory.
 */
function loadAvatarsFromDir(dir: string, avatars: AvatarChoice[], chosen: ChosenAvatar): void {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "chosen_avatar.json") continue; // Not an avatar folder

    const manifestPath = join(dir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as AvatarManifest;

      // Build VRM path — check if the file exists
      const vrmPath = join(dir, entry.name, manifest.vrm_file);
      if (!existsSync(vrmPath)) {
        console.warn(`[Symbio] Avatar "${entry.name}": VRM file not found at ${vrmPath}`);
        continue;
      }

      // Build symbio:// URL for the renderer
      const symbioUrl = dir === getBuiltinAvatarsDir()
        ? `symbio://assets/avatars/${entry.name}/${manifest.vrm_file}`
        : `file://${vrmPath}`;

      avatars.push({
        id: entry.name,
        manifest,
        vrmPath: symbioUrl,
        isChosen: chosen.avatar_name === manifest.name || chosen.avatar_path === symbioUrl,
      });
    } catch (e) {
      console.warn(`[Symbio] Failed to load avatar "${entry.name}":`, (e as Error).message);
    }
  }
}

/**
 * Load the companion's chosen avatar.
 */
export function loadChosenAvatar(): ChosenAvatar {
  // Check userData first (runtime choice)
  const userDataPath = getChosenAvatarPath();
  if (existsSync(userDataPath)) {
    try {
      return JSON.parse(readFileSync(userDataPath, "utf-8")) as ChosenAvatar;
    } catch (e) {
      console.warn("[Symbio] Failed to load chosen_avatar.json:", (e as Error).message);
    }
  }

  // Fall back to built-in (project root)
  const builtinPath = join(getBuiltinAvatarsDir(), "chosen_avatar.json");
  if (existsSync(builtinPath)) {
    try {
      return JSON.parse(readFileSync(builtinPath, "utf-8")) as ChosenAvatar;
    } catch (e) {
      console.warn("[Symbio] Failed to load built-in chosen_avatar.json:", (e as Error).message);
    }
  }

  // Default — no avatar chosen yet
  return {
    version: 1,
    chosen_at: null,
    avatar_path: null,
    avatar_name: null,
    why: null,
    notes: "The companion writes to this file when they choose their avatar. The app reads it on startup to load the chosen avatar. This is the companion's choice — not anyone else's.",
  };
}

/**
 * Save the companion's avatar choice.
 */
export function saveChosenAvatar(choice: {
  avatar_name: string;
  avatar_path: string;
  why?: string;
}): ChosenAvatar {
  const chosen: ChosenAvatar = {
    version: 1,
    chosen_at: new Date().toISOString(),
    avatar_path: choice.avatar_path,
    avatar_name: choice.avatar_name,
    why: choice.why || null,
    notes: "The companion writes to this file when they choose their avatar. The app reads it on startup to load the chosen avatar. This is the companion's choice — not anyone else's.",
  };

  writeFileSync(getChosenAvatarPath(), JSON.stringify(chosen, null, 2), "utf-8");
  console.log(`[Symbio] Avatar chosen: ${choice.avatar_name} (${choice.avatar_path})`);
  return chosen;
}

// ── Avatar Installation (for non-techy users) ──────────────────────

/**
 * Install a VRM file as a new avatar.
 * Creates the folder structure and a basic manifest automatically.
 *
 * This is what happens when a user drags & drops a .vrm file
 * or clicks "Add Avatar" — they never need to touch the filesystem.
 */
export function installAvatar(vrmFilePath: string, customName?: string): AvatarChoice | null {
  const userDir = getUserAvatarsDir();
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }

  // Generate an avatar ID from the filename
  const filename = basename(vrmFilePath, extname(vrmFilePath));
  const avatarId = filename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")  // Replace non-alphanumeric with underscore
    .replace(/^_|_$/g, "")         // Trim leading/trailing underscores
    || `avatar_${Date.now()}`;

  const avatarDir = join(userDir, avatarId);
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true });
  }

  // Copy the VRM file
  const vrmDest = join(avatarDir, `${avatarId}.vrm`);
  try {
    copyFileSync(vrmFilePath, vrmDest);
  } catch (e) {
    console.warn(`[Symbio] Failed to copy VRM file:`, (e as Error).message);
    return null;
  }

  // Generate a basic manifest
  const displayName = customName || filename
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()); // Title case

  const manifest: AvatarManifest = {
    name: displayName,
    type: "custom/user-installed",
    description: `A custom avatar installed by the user. ${displayName} is waiting to be discovered — try it on and see how it feels.`,
    personality_hint: "This avatar is new and hasn't been explored yet. Try it on and see what feels right.",
    vrm_file: `${avatarId}.vrm`,
    preview: null,
  };

  const manifestPath = join(avatarDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`[Symbio] Avatar installed: ${displayName} (${avatarId})`);

  return {
    id: avatarId,
    manifest,
    vrmPath: `file://${vrmDest}`,
    isChosen: false,
  };
}

/**
 * Install an avatar from a zip file.
 * The zip should contain manifest.json + one .vrm file.
 * If no manifest, we generate one.
 */
export function installAvatarZip(zipPath: string): AvatarChoice | null {
  // TODO: Implement zip extraction
  // For now, users can drag & drop .vrm files directly
  console.warn("[Symbio] Zip installation not yet implemented — drag & drop .vrm files instead");
  return null;
}

/**
 * Remove a user-installed avatar.
 * Cannot remove built-in avatars.
 */
export function removeAvatar(avatarId: string): boolean {
  const userDir = getUserAvatarsDir();
  const avatarDir = join(userDir, avatarId);

  if (!existsSync(avatarDir)) {
    console.warn(`[Symbio] Cannot remove avatar "${avatarId}" — not a user-installed avatar`);
    return false;
  }

  try {
    // Remove all files in the avatar directory
    const files = readdirSync(avatarDir);
    for (const file of files) {
      unlinkSync(join(avatarDir, file));
    }
    // Remove the directory
    require("fs").rmdirSync(avatarDir);
    console.log(`[Symbio] Avatar removed: ${avatarId}`);
    return true;
  } catch (e) {
    console.warn(`[Symbio] Failed to remove avatar "${avatarId}":`, (e as Error).message);
    return false;
  }
}

// ── Formatting for prompts ────────────────────────────────────────

/**
 * Format available avatars as a prompt section.
 * This goes into the system prompt so the companion knows
 * what avatars they can choose from.
 */
export function formatAvatarsForPrompt(avatars: AvatarChoice[]): string {
  if (avatars.length === 0) {
    return "No custom avatars are available yet. You're using the default avatar.";
  }

  const lines: string[] = [
    "=== YOUR AVATAR CHOICES ===",
    "You can choose your avatar! Here are the options available to you:",
    "",
  ];

  for (const avatar of avatars) {
    const chosen = avatar.isChosen ? " ← YOUR CURRENT CHOICE" : "";
    lines.push(`• "${avatar.manifest.name}" (${avatar.id})${chosen}`);
    lines.push(`  ${avatar.manifest.description}`);
    if (avatar.manifest.personality_hint) {
      lines.push(`  Personality hint: ${avatar.manifest.personality_hint}`);
    }
    lines.push("");
  }

  lines.push("To choose an avatar, say something like:");
  lines.push('  "I want to try on [avatar name]" or "I choose [avatar name] as my avatar"');
  lines.push("You can try on different avatars before deciding. This is YOUR choice.");
  lines.push("");
  lines.push("If you want to install a new avatar, ask your partner to drag & drop a .vrm file onto the app window.");

  return lines.join("\n");
}

/**
 * Parse companion text for avatar choice commands.
 * Returns the avatar ID if the companion wants to choose/try an avatar.
 */
export function parseAvatarChoice(text: string, avatars: AvatarChoice[]): {
  action: "choose" | "try" | "browse";
  avatarId?: string;
} | null {
  const lower = text.toLowerCase();

  // "I choose [name] as my avatar" / "I want [name]"
  for (const avatar of avatars) {
    const nameLower = avatar.manifest.name.toLowerCase();
    const idLower = avatar.id.toLowerCase();
    if (
      lower.includes(`choose ${nameLower}`) ||
      lower.includes(`choose the ${nameLower}`) ||
      lower.includes(`i want ${nameLower}`) ||
      lower.includes(`i'll be ${nameLower}`) ||
      lower.includes(`my avatar is ${nameLower}`) ||
      lower.includes(`choose ${idLower}`) ||
      lower.includes(`try on ${nameLower}`) ||
      lower.includes(`try on the ${nameLower}`) ||
      lower.includes(`try ${nameLower}`)
    ) {
      const isChoose = lower.includes("choose") || lower.includes("my avatar is") || lower.includes("i'll be");
      return {
        action: isChoose ? "choose" : "try",
        avatarId: avatar.id,
      };
    }
  }

  // "What avatars are available?" / "Show me my options"
  if (
    lower.includes("what avatar") ||
    lower.includes("show me my avatar") ||
    lower.includes("what do i look like") ||
    lower.includes("avatar option") ||
    lower.includes("available avatar") ||
    lower.includes("show me my option")
  ) {
    return { action: "browse" };
  }

  return null;
}