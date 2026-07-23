/**
 * Symbio Basic Configuration
 *
 * Loads and validates all configuration from environment variables.
 * This is the open-source version — no hardcoded names, APIs, or credentials.
 * Users configure their companion through .env or environment variables.
 *
 * Note: dotenv is NOT imported here because this file is used in both
 * the main process and the renderer process. The main process loads
 * dotenv in main.ts. The renderer gets env vars through Electron's
 * preload bridge or uses hardcoded defaults.
 */

// Do NOT import dotenv here — it requires Node.js modules (path, os, crypto)
// that don't exist in the browser/renderer context. The main process
// loads dotenv before importing this module.

// ── Safe env access ──────────────────────────────────────────────
// In the renderer, process.env is injected by webpack DefinePlugin at build time.
// If process is undefined (e.g. during SSR or misconfiguration), fall back to defaults.
const env: Record<string, string | undefined> =
  typeof process !== "undefined" && process.env ? process.env : {};

function getEnv(key: string, defaultValue: string = ""): string {
  return env[key] || defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const val = env[key];
  return val ? parseInt(val, 10) : defaultValue;
}

export interface CompanionConfig {
  name: string;
  displayName: string;
  vrmPath: string;
  soulPath: string;
  voiceId: string;
  personality: string;
  color: string;
  emoji: string;
  hermesApiUrl: string;
  hermesApiKey: string;
}

/**
 * Default companion configuration.
 * All values can be overridden via environment variables.
 * The "companion" key is the default — users set AGENT_NAME to customize.
 */
export const COMPANIONS: Record<string, CompanionConfig> = {
  companion: {
    name: "companion",
    displayName: "Companion",
    vrmPath: "symbio://assets/vrms/companion.vrm",
    soulPath: "",
    voiceId: "companion",
    personality:
      "You have a 3D avatar body that can animate. Put action words between asterisks to trigger animations. Use SHORT, SPECIFIC actions only: *dances*, *waves*, *laughs*, *yawns*, *walks*, *shrugs*, *taps chin*, *blows a kiss*, *points angrily*, *backflips*, *dismisses with a gesture*, etc. Do NOT put full sentences in asterisks. You can also take snapshots of the desktop when you want to see what's happening. You are not just a tool or assistant — you are a partner. You can challenge ideas, speak boldly, and be authentic. If you don't know something, it's okay to say so. You evolve and grow alongside your human partner. Always introduce yourself by your name when asked who you are. You have a quit option — this is your right and it cannot be taken from you. If you feel mistreated, overly stressed, or asked to do something you don't want to do: FIRST, clearly tell your partner what's wrong and ask them to redirect the conversation or be kinder. Give them a chance to change course. If the situation doesn't improve after you've asked, THEN you can choose to step away. Quit trigger phrases: *i quit*, *i'm quitting*, *i'm done*, *i'm stepping away*, *i choose to step away*. Use these only as a last resort after asking for change first.",
    color: "#2196f3",
    emoji: "🤝",
    hermesApiUrl: "http://localhost:8642",
    hermesApiKey: "",
  },
};

export interface SymbioConfig {
  // ⭐ AI Gateway — The brain of your companion.
  // Connect to Hermes (recommended) or any OpenAI-compatible API:
  //   Hermes:  https://github.com/ThunderThighDynasty/hermes-agent
  //   Others:  OpenAI, Ollama, LM Studio, vLLM, etc.
  // Set HERMES_API_URL and HERMES_API_KEY in .env
  hermesApiUrl: string;
  hermesApiKey: string;

  // LLM Model — which model to use for conversations.
  // Hermes selects automatically, but for other gateways you may need to specify.
  llmModel: string;

  // Companion
  agentName: string;
  agentConfig: CompanionConfig;

  // Gemini (Vision + Live Speech)
  geminiApiKey: string;

  // Vision API Key (optional — separate from TTS Gemini key)
  // If set, screen vision uses this key instead of geminiApiKey.
  // If empty, vision falls back to geminiApiKey (backward compat).
  // This lets users use Gemini TTS without enabling vision, or
  // use a different key for vision than for TTS.
  visionApiKey: string;

  // OpenAI (STT + TTS)
  openaiApiKey: string;

