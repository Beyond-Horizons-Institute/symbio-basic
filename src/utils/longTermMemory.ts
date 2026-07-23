/**
 * Symbio Basic — Long-Term Memory Engine
 *
 * This is the companion's lasting memory. It is LOCAL-FIRST: a SQLite
 * database lives in the app's data folder and is always available, with
 * zero setup, fully offline. Memory is gold — it must always work.
 *
 * On top of that always-on local store, two optional layers sync outward
 * when configured:
 *   • Postgres + pgvector (e.g. Neon) — cloud durability & cross-device.
 *   • Hermes session memory — handled in the chat pipeline via the
 *     X-Hermes-Session-* headers, so Hermes agents remember what they did
 *     inside Symbio.
 *
 * Semantic search uses sqlite-vec when the native extension loads; if it
 * can't (e.g. an unsupported platform), we transparently fall back to
 * in-process cosine similarity over stored embeddings, and if there are no
 * embeddings at all, to keyword search. The companion always remembers —
 * the only thing that changes is how cleverly it can recall.
 *
 *   memory kinds:
 *     "summary"   — a rolling session summary (the main long-term unit)
 *     "fact"      — a discrete fact the companion chose to remember
 *     "turn"      — an individual important exchange (optional)
 */

import Database from "better-sqlite3";
import { join, sep } from "path";
import { existsSync, mkdirSync } from "fs";
import { config } from "../config";
import {
  embedText,
  embeddingsEnabled,
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
} from "./embeddings";
import {
  initPostgresMemory,
  postgresEnabled,
  syncMemoryToPostgres,
  searchPostgres,
} from "./postgresMemory";

export type MemoryKind = "summary" | "fact" | "turn";

export interface MemoryRecord {
  id: string;
  agent: string;
  kind: MemoryKind;
  content: string;
  summary?: string;
  topics?: string;
  importance?: number;
  sessionId?: string;
  createdAt: string; // ISO
  embedding?: Float32Array;
}

export interface RecallResult {
  content: string;
  summary?: string;
  createdAt: string;
  kind: MemoryKind;
  score: number;
  source: "local" | "cloud";
}

/**
 * Load the sqlite-vec loadable extension into a database connection.
 *
 * Resolution order:
 *   1. Explicit path to the binary copied next to the main bundle
 *      (works in packaged apps where require.resolve of the .so fails).
 *   2. The sqlite-vec package's own resolver (works in dev).
 * Throws if neither works (caller catches and degrades gracefully).
 */
function loadVecExtension(database: Database.Database): void {
  // The binary is copied next to the main bundle as `native_modules/vec0.node`
  // (named .node so AutoUnpackNativesPlugin unpacks it from the asar). In a
  // packaged app __dirname is inside app.asar, so we rewrite to the sibling
  // app.asar.unpacked path where the real file lives.
  const candidates: string[] = [join(__dirname, "native_modules", "vec0.node")];
  if (__dirname.includes(`app.asar${sep}`) || __dirname.includes("app.asar/")) {
    candidates.unshift(
      join(
        __dirname
          .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
          .replace("app.asar/", "app.asar.unpacked/"),
        "native_modules",
        "vec0.node",
      ),
    );
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      database.loadExtension(p);
      return;
    }
  }

  // Fall back to the package's own resolver (dev / node_modules present).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(database);
}

// ── Module state ────────────────────────────────────────────────────
let db: Database.Database | null = null;
let vecAvailable = false;
let dim = 768;
let agentName = "companion";

// ── Init ────────────────────────────────────────────────────────────

/**
 * Initialize the long-term memory engine.
 * @param memoryDir absolute path to the app's `memory/` directory
 * @param agent     the companion's name (scopes memories per agent)
 */
export async function initLongTermMemory(memoryDir: string, agent: string): Promise<void> {
  agentName = agent || "companion";
  dim = config.embeddingDimensions || 768;

  try {
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    const dbPath = join(memoryDir, "memory.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    // Try to load sqlite-vec for fast native vector search.
    //
    // In dev, sqlite-vec resolves its loadable extension from node_modules.
    // In a packaged app, require.resolve of the platform .so fails (can't
    // read from asar), so we first try an explicit path to the copied binary
    // (see CopyWebpackPlugin in webpack.main.config.ts) and fall back to the
    // package's own resolver. If both fail, we degrade to in-process cosine
    // search — memory still works, just without the native ANN speedup.
    try {
      loadVecExtension(db);
      vecAvailable = true;
      console.log("[Symbio] sqlite-vec loaded — fast semantic memory enabled");
    } catch (e) {
      vecAvailable = false;
      console.warn(
        "[Symbio] sqlite-vec unavailable — using in-process vector search:",
        (e as Error).message,
      );
    }

    createSchema();

    // Spin up the optional Postgres mirror (non-blocking — never fatal).
    if (postgresEnabled()) {
      initPostgresMemory().catch(() => {
        /* logged inside */
      });
    }

    console.log(`[Symbio] Long-term memory ready at ${dbPath}`);
  } catch (e) {
    console.error("[Symbio] Failed to init long-term memory:", (e as Error).message);
    db = null;
  }
}

function createSchema(): void {
  if (!db) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL,
      summary     TEXT,
      topics      TEXT,
      importance  REAL DEFAULT 0.5,
      session_id  TEXT,
      created_at  TEXT NOT NULL,
      embedding   BLOB
    );
    CREATE INDEX IF NOT EXISTS mem_agent_idx ON memories (agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS mem_kind_idx ON memories (agent, kind);
  `);

  // sqlite-vec virtual table for ANN search (only if the extension loaded).
  if (vecAvailable) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          embedding float[${dim}]
        );
      `);
    } catch (e) {
      console.warn("[Symbio] Could not create vec0 table:", (e as Error).message);
      vecAvailable = false;
    }
  }
}

