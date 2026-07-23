/**
 * Symbio Memory Client
 *
 * This is what makes Symbio truly symbiotic — the companion remembers
 * across sessions and proactively surfaces relevant memories.
 *
 * ── How this changed and why ──────────────────────────────────────
 * The previous version posted every turn to
 *   POST {hermesApiUrl}/gateway/{agent}/memory/sync
 * which DOES NOT EXIST on the Hermes gateway. Every request 404'd, the
 * error was swallowed, and nothing was ever persisted — which is exactly
 * why the cloud Postgres tables stayed empty.
 *
 * Now this client routes through Symbio's own long-term memory engine
 * (local SQLite, always on; optional Postgres/pgvector mirror) in
 * `utils/longTermMemory.ts`. It works WITH or WITHOUT Hermes.
 *
 * For Hermes specifically, long-term memory is achieved by sending the
 * X-Hermes-Session-Id / X-Hermes-Session-Key headers on the existing
 * /v1/chat/completions calls (see hermesMemoryHeaders below) — so Hermes
 * agents remember what they did inside Symbio without any phantom endpoint.
 */

import { config } from "../config";
import {
  saveMemory,
  recallMemories,
  recentMemories,
  type RecallResult,
} from "../utils/longTermMemory";

// ── Hermes session memory (header-based) ──────────────────────────

/** Returns true when the configured gateway looks like a Hermes instance. */
export function isHermesGateway(): boolean {
  const url = config.hermesApiUrl || "";
  return url.includes("localhost") || url.includes("8642") || url.includes("hermes");
}

/**
 * A stable session key for this companion. Hermes uses it to scope
 * long-term memory so the same companion accumulates one continuous memory
 * across app restarts. Per-agent is the right default for a desktop companion.
 */
export function getHermesSessionKey(): string {
  return `symbio:${(config.agentName || "companion").toLowerCase()}`;
}

let _hermesSessionId: string | null = null;
/** A per-launch session id for conversation continuity within a sitting. */
export function getHermesSessionId(): string {
  if (!_hermesSessionId) {
    _hermesSessionId = `symbio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return _hermesSessionId;
}

/** Start a fresh Hermes session id (call when a new sitting begins). */
export function resetHermesSession(): void {
  _hermesSessionId = null;
}

/**
 * Build the Hermes memory headers to attach to a /v1/chat/completions
 * request. Returns {} when not talking to Hermes, so it's safe to spread
 * into any request unconditionally.
 */
export function hermesMemoryHeaders(): Record<string, string> {
  if (!isHermesGateway()) return {};
  return {
    "X-Hermes-Session-Id": getHermesSessionId(),
    "X-Hermes-Session-Key": getHermesSessionKey(),
  };
}

export interface Memory {
  id: string;
  content: string;
  source: string;
  timestamp: string;
  relevance?: number;
  entities?: string[];
  type?: "prefetch" | "associative" | "sync" | "episodic";
}

export interface Entity {
  name: string;
  type?: string;
  connections?: string[];
}

/** Convert a RecallResult from the engine into the legacy Memory shape. */
function toMemory(r: RecallResult): Memory {
  return {
    id: `${r.createdAt}`,
    content: r.summary || r.content,
    source: r.source === "cloud" ? "postgres" : "local",
    timestamp: r.createdAt,
    relevance: r.score,
    type: r.kind === "summary" ? "episodic" : "associative",
  };
}

export class MemoryClient {
  private agentName: string;

  constructor() {
    this.agentName = config.agentName;
  }

  /**
   * Prefetch memories for a conversation. Called when a new conversation
   * starts — returns relevant memories based on the opening context.
   * Now backed by Symbio's local long-term memory engine.
   */
  async prefetch(context: string): Promise<Memory[]> {
    try {
      const results = await recallMemories(context, 5);
      return results.map(toMemory);
    } catch (error) {
      console.warn("[Symbio] Memory prefetch error:", (error as Error).message);
      return [];
    }
  }

  /**
   * Record a conversation turn. Individual turns are NOT each stored as a
   * separate long-term memory — that would bloat the store and cost an
   * embedding per turn. Instead, the rolling summarizer in main.ts saves a
   * distilled summary every N messages and on goodbye/quit, which is what
   * lands in long-term memory.
   *
   * Kept for API compatibility; it's a cheap no-op so existing callers in
   * main.ts don't break. (Hermes long-term memory, when connected, ingests
   * turns automatically via the session headers on the chat call.)
   */
  async syncTurn(_userMessage: string, _assistantMessage: string): Promise<void> {
    /* intentionally a no-op — see doc comment above */
  }

  /**
   * Persist a distilled memory (e.g. a session summary) to long-term store.
   * This is the method the summarizer should call.
   */
  async remember(content: string, opts?: { summary?: string; topics?: string[]; sessionId?: string; importance?: number }): Promise<void> {
    try {
      await saveMemory({
        kind: "summary",
        content,
        summary: opts?.summary,
        topics: opts?.topics,
        sessionId: opts?.sessionId,
        importance: opts?.importance,
      });
    } catch (error) {
      console.warn("[Symbio] remember() error:", (error as Error).message);
    }
  }

  /** Search memories by text/meaning. */
  async search(query: string, limit: number = 5): Promise<Memory[]> {
    try {
      const results = await recallMemories(query, limit);
      return results.map(toMemory);
    } catch (error) {
      console.warn("[Symbio] Memory search error:", (error as Error).message);
      return [];
    }
  }

  /** Return the most recent memories (for startup context). */
  recent(limit = 3): Memory[] {
    try {
      return recentMemories(limit).map((r) =>
        toMemory({
          content: r.content,
          summary: r.summary,
          createdAt: r.createdAt,
          kind: r.kind === "summary" ? "summary" : "fact",
          score: 1,
          source: "local",
        }),
      );
    } catch {
      return [];
    }
  }
}

export const memoryClient = new MemoryClient();