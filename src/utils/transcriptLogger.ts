/**
 * Symbio Basic — Session Transcript Logger
 *
 * Saves the FULL conversation of every session as a human-readable Markdown
 * file. This is the "I wish I could look back on the whole chat" feature:
 * summaries are great for the companion's memory, but sometimes you (the
 * human) just want the complete transcript — the thing the AI suggested, the
 * link it shared, the idea you forgot.
 *
 * Design goals:
 *   • Human-readable & portable — plain Markdown with YAML frontmatter, so it
 *     opens in any editor/Obsidian and can be moved to the cloud, an external
 *     SSD, wherever the human wants.
 *   • Tiny — a heavy 2-hour chat is only tens of KB, so keeping every session
 *     costs almost nothing. No database bloat.
 *   • AI-searchable WITHOUT a gateway — a companion on ANY backend (OpenAI,
 *     Ollama, Hermes…) can keyword-search these files via the local
 *     `search_transcripts` tool. No computer-use required; the app just reads
 *     its own folder.
 *
 * One file per session, appended turn-by-turn as the conversation happens, so
 * nothing is lost even if the app is force-quit. Finalized (frontmatter
 * completed) on session end.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";

// ── Module state ─────────────────────────────────────────────────────
let transcriptDir = "";
let agentName = "Companion";
let currentFile = "";
let currentSessionId = "";
let currentStartedAt = "";
let turnCount = 0;
let headerWritten = false;

/** Sanitize a string so it is safe to use inside a filename. */
function safeSlug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "session"
  );
}

