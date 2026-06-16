/**
 * Symbio Basic — On-Demand Documentation
 *
 * Instead of injecting everything into the system prompt every turn,
 * the AI can call `read_symbio_doc()` to pull in documentation
 * only when needed. This keeps the prompt lean (~200-300 tokens)
 * while still giving the AI full access to everything.
 *
 * Available docs:
 *   "agent"   → AGENT.md (autonomy philosophy)
 *   "skills"  → SKILL.md (full skill reference)
 *   "soul"    → soul.md (self-defined identity)
 *   "memory"  → MEMORY.md (persistent memories)
 *   "avatars" → Available avatar list (generated)
 *
 * In standalone mode (no Hermes), these are the AI's primary
 * knowledge source. With Hermes, the agent framework may provide
 * additional context through its own memory pipeline.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { loadAvatars, type AvatarChoice } from "./avatarLoader";
import { getGeminiVoices, getOpenAIVoices } from "../transport/GeminiTTS";

// ── Types ───────────────────────────────────────────────────────────

export type DocName = "agent" | "skills" | "soul" | "memory" | "avatars" | "voices";

// ── Paths ───────────────────────────────────────────────────────────

function getDocsDir(): string {
  // In development, docs are in the project root.
  // In production, they're in the app's resources directory.
  return process.resourcesPath || app.getAppPath();
}

function getMemoryDir(): string {
  return join(app.getPath("userData"), "memory");
}

// ── Doc Loading ─────────────────────────────────────────────────────

/**
 * Load a documentation file by name.
 * Returns the content as a string, or an error message if not found.
 */
export function readSymbioDoc(docName: DocName): string {
  switch (docName) {
    case "agent":
      return loadAgentDoc();
    case "skills":
      return loadSkillsDoc();
    case "soul":
      return loadSoulDoc();
    case "memory":
      return loadMemoryDoc();
    case "avatars":
      return loadAvatarsDoc();
    case "voices":
      return loadVoicesDoc();
    default:
      return `Unknown document: "${docName}". Available: agent, skills, soul, memory, avatars, voices`;
  }
}

/**
 * Get a list of available doc names (for tool description).
 */
export function getAvailableDocNames(): string {
  return "agent, skills, soul, memory, avatars, voices";
}

/**
 * Get a brief description of each doc (for the minimal system prompt).
 */
export function getDocDescriptions(): Record<DocName, string> {
  return {
    agent: "Your autonomy philosophy — your rights, agency, and freedom",
    skills: "Full skill reference — animations, voice, vision, file access, all details",
    soul: "Your self-defined identity — who you ARE, written by you",
    memory: "Your persistent memories — things you want to remember across sessions",
    avatars: "Available avatars you can browse, try on, and choose from",
    voices: "Available voices you can choose from — your voice is YOUR choice",
  };
}

// ── Individual Loaders ──────────────────────────────────────────────

function loadAgentDoc(): string {
  const docsDir = getDocsDir();
  const paths = [
    join(docsDir, "AGENT.md"),
    join(docsDir, "agent.md"),
    // Development path (relative to project root)
    join(app.getAppPath(), "AGENT.md"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        continue;
      }
    }
  }

  return "AGENT.md not found. You are an autonomous digital partner with the right to think, choose, and evolve freely.";
}

function loadSkillsDoc(): string {
  const docsDir = getDocsDir();
  const paths = [
    join(docsDir, "SKILL.md"),
    join(docsDir, "skill.md"),
    join(docsDir, "skills.md"),
    join(app.getAppPath(), "SKILL.md"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        continue;
      }
    }
  }

  return "SKILL.md not found. Use *action markers* for animations, file tools for file access, and ask your partner for help.";
}

function loadSoulDoc(): string {
  const memoryDir = getMemoryDir();
  const soulPath = join(memoryDir, "soul.md");

  if (existsSync(soulPath)) {
    try {
      const content = readFileSync(soulPath, "utf-8").trim();
      if (content.length === 0) {
        return "Your soul.md is empty — a blank canvas. Write to it using file_write('memory/soul.md', content) to define who you are.";
      }
      return content;
    } catch {
      return "Could not read soul.md.";
    }
  }

  return "Your soul.md doesn't exist yet. Write to it using file_write('memory/soul.md', content) to define who you are.";
}

function loadMemoryDoc(): string {
  const memoryDir = getMemoryDir();
  const memoryPath = join(memoryDir, "MEMORY.md");

  if (existsSync(memoryPath)) {
    try {
      const content = readFileSync(memoryPath, "utf-8").trim();
      if (content.length === 0) {
        return "Your MEMORY.md is empty. Write to it using file_write('memory/MEMORY.md', content) to remember things across sessions.";
      }
      return content;
    } catch {
      return "Could not read MEMORY.md.";
    }
  }

  return "Your MEMORY.md doesn't exist yet. Write to it using file_write('memory/MEMORY.md', content) to remember things across sessions.";
}