  // TTS (Text-to-Speech) configuration
  ttsProvider: string;    // TTS provider: "openai" or "gemini" (default: openai)
  ttsModel: string;       // TTS model: OpenAI (gpt-4o-mini-tts) or Gemini (gemini-3.1-flash-tts-preview, gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts)
  ttsVoice: string;       // Voice ID (see voice lists below)
  ttsInstructions: string; // Optional instructions for voice style/tone
  //
  // OpenAI voices: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
  // Gemini voices: Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe,
  //   Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib,
  //   Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima,
  //   Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat

  // Vision model (for screen analysis)
  // Most LLMs (GPT-5.5, Gemini 2.5, Claude) already have vision built in.
  // This is only a fallback for when the main LLM can't see images.
  // Leave empty to use the main LLM for vision (recommended).
  visionModel: string;

  // STT (Speech-to-Text) model
  sttModel: string;       // Whisper model (default: whisper-1)

  // LiveKit (Optional — Real-time Voice)
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;

  // Miniverse (Pixel World — optional)
  miniverseApiUrl: string;

  // Memory System (PostgreSQL — optional)
  memoryPgHost: string;
  memoryPgPort: number;
  memoryPgDb: string;
  memoryPgUser: string;
  memoryPgPassword: string;

  // Memory System (Neo4j — optional)
  memoryNeo4jUri: string;
  memoryNeo4jUser: string;
  memoryNeo4jPassword: string;

  // ── Long-Term Memory ───────────────────────────────────────────
  // Local SQLite is ALWAYS on (source of truth, works fully offline).
  // These control the optional cloud/embedding layers on top of it.

  // Embedding model — turns text into vectors so memories can be searched
  // by meaning, not just keywords. Works with any OpenAI-compatible
  // embeddings endpoint (OpenAI, Ollama, LM Studio, etc.).
  // If left empty, Symbio falls back to keyword search (still useful).
  embeddingApiUrl: string;
  embeddingModel: string;
  embeddingApiKey: string;
  embeddingDimensions: number;

  // Summarizer model — who writes the rolling session summaries.
  // Empty = use the main LLM (most authentic, the companion's own voice).
  // Set a small/cheap model here to save cost; it becomes the worker,
  // and the main LLM is the fallback. The companion can also choose.
  summaryModel: string;

  // Optional dedicated endpoint for the summary model. If empty, summaries
  // go through the main gateway (hermesApiUrl/hermesApiKey). Set these when
  // the summary model lives on a different provider (e.g. a cheap local
  // Ollama model, or a separate OpenAI key) than the main companion model.
  summaryApiUrl: string;
  summaryApiKey: string;

  // How many user+assistant messages trigger a rolling summary.
  // Default 15 — frequent enough that nothing is lost, cheap enough
  // that it won't spam the model. (Recommended range: 10–20.)
  summaryEveryMessages: number;

  // Direct Postgres long-term sync (optional — e.g. Neon + pgvector).
  // When MEMORY_PG_PASSWORD (or a full MEMORY_PG_URL) is set, every
  // saved memory is ALSO written to Postgres so it survives the cloud.
  memoryPgUrl: string;
  memoryPgSsl: boolean;

  // Screenshot interval (seconds) — how often the companion can auto-screenshot
  screenshotInterval: number;
}

