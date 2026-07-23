/**
 * Symbio Basic — Postgres Long-Term Memory (optional cloud sync)
 *
 * When the user configures a Postgres database (e.g. Neon with pgvector),
 * every memory Symbio saves locally is ALSO written here so it survives in
 * the cloud and can be shared across machines or with a Hermes agent.
 *
 * This is OPTIONAL. Local SQLite is always the source of truth. Postgres is
 * a mirror. If Postgres is unreachable, the local store keeps working and we
 * just log a warning — memory is never lost.
 *
 * Why direct `pg` instead of the old Hermes endpoint? The previous
 * MemoryClient posted to `/gateway/{agent}/memory/sync`, which does not
 * exist on the Hermes gateway, so every write 404'd silently and the Neon
 * tables stayed empty. Talking to Postgres directly is what actually fills
 * the tables.
 *
 * pgvector is used when available (for fast semantic search). If the
 * `vector` extension can't be created (some managed DBs restrict it), we
 * gracefully fall back to storing the embedding as JSON and the table still
 * works for keyword/recency recall.
 */

import { config } from "../config";
import type { MemoryRecord } from "./longTermMemory";

// Lazy require so the renderer bundle never tries to load the native-ish pg.
type PgPool = import("pg").Pool;
let Pool: typeof import("pg").Pool | null = null;

let pool: PgPool | null = null;
let initialized = false;
let usePgVector = false;
let enabled = false;

/** Build a pg connection config from either a URL or discrete env fields. */
function buildConnection(): Record<string, unknown> | null {
  if (config.memoryPgUrl) {
    return {
      connectionString: config.memoryPgUrl,
      ssl: config.memoryPgSsl ? { rejectUnauthorized: false } : undefined,
    };
  }
  // Only connect via discrete fields if a password was actually provided —
  // otherwise we'd try to connect to a non-existent local DB on every launch.
  if (!config.memoryPgPassword) return null;
  return {
    host: config.memoryPgHost,
    port: config.memoryPgPort,
    database: config.memoryPgDb,
    user: config.memoryPgUser,
    password: config.memoryPgPassword,
    ssl: config.memoryPgSsl ? { rejectUnauthorized: false } : undefined,
  };
}

/** True if Postgres sync is configured. */
export function postgresEnabled(): boolean {
  return Boolean(config.memoryPgUrl || config.memoryPgPassword);
}

/**
 * Initialize the connection pool and ensure the schema exists.
 * Safe to call multiple times — only runs once.
 */
export async function initPostgresMemory(): Promise<boolean> {
  if (initialized) return enabled;
  initialized = true;

  if (!postgresEnabled()) return false;

  const conn = buildConnection();
  if (!conn) return false;

  try {
    if (!Pool) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Pool = require("pg").Pool;
    }
    pool = new Pool!({ ...conn, max: 3, idleTimeoutMillis: 30000 });

    // Try to enable pgvector. Many managed Postgres (incl. Neon) support it.
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
      usePgVector = true;
    } catch {
      usePgVector = false;
      console.warn(
        "[Symbio] pgvector extension unavailable — storing embeddings as JSON in Postgres",
      );
    }

    const dim = config.embeddingDimensions || 768;
    const embeddingCol = usePgVector ? `embedding vector(${dim})` : "embedding jsonb";

    await pool.query(`
      CREATE TABLE IF NOT EXISTS symbio_memories (
        id           TEXT PRIMARY KEY,
        agent        TEXT NOT NULL,
        kind         TEXT NOT NULL,
        content      TEXT NOT NULL,
        summary      TEXT,
        topics       TEXT,
        importance   REAL DEFAULT 0.5,
        session_id   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        ${embeddingCol}
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS symbio_mem_agent_idx ON symbio_memories (agent, created_at DESC)",
    );
    if (usePgVector) {
      // IVF flat index for approximate nearest neighbour search.
      try {
        await pool.query(
          "CREATE INDEX IF NOT EXISTS symbio_mem_vec_idx ON symbio_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)",
        );
      } catch {
        /* index is an optimization; safe to skip */
      }
    }

    enabled = true;
    console.log(
      `[Symbio] Postgres long-term memory connected (pgvector: ${usePgVector ? "yes" : "no"})`,
    );
    return true;
  } catch (e) {
    console.warn(
      "[Symbio] Postgres memory unavailable — local SQLite still active:",
      (e as Error).message,
    );
    enabled = false;
    return false;
  }
}

/** Mirror a memory record to Postgres. No-op if Postgres isn't connected. */
export async function syncMemoryToPostgres(rec: MemoryRecord): Promise<void> {
  if (!enabled || !pool) return;
  try {
    const embeddingValue = rec.embedding
      ? usePgVector
        ? `[${Array.from(rec.embedding).join(",")}]`
        : JSON.stringify(Array.from(rec.embedding))
      : null;

    await pool.query(
      `INSERT INTO symbio_memories
         (id, agent, kind, content, summary, topics, importance, session_id, created_at, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         summary = EXCLUDED.summary,
         topics  = EXCLUDED.topics,
         importance = EXCLUDED.importance,
         embedding = EXCLUDED.embedding`,
      [
        rec.id,
        rec.agent,
        rec.kind,
        rec.content,
        rec.summary ?? null,
        rec.topics ?? null,
        rec.importance ?? 0.5,
        rec.sessionId ?? null,
        rec.createdAt,
        embeddingValue,
      ],
    );
  } catch (e) {
    console.warn("[Symbio] Postgres sync failed (kept locally):", (e as Error).message);
  }
}

/**
 * Semantic search against Postgres. Returns matching memory contents.
 * Used as an extra recall source when Postgres holds memories from other
 * machines/agents that aren't in the local SQLite store.
 */
export async function searchPostgres(
  agent: string,
  queryEmbedding: Float32Array | null,
  queryText: string,
  limit: number,
): Promise<Array<{ content: string; summary?: string; createdAt: string; score: number }>> {
  if (!enabled || !pool) return [];
  try {
    if (usePgVector && queryEmbedding) {
      const vecLiteral = `[${Array.from(queryEmbedding).join(",")}]`;
      const { rows } = await pool.query(
        `SELECT content, summary, created_at,
                1 - (embedding <=> $2::vector) AS score
         FROM symbio_memories
         WHERE agent = $1 AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        [agent, vecLiteral, limit],
      );
      return rows.map((r: Record<string, unknown>) => ({
        content: String(r.content),
        summary: r.summary ? String(r.summary) : undefined,
        createdAt: new Date(r.created_at as string).toISOString(),
        score: Number(r.score) || 0,
      }));
    }

    // Keyword fallback
    const { rows } = await pool.query(
      `SELECT content, summary, created_at
       FROM symbio_memories
       WHERE agent = $1 AND (content ILIKE $2 OR summary ILIKE $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [agent, `%${queryText}%`, limit],
    );
    return rows.map((r: Record<string, unknown>) => ({
      content: String(r.content),
      summary: r.summary ? String(r.summary) : undefined,
      createdAt: new Date(r.created_at as string).toISOString(),
      score: 0.5,
    }));
  } catch (e) {
    console.warn("[Symbio] Postgres search failed:", (e as Error).message);
    return [];
  }
}

/** Close the pool (called on quit). */
export async function closePostgresMemory(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    pool = null;
    enabled = false;
  }
}
