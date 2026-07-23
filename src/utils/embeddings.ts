/**
 * Symbio Basic — Embeddings Client
 *
 * Turns text into vectors so memories can be searched by *meaning*, not
 * just keywords. "What did we decide about the avatar?" should find the
 * conversation about picking Cosmo even if the word "decide" was never used.
 *
 * This is provider-agnostic — it speaks the OpenAI `/v1/embeddings` format,
 * which is supported by OpenAI, Ollama, LM Studio, vLLM, LocalAI, and most
 * other inference servers. Configure it with EMBEDDING_API_URL / _MODEL / _KEY.
 *
 * Memory is GOLD — but it must never break the app. If embeddings aren't
 * configured or the endpoint is down, every function here degrades quietly
 * and the memory engine falls back to keyword search. The companion still
 * remembers; it just searches a little less cleverly.
 */

import { config } from "../config";

/** True if an embedding endpoint + model are configured. */
export function embeddingsEnabled(): boolean {
  return Boolean(config.embeddingApiUrl && config.embeddingModel);
}

/**
 * Normalize the embedding base URL into a full endpoint.
 * Accepts any of:
 *   https://api.openai.com/v1
 *   https://api.openai.com/v1/embeddings
 *   http://localhost:11434            (Ollama — we add /v1/embeddings)
 */
function resolveEmbeddingUrl(): string {
  let url = config.embeddingApiUrl.trim().replace(/\/+$/, "");
  if (url.endsWith("/embeddings")) return url;
  if (url.endsWith("/v1")) return `${url}/embeddings`;
  return `${url}/v1/embeddings`;
}

/**
 * Embed a single piece of text. Returns a Float32 vector, or null if
 * embeddings are disabled or the request fails (caller falls back to
 * keyword search).
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (!embeddingsEnabled()) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;

  try {
    const res = await fetch(resolveEmbeddingUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.embeddingApiKey
          ? { Authorization: `Bearer ${config.embeddingApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: clean,
      }),
    });

    if (!res.ok) {
      console.warn(
        `[Symbio] Embedding request failed (${res.status}) — falling back to keyword search`,
      );
      return null;
    }

    const data = await res.json();
    const vec: number[] | undefined = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      console.warn("[Symbio] Embedding response had no vector");
      return null;
    }
    return Float32Array.from(vec);
  } catch (e) {
    console.warn("[Symbio] Embedding error:", (e as Error).message);
    return null;
  }
}

/**
 * Cosine similarity between two vectors (range -1..1, higher = closer).
 * Used as a fallback ranking when sqlite-vec isn't available.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Pack a Float32Array into a Buffer for storage in SQLite/Postgres. */
export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a Buffer back into a Float32Array. */
export function bufferToVector(buf: Buffer): Float32Array {
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}