/** ISO timestamp → a filename-friendly "YYYY-MM-DD_HHMMSS". */
function stampFromIso(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Initialize the transcript logger for this launch. Creates the transcript
 * directory if needed. Safe to call once at startup.
 *
 * @param dir   Absolute path to the folder where transcripts are saved.
 * @param agent The companion's display name (used for the speaker label).
 */
export function initTranscriptLogger(dir: string, agent: string): void {
  transcriptDir = dir;
  agentName = agent || "Companion";
  try {
    if (!existsSync(transcriptDir)) mkdirSync(transcriptDir, { recursive: true });
  } catch (e) {
    console.warn("[Symbio] Could not create transcript folder:", (e as Error).message);
  }
}

/** True once a folder has been configured. */
export function transcriptEnabled(): boolean {
  return Boolean(transcriptDir);
}

/** Absolute path to the transcript directory (for showing the user). */
export function getTranscriptDir(): string {
  return transcriptDir;
}

/**
 * Begin a new session transcript. Called when a fresh sitting starts.
 * Lazily writes the file on the first recorded turn so we never create empty
 * files for sessions where nothing was said.
 */
export function startTranscriptSession(sessionId: string, startedAtIso: string): void {
  currentSessionId = sessionId || `symbio_${Date.now()}`;
  currentStartedAt = startedAtIso || new Date().toISOString();
  currentFile = "";
  turnCount = 0;
  headerWritten = false;
}

/** Update the agent name mid-session (e.g. the companion renamed itself). */
export function setTranscriptAgentName(agent: string): void {
  if (agent) agentName = agent;
}

function ensureFile(): boolean {
  if (!transcriptDir) return false;
  if (currentFile) return true;
  if (!currentSessionId) startTranscriptSession("", "");

  const stamp = stampFromIso(currentStartedAt);
  const shortId = currentSessionId.replace(/[^a-zA-Z0-9]+/g, "").slice(-8);
  currentFile = join(transcriptDir, `${stamp}_${shortId}.md`);

  if (!headerWritten) {
    const frontmatter =
      `---\n` +
      `session_id: ${currentSessionId}\n` +
      `agent: ${agentName}\n` +
      `date: ${currentStartedAt}\n` +
      `title: ""\n` +
      `mood: ""\n` +
      `messages: 0\n` +
      `---\n\n` +
      `# Session — ${new Date(currentStartedAt).toLocaleString()}\n\n`;
    try {
      writeFileSync(currentFile, frontmatter, "utf-8");
      headerWritten = true;
    } catch (e) {
      console.warn("[Symbio] Could not start transcript file:", (e as Error).message);
      return false;
    }
  }
  return true;
}

/**
 * Record one turn of the conversation. `role` is "user" or "assistant".
 * Appends immediately so the transcript survives an abrupt shutdown.
 */
export function recordTurn(role: "user" | "assistant", content: string): void {
  if (!transcriptDir || !content || !content.trim()) return;
  if (!ensureFile()) return;

  const speaker = role === "user" ? "Human Partner" : agentName;
  const time = new Date().toLocaleTimeString();
  const block = `**${speaker}** _(${time})_:\n\n${content.trim()}\n\n`;

  try {
    appendFileSync(currentFile, block, "utf-8");
    turnCount++;
  } catch (e) {
    console.warn("[Symbio] Could not append to transcript:", (e as Error).message);
  }
}

/**
 * Finalize the current transcript: fill in the frontmatter title/mood/message
 * count now that the session is over. Best-effort — the turn-by-turn body is
 * already safely on disk regardless.
 */
export function finalizeTranscript(opts: { title?: string; mood?: string } = {}): void {
  if (!currentFile || !headerWritten) return;
  try {
    let text = readFileSync(currentFile, "utf-8");
    if (opts.title) {
      const t = opts.title.replace(/\n/g, " ").replace(/"/g, "'").slice(0, 120);
      text = text.replace(/^title: ""$/m, `title: "${t}"`);
      // Also upgrade the H1 heading to include the title for readability.
      text = text.replace(
        /^# Session — (.+)$/m,
        `# ${t}\n\n_Session — $1_`,
      );
    }
    if (opts.mood) {
      text = text.replace(/^mood: ""$/m, `mood: "${opts.mood.replace(/"/g, "'")}"`);
    }
    text = text.replace(/^messages: 0$/m, `messages: ${turnCount}`);
    writeFileSync(currentFile, text, "utf-8");
  } catch (e) {
    console.warn("[Symbio] Could not finalize transcript:", (e as Error).message);
  }
}

// ── Search (local keyword search — no gateway/computer-use needed) ────

export interface TranscriptMatch {
  file: string;
  date: string;
  title: string;
  snippet: string;
  score: number;
}

/**
 * Keyword-search across all saved transcripts. This is what lets a companion
 * on ANY backend recall "what did we talk about re: X?" — it reads the local
 * Markdown files directly, so it works offline and without Hermes.
 *
 * Scoring is simple term-frequency across the query's words, with a snippet
 * pulled from around the first strong match. Good enough for "help me find
 * that thing we discussed" without pulling in a search engine dependency.
 */
export function searchTranscripts(query: string, limit = 5): TranscriptMatch[] {
  if (!transcriptDir || !existsSync(transcriptDir) || !query.trim()) return [];

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  let files: string[];
  try {
    files = readdirSync(transcriptDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const results: TranscriptMatch[] = [];
  for (const f of files) {
    const full = join(transcriptDir, f);
    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();

    let score = 0;
    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        score++;
        idx = lower.indexOf(term, idx + term.length);
      }
    }
    if (score === 0) continue;

    // Pull a snippet around the first matched term.
    const firstIdx = Math.min(
      ...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0),
    );
    const start = Math.max(0, firstIdx - 120);
    const end = Math.min(text.length, firstIdx + 240);
    let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) snippet = "…" + snippet;
    if (end < text.length) snippet = snippet + "…";

    // Parse date/title from frontmatter for context.
    const dateMatch = text.match(/^date:\s*(.+)$/m);
    const titleMatch = text.match(/^title:\s*"?(.*?)"?$/m);

    results.push({
      file: f,
      date: (dateMatch?.[1] || "").trim(),
      title: (titleMatch?.[1] || "").trim(),
      snippet,
      score,
    });
  }

  // Most relevant first; tie-break newest first by filename (date-prefixed).
  results.sort((a, b) => b.score - a.score || b.file.localeCompare(a.file));
  return results.slice(0, limit);
}

/** How many transcript files exist (for status/debug). */
export function transcriptCount(): number {
  if (!transcriptDir || !existsSync(transcriptDir)) return 0;
  try {
    return readdirSync(transcriptDir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** List recent transcripts (newest first) — used by a "recent chats" view. */
export function listRecentTranscripts(limit = 10): TranscriptMatch[] {
  if (!transcriptDir || !existsSync(transcriptDir)) return [];
  let files: string[];
  try {
    files = readdirSync(transcriptDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  files.sort((a, b) => b.localeCompare(a));
  return files.slice(0, limit).map((f) => {
    const full = join(transcriptDir, f);
    let text = "";
    try {
      text = readFileSync(full, "utf-8");
    } catch {
      /* ignore */
    }
    const dateMatch = text.match(/^date:\s*(.+)$/m);
    const titleMatch = text.match(/^title:\s*"?(.*?)"?$/m);
    let mtime = "";
    try {
      mtime = statSync(full).mtime.toISOString();
    } catch {
      /* ignore */
    }
    return {
      file: f,
      date: (dateMatch?.[1] || mtime).trim(),
      title: (titleMatch?.[1] || "").trim(),
      snippet: "",
      score: 0,
    };
  });
}