/** True once the local store is ready. */
export function memoryReady(): boolean {
  return db !== null;
}

// ── Saving ──────────────────────────────────────────────────────────

function makeId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Save a memory. Embeds it (if embeddings are configured), writes to local
 * SQLite (always), and mirrors to Postgres (if configured). Returns the
 * stored record, or null if the local store isn't ready.
 */
export async function saveMemory(input: {
  kind: MemoryKind;
  content: string;
  summary?: string;
  topics?: string[] | string;
  importance?: number;
  sessionId?: string;
}): Promise<MemoryRecord | null> {
  if (!db) return null;

  const embedding = await embedText(input.summary || input.content);
  const rec: MemoryRecord = {
    id: makeId(),
    agent: agentName,
    kind: input.kind,
    content: input.content,
    summary: input.summary,
    topics: Array.isArray(input.topics) ? input.topics.join(", ") : input.topics,
    importance: input.importance ?? 0.5,
    sessionId: input.sessionId,
    createdAt: new Date().toISOString(),
    embedding: embedding ?? undefined,
  };

  try {
    db.prepare(
      `INSERT INTO memories
         (id, agent, kind, content, summary, topics, importance, session_id, created_at, embedding)
       VALUES (@id, @agent, @kind, @content, @summary, @topics, @importance, @sessionId, @createdAt, @embedding)`,
    ).run({
      ...rec,
      summary: rec.summary ?? null,
      topics: rec.topics ?? null,
      sessionId: rec.sessionId ?? null,
      embedding: embedding ? vectorToBuffer(embedding) : null,
    });

    // Mirror the embedding into the vec table (keyed by rowid alignment via id).
    if (vecAvailable && embedding) {
      try {
        const row = db.prepare("SELECT rowid FROM memories WHERE id = ?").get(rec.id) as
          | { rowid: number }
          | undefined;
        if (row) {
          // sqlite-vec requires the rowid bound as a strict integer.
          // better-sqlite3 binds plain JS numbers as REAL, which vec0
          // rejects ("Only integers are allowed for primary key values"),
          // so we bind a BigInt.
          db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)").run(
            BigInt(row.rowid),
            vectorToBuffer(embedding),
          );
        }
      } catch (e) {
        console.warn("[Symbio] vec insert failed:", (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("[Symbio] saveMemory (local) failed:", (e as Error).message);
    return null;
  }

  // Mirror to Postgres in the background — never block the conversation.
  if (postgresEnabled()) {
    syncMemoryToPostgres(rec).catch(() => {
      /* logged inside */
    });
  }

  console.log(`[Symbio] Memory saved (${rec.kind}): ${(rec.summary || rec.content).slice(0, 80)}`);
  return rec;
}

/**
 * Synchronous, embedding-free save for use during shutdown.
 *
 * The async `saveMemory()` awaits an embedding HTTP call before it writes to
 * SQLite. During `before-quit` we can't await — and if we fire-and-forget it,
 * the DB gets closed before the write lands ("Cannot read properties of null
 * (reading 'prepare')"). This writes the row immediately and synchronously
 * (no embedding, no Postgres) so the memory is safely persisted before the
 * connection closes. The memory is still searchable via keyword/recency; it
 * just won't have a vector until re-embedded later. Returns true on success.
 */
export function saveMemorySync(input: {
  kind: MemoryKind;
  content: string;
  summary?: string;
  topics?: string[] | string;
  importance?: number;
  sessionId?: string;
}): boolean {
  if (!db) return false;
  try {
    const rec: MemoryRecord = {
      id: makeId(),
      agent: agentName,
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      topics: Array.isArray(input.topics) ? input.topics.join(", ") : input.topics,
      importance: input.importance ?? 0.5,
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO memories
         (id, agent, kind, content, summary, topics, importance, session_id, created_at, embedding)
       VALUES (@id, @agent, @kind, @content, @summary, @topics, @importance, @sessionId, @createdAt, @embedding)`,
    ).run({
      ...rec,
      summary: rec.summary ?? null,
      topics: rec.topics ?? null,
      sessionId: rec.sessionId ?? null,
      embedding: null,
    });
    return true;
  } catch (e) {
    console.warn("[Symbio] saveMemorySync failed:", (e as Error).message);
    return false;
  }
}

// ── Recall ──────────────────────────────────────────────────────────

/**
 * Recall the most relevant memories for a query. Tries, in order:
 *   1. sqlite-vec ANN search (fast, if available + query is embeddable)
 *   2. in-process cosine similarity over stored embeddings
 *   3. keyword search (always works)
 * Optionally also queries Postgres for memories not present locally.
 */
export async function recallMemories(query: string, limit = 5): Promise<RecallResult[]> {
  if (!db) return [];
  const results: RecallResult[] = [];

  const queryVec = embeddingsEnabled() ? await embedText(query) : null;

  // 1 + 2: vector recall
  if (queryVec) {
    if (vecAvailable) {
      try {
        // sqlite-vec KNN requires a `k = ?` constraint (not a plain LIMIT).
        // We over-fetch by agent filtering afterwards: vec0 doesn't support
        // joining the agent filter inside the MATCH, so we request more
        // neighbours (k) and then filter/limit by agent in JS-friendly SQL.
        const k = Math.max(limit * 4, limit);
        const rows = db
          .prepare(
            `SELECT m.content, m.summary, m.created_at AS createdAt, m.kind,
                    v.distance AS distance
             FROM memories_vec v
             JOIN memories m ON m.rowid = v.rowid
             WHERE v.embedding MATCH ? AND k = ?
               AND m.agent = ?
             ORDER BY v.distance
             LIMIT ?`,
          )
          .all(vectorToBuffer(queryVec), k, agentName, limit) as Array<{
          content: string;
          summary: string | null;
          createdAt: string;
          kind: MemoryKind;
          distance: number;
        }>;
        for (const r of rows) {
          results.push({
            content: r.content,
            summary: r.summary ?? undefined,
            createdAt: r.createdAt,
            kind: r.kind,
            score: 1 / (1 + r.distance), // distance → similarity-ish
            source: "local",
          });
        }
      } catch (e) {
        console.warn("[Symbio] vec search failed, falling back:", (e as Error).message);
      }
    }

    // In-process cosine fallback if vec table gave nothing.
    if (results.length === 0) {
      try {
        const rows = db
          .prepare(
            `SELECT content, summary, created_at AS createdAt, kind, embedding
             FROM memories
             WHERE agent = ? AND embedding IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 200`,
          )
          .all(agentName) as Array<{
          content: string;
          summary: string | null;
          createdAt: string;
          kind: MemoryKind;
          embedding: Buffer;
        }>;
        const scored = rows
          .map((r) => ({
            r,
            score: cosineSimilarity(queryVec, bufferToVector(r.embedding)),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        for (const { r, score } of scored) {
          results.push({
            content: r.content,
            summary: r.summary ?? undefined,
            createdAt: r.createdAt,
            kind: r.kind,
            score,
            source: "local",
          });
        }
      } catch (e) {
        console.warn("[Symbio] cosine fallback failed:", (e as Error).message);
      }
    }
  }

  // 3: keyword search (always, if nothing else produced results)
  if (results.length === 0) {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (words.length > 0) {
      try {
        const like = `%${words[0]}%`;
        const rows = db
          .prepare(
            `SELECT content, summary, created_at AS createdAt, kind
             FROM memories
             WHERE agent = ? AND (lower(content) LIKE ? OR lower(summary) LIKE ?)
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(agentName, like, like, limit) as Array<{
          content: string;
          summary: string | null;
          createdAt: string;
          kind: MemoryKind;
        }>;
        for (const r of rows) {
          results.push({
            content: r.content,
            summary: r.summary ?? undefined,
            createdAt: r.createdAt,
            kind: r.kind,
            score: 0.4,
            source: "local",
          });
        }
      } catch (e) {
        console.warn("[Symbio] keyword search failed:", (e as Error).message);
      }
    }
  }

  // Optionally enrich with cloud memories (e.g. from another device/agent).
  if (postgresEnabled()) {
    try {
      const cloud = await searchPostgres(agentName, queryVec, query, limit);
      const seen = new Set(results.map((r) => r.content));
      for (const c of cloud) {
        if (!seen.has(c.content)) {
          results.push({
            content: c.content,
            summary: c.summary,
            createdAt: c.createdAt,
            kind: "summary",
            score: c.score,
            source: "cloud",
          });
        }
      }
    } catch {
      /* cloud is best-effort */
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Return the most recent memories (for startup context injection). */
export function recentMemories(limit = 3): MemoryRecord[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, agent, kind, content, summary, topics, importance,
                session_id AS sessionId, created_at AS createdAt
         FROM memories
         WHERE agent = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(agentName, limit) as MemoryRecord[];
    return rows;
  } catch (e) {
    console.warn("[Symbio] recentMemories failed:", (e as Error).message);
    return [];
  }
}

/** Total number of stored memories for this agent (for diagnostics/UI). */
export function memoryCount(): number {
  if (!db) return 0;
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE agent = ?").get(agentName) as {
      n: number;
    };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Close the database (called on quit). */
export function closeLongTermMemory(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}
