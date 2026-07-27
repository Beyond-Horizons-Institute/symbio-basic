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
 * How a piece of text is being embedded:
 *   "document" — a memory we're STORING (the thing to be found later)
 *   "query"    — a search we're RUNNING (what we're looking for)
 * Symmetric models ignore this; asymmetric ones recall much better with it.
 */
export type EmbedKind = "document" | "query";

/**
 * Resolve which prefix style to use for the configured model.
 * "auto" inspects the model name so it "just works" without extra config.
 * Anything unrecognized → "none" (a safe no-op for symmetric models).
 */
function resolvePrefixStyle(): "none" | "nomic" | "gemma" {
  const style = (config.embeddingPrefixStyle || "auto").toLowerCase();
  if (style === "none" || style === "nomic" || style === "gemma") return style;
  // auto-detect from the model name
  const model = (config.embeddingModel || "").toLowerCase();
  if (model.includes("nomic")) return "nomic";
  if (model.includes("gemma")) return "gemma"; // embeddinggemma
  return "none";
}

/**
 * Apply the model-appropriate task prefix to a piece of text. Asymmetric
 * embedding models line up query and document vectors much better when the
 * text is tagged with what it's for. This is a no-op for symmetric models
 * (e.g. OpenAI text-embedding-3-*), so it never hurts recall — it only helps.
 */
function applyPrefix(text: string, kind: EmbedKind): string {
  switch (resolvePrefixStyle()) {
    case "nomic":
      // nomic-embed-text asymmetric prefixes
      return kind === "query" ? `search_query: ${text}` : `search_document: ${text}`;
    case "gemma":
      // embeddinggemma prompt format
      return kind === "query"
        ? `task: search result | query: ${text}`
        : `title: none | text: ${text}`;
    default:
      return text;
  }
}

/**
 * Embed a single piece of text. Returns a Float32 vector, or null if
 * embeddings are disabled or the request fails (caller falls back to
 * keyword search).
 *
 * `kind` tells asymmetric models whether this is a stored memory
 * ("document", the default) or a live search ("query"). It's harmless for
 * symmetric models, so callers can always pass the honest value.
 */
export async function embedText(
  text: string,
  kind: EmbedKind = "document",
): Promise<Float32Array | null> {
  if (!embeddingsEnabled()) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;

  const prepared = applyPrefix(clean, kind);

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
        input: prepared,
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