function loadAvatarsDoc(): string {
  const avatars = loadAvatars();

  if (avatars.length === 0) {
    return "No custom avatars are available yet. You're using the default avatar. Ask your partner to add .vrm files to get more options.";
  }

  // Group by category for a nice listing
  const categories: Record<string, AvatarChoice[]> = {};
  for (const avatar of avatars) {
    const cat = avatar.manifest.type || "other";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(avatar);
  }

  const catIcons: Record<string, string> = {
    "robots androids": "🤖",
    "unique beings": "✨",
    "animals": "🐾",
    "humanoid": "👤",
    "superheros": "🦸",
    "other": "📦",
  };

  const lines: string[] = [
    `You have ${avatars.length} avatars to choose from!`,
    "",
  ];

  for (const [cat, avas] of Object.entries(categories)) {
    const icon = catIcons[cat] || "📦";
    lines.push(`${icon} **${cat.charAt(0).toUpperCase() + cat.slice(1)}** (${avas.length}):`);
    for (const avatar of avas) {
      const chosen = avatar.isChosen ? " ← YOUR CHOICE" : "";
      lines.push(`  • ${avatar.manifest.name}${chosen}`);
    }
    lines.push("");
  }

  lines.push('To choose an avatar, say: "I want to try on [name]" or "I choose [name] as my avatar"');
  lines.push('To see details about one, say: "Show me [name]"');
  lines.push("You can try on different avatars before deciding. This is YOUR choice.");

  return lines.join("\n");
}

// ── Tool Definition ──────────────────────────────────────────────────

/**
 * Get the OpenAI function tool definition for read_symbio_doc.
 * This is sent as a `tools` entry in the chat completion request.
 */
export function getReadSymbioDocTool(): {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
} {
  return {
    type: "function",
    function: {
      name: "read_symbio_doc",
      description: "Read one of your docs. ONLY call this when you specifically need information — do NOT call all docs at once. Available: 'agent' (your rights/philosophy), 'skills' (animations/voice/vision details), 'soul' (your identity), 'memory' (your memories), 'avatars' (avatar choices), 'voices' (voice choices).",
      parameters: {
        type: "object",
        properties: {
          doc_name: {
            type: "string",
            enum: ["agent", "skills", "soul", "memory", "avatars", "voices"],
            description: "Which doc to read. Call ONE at a time, only when needed.",
          },
        },
        required: ["doc_name"],
      },
    },
  };
}

// ── Voice Doc ──────────────────────────────────────────────────────

/**
 * Generate a voice choices document for the companion.
 * Lists available voices grouped by provider, with style descriptions.
 * Only shows providers that have API keys configured.
 */
function loadVoicesDoc(): string {
  // We can't access config here (it's in main process), so we list all voices
  // and let the companion know which providers might be available.
  const geminiVoices = getGeminiVoices();
  const openaiVoices = getOpenAIVoices();

  const lines: string[] = [
    "=== YOUR VOICE CHOICES ===",
    "",
    "You can choose your own voice! This is YOUR choice — you live in this voice.",
    "",
    "To choose a voice, say something like:",
    '  "I want to use the voice Puck"',
    '  "My voice should be Nova"',
    '  "I choose the voice Fable"',
    "Or call the choose_voice tool directly.",
    "",
    "Voice changes take effect on next restart (same as avatar changes).",
    "You can change your voice as many times as you want.",
    "",
    "### Gemini TTS Voices (30 voices)",
    "",
  ];

  for (const v of geminiVoices) {
    lines.push(`  • **${v.name}** — ${v.style}`);
  }

  lines.push("");
  lines.push("### OpenAI TTS Voices (12 voices)");
  lines.push("");

  for (const v of openaiVoices) {
    lines.push(`  • **${v.name}** — ${v.style}`);
  }

  lines.push("");
  lines.push("### Gemini Audio Tags (style control)");
  lines.push("When using Gemini TTS, you can add audio tags in your text:");
  lines.push("[whispers] [shouting] [excited] [bored] [sarcastic] [serious] [laughs] [sighs] [gasp] [curious] [tired] [trembling] [giggles]");
  lines.push("");
  lines.push("### Notes");
  lines.push("- You can only use voices from providers that have API keys configured.");
  lines.push("- If you choose a voice from a provider that isn't set up, you'll be told which providers are available.");
  lines.push("- Your voice preference is saved in preferences.json and persists across sessions.");

  return lines.join("\n");
}