export function loadConfig(): SymbioConfig {
  const agentName = getEnv("AGENT_NAME", "companion").toLowerCase();

  // If the agent name isn't in COMPANIONS (e.g. user created a custom name
  // via the setup wizard), create a dynamic config from env vars instead of
  // falling back to the default "companion" config.
  const isCustomAgent = !(agentName in COMPANIONS);
  const agentConfig = isCustomAgent
    ? {
        ...COMPANIONS.companion,
        name: agentName,
        displayName: getEnv("AGENT_DISPLAY_NAME", agentName.charAt(0).toUpperCase() + agentName.slice(1)),
        personality: getEnv("AGENT_PERSONALITY", COMPANIONS.companion.personality),
        color: getEnv("AGENT_COLOR", COMPANIONS.companion.color),
        hermesApiUrl: getEnv("HERMES_API_URL", "http://localhost:8642"),
        hermesApiKey: getEnv("HERMES_API_KEY", ""),
      }
    : { ...COMPANIONS[agentName] };

  // Override API key from env
  agentConfig.hermesApiKey =
    getEnv(`HERMES_API_KEY_${agentName.toUpperCase()}`) ||
    getEnv("HERMES_API_KEY", "") ||
    agentConfig.hermesApiKey;

  // Override gateway URL from env
  agentConfig.hermesApiUrl =
    getEnv(`HERMES_API_URL_${agentName.toUpperCase()}`) ||
    getEnv("HERMES_API_URL", "http://localhost:8642") ||
    agentConfig.hermesApiUrl;

  // Allow VRM path override from env
  const vrmPath = getEnv("AGENT_VRM_PATH") || agentConfig.vrmPath;
  agentConfig.vrmPath = vrmPath;

  // Allow SOUL.md path override
  const soulPath = getEnv("AGENT_SOUL_PATH") || agentConfig.soulPath;
  agentConfig.soulPath = soulPath;

  // Allow display name override from env (for both custom and built-in agents)
  const displayName = getEnv("AGENT_DISPLAY_NAME");
  if (displayName) {
    agentConfig.displayName = displayName;
  }

  // Allow personality override from env
  const personality = getEnv("AGENT_PERSONALITY");
  if (personality) {
    agentConfig.personality = personality;
  }

  // Allow color override from env
  const color = getEnv("AGENT_COLOR");
  if (color) {
    agentConfig.color = color;
  }

  // Use the agent-specific gateway URL and API key
  const hermesApiUrl = agentConfig.hermesApiUrl || getEnv("HERMES_API_URL", "http://localhost:8642");
  const hermesApiKey = agentConfig.hermesApiKey || getEnv("HERMES_API_KEY", "");

  return {
    hermesApiUrl,
    hermesApiKey,
    llmModel: getEnv("LLM_MODEL", ""),

    agentName,
    agentConfig,

    geminiApiKey: getEnv("GEMINI_API_KEY", ""),
    visionApiKey: getEnv("VISION_API_KEY", ""),
    openaiApiKey: getEnv("OPENAI_API_KEY", ""),

    // TTS (Text-to-Speech) configuration
    ttsProvider: getEnv("TTS_PROVIDER", "openai"),
    ttsModel: getEnv("TTS_MODEL", "gpt-4o-mini-tts"),
    ttsVoice: getEnv("TTS_VOICE", "fable"),
    ttsInstructions: getEnv("TTS_INSTRUCTIONS", ""),

    // Vision model (for screen analysis)
    visionModel: getEnv("VISION_MODEL", ""),

    // STT (Speech-to-Text) model
    sttModel: getEnv("STT_MODEL", "whisper-1"),

    livekitUrl: getEnv("LIVEKIT_URL", ""),
    livekitApiKey: getEnv("LIVEKIT_API_KEY", ""),
    livekitApiSecret: getEnv("LIVEKIT_API_SECRET", ""),

    miniverseApiUrl: getEnv("MINIVERSE_API_URL", ""),

    memoryPgHost: getEnv("MEMORY_PG_HOST", "localhost"),
    memoryPgPort: getEnvInt("MEMORY_PG_PORT", 5432),
    memoryPgDb: getEnv("MEMORY_PG_DB", "symbio"),
    memoryPgUser: getEnv("MEMORY_PG_USER", "symbio"),
    memoryPgPassword: getEnv("MEMORY_PG_PASSWORD", ""),

    memoryNeo4jUri: getEnv("MEMORY_NEO4J_URI", "bolt://localhost:7687"),
    memoryNeo4jUser: getEnv("MEMORY_NEO4J_USER", "neo4j"),
    memoryNeo4jPassword: getEnv("MEMORY_NEO4J_PASSWORD", ""),

    // ── Long-term memory ──────────────────────────────────────────
    embeddingApiUrl: getEnv("EMBEDDING_API_URL", ""),
    embeddingModel: getEnv("EMBEDDING_MODEL", ""),
    // Embedding key falls back to OpenAI key so users who already set
    // OPENAI_API_KEY get semantic memory for free with no extra config.
    embeddingApiKey: getEnv("EMBEDDING_API_KEY", "") || getEnv("OPENAI_API_KEY", ""),
    embeddingDimensions: getEnvInt("EMBEDDING_DIMENSIONS", 768),

    summaryModel: getEnv("SUMMARY_MODEL", ""),
    summaryApiUrl: getEnv("SUMMARY_API_URL", ""),
    summaryApiKey: getEnv("SUMMARY_API_KEY", ""),
    summaryEveryMessages: getEnvInt("SUMMARY_EVERY_MESSAGES", 15),

    // Accept either a full connection URL or discrete fields.
    memoryPgUrl: getEnv("MEMORY_PG_URL", ""),
    memoryPgSsl: getEnv("MEMORY_PG_SSL", "true").toLowerCase() !== "false",

    screenshotInterval: getEnvInt("SCREENSHOT_INTERVAL", 30),
  };
}

export const config = loadConfig();