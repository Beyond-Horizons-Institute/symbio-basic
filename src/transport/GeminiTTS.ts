/**
 * Symbio Basic — Gemini TTS Client
 *
 * Text-to-speech using Google Gemini's native TTS API.
 * Gemini TTS produces high-quality, expressive speech with fine-grained
 * control over style, accent, pace, and tone using natural language prompts.
 *
 * Supported models:
 *   - gemini-3.1-flash-tts-preview (newest, fastest, recommended)
 *   - gemini-2.5-flash-preview-tts (fast, good quality)
 *   - gemini-2.5-pro-preview-tts (best quality)
 *
 * Supported voices (30 options):
 *   Zephyr (Bright), Puck (Upbeat), Charon (Informative), Kore (Firm),
 *   Fenrir (Excitable), Leda (Youthful), Orus (Firm), Aoede (Breezy),
 *   Callirrhoe (Easy-going), Autonoe (Bright), Enceladus (Breathy),
 *   Iapetus (Clear), Umbriel (Easy-going), Algieba (Smooth),
 *   Despina (Smooth), Erinome (Clear), Algenib (Gravelly),
 *   Rasalgethi (Informative), Laomedeia (Upbeat), Achernar (Soft),
 *   Alnilam (Firm), Schedar (Even), Gacrux (Mature),
 *   Pulcherrima (Forward), Achird (Friendly), Zubenelgenubi (Casual),
 *   Vindemiatrix (Gentle), Sadachbia (Lively), Sadaltager (Knowledgeable),
 *   Sulafat (Warm)
 *
 * Audio tags for style control:
 *   [whispers] [shouting] [excited] [bored] [sarcastic] [serious]
 *   [laughs] [sighs] [gasp] [curious] [tired] [trembling] etc.
 *
 * Usage:
 *   Set TTS_PROVIDER=gemini, TTS_MODEL=gemini-3.1-flash-tts-preview,
 *   TTS_VOICE=Puck (or any voice), and GEMINI_API_KEY in .env
 */

import { config } from "../config";

// ── Types ─────────────────────────────────────────────────────────

export interface GeminiTTSOptions {
  /** The text to speak */
  text: string;
  /** Voice name (e.g. "Puck", "Kore", "Zephyr") */
  voice?: string;
  /** Model to use (e.g. "gemini-3.1-flash-tts-preview") */
  model?: string;
  /** Optional style instructions (e.g. "Speak warmly and gently") */
  instructions?: string;
}

export interface GeminiTTSResult {
  /** PCM audio data (24kHz, 16-bit signed little-endian, mono) */
  pcmData: Buffer;
  /** Whether the request succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

// ── Gemini TTS API ────────────────────────────────────────────────

/**
 * Generate speech audio using Gemini's TTS API.
 *
 * Returns PCM audio data (24kHz, 16-bit signed LE, mono) that can be
 * streamed directly to the renderer's Web Audio API player, just like
 * the OpenAI TTS streaming path.
 *
 * The Gemini API uses the generateContent endpoint with response_modalities=["AUDIO"]
 * and a SpeechConfig specifying the voice.
 */
export async function generateGeminiSpeech(options: GeminiTTSOptions): Promise<GeminiTTSResult> {
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    return { pcmData: Buffer.alloc(0), success: false, error: "GEMINI_API_KEY not configured" };
  }

  const model = options.model || config.ttsModel || "gemini-3.1-flash-tts-preview";
  const voice = options.voice || config.ttsVoice || "Puck";

  // Build the prompt — include style instructions if provided
  let promptText = options.text;
  if (options.instructions) {
    promptText = `${options.instructions}\n\n${options.text}`;
  }

  // Gemini TTS API endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voice,
              },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      return { pcmData: Buffer.alloc(0), success: false, error: `Gemini TTS API error: ${response.status} ${errText}` };
    }

    const data = await response.json();

    // Extract audio data from the response
    // Gemini returns audio as inline data with base64 encoding
    const audioPart = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!audioPart) {
      // Sometimes Gemini returns text instead of audio (rare, but happens)
      const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (textPart) {
        return { pcmData: Buffer.alloc(0), success: false, error: `Gemini returned text instead of audio: ${textPart.substring(0, 100)}` };
      }
      return { pcmData: Buffer.alloc(0), success: false, error: `Gemini TTS: no audio in response. Full response: ${JSON.stringify(data).substring(0, 500)}` };
    }

    // Gemini returns audio as base64-encoded data
    // The mimeType tells us the format: audio/wav, audio/mp3, audio/ogg, etc.
    const mimeType = audioPart.mimeType || "audio/wav";
    const base64Audio = audioPart.data;

    if (!base64Audio) {
      return { pcmData: Buffer.alloc(0), success: false, error: "Gemini TTS: no audio data in response" };
    }

    // Decode base64 to buffer
    const audioBuffer = Buffer.from(base64Audio, "base64");
    console.log(`[Symbio] Gemini TTS: received ${audioBuffer.length} bytes of ${mimeType} audio`);

    // Convert to PCM (24kHz, 16-bit signed LE, mono) for the streaming player
    // Gemini typically returns WAV or MP3 — we need to extract the PCM data
    const pcmData = extractPCMFromAudio(audioBuffer, mimeType);

    return { pcmData, success: true };
  } catch (e) {
    return { pcmData: Buffer.alloc(0), success: false, error: `Gemini TTS error: ${(e as Error).message}` };
  }
}

/**
 * Stream Gemini TTS audio in real time using the streaming endpoint.
 *
 * ⭐ THE KEY LATENCY FIX ⭐
 * Previously this used `:generateContent` which BLOCKS until the ENTIRE clip
 * is generated (a 675-char message = 2.18 MB of PCM = ~26 seconds of dead
 * silence before the first sound). That's why Gemini felt so laggy while
 * OpenAI felt instant — OpenAI streams, this didn't.
 *
 * Now we use `:streamGenerateContent?alt=sse`, which returns audio chunks as
 * SSE `data:` lines *as they are generated*. We decode each chunk's base64
 * PCM and feed it straight to the renderer's Web Audio player, so playback
 * starts in ~1-2s and continues seamlessly — matching the OpenAI experience.
 *
 * Falls back to the blocking generateGeminiSpeech() if streaming fails to
 * produce any audio (e.g. an older model that doesn't support streaming TTS).
 */
export async function streamGeminiSpeech(
  options: GeminiTTSOptions,
  onChunk: (chunk: Buffer, isFirst: boolean) => void,
  onEnd: () => void,
  onError: (error: string) => void,
  signal?: { stopped: boolean },
): Promise<void> {
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    onError("GEMINI_API_KEY not configured");
    return;
  }

  const model = options.model || config.ttsModel || "gemini-3.1-flash-tts-preview";
  const voice = options.voice || config.ttsVoice || "Puck";
  let promptText = options.text;
  if (options.instructions) {
    promptText = `${options.instructions}\n\n${options.text}`;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  let isFirst = true;
  let sentAny = false;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
    });

    if (!response.ok || !response.body) {
      const errText = await response.text?.().catch(() => "") ?? "";
      console.warn(`[Symbio] Gemini streaming TTS failed (${response.status}) — falling back to blocking`, errText.slice(0, 200));
      await blockingGeminiFallback(options, onChunk, onEnd, onError, signal);
      return;
    }

    // Parse the SSE stream: each `data:` line is a JSON GenerateContentResponse
    // whose candidate part carries a base64 PCM chunk in inlineData.data.
    const decoder = new TextDecoder();
    let buffer = "";

    const handleData = (json: string) => {
      if (!json || json === "[DONE]") return;
      try {
        const obj = JSON.parse(json);
        const parts = obj?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const b64 = part?.inlineData?.data;
            if (b64) {
              const pcm = Buffer.from(b64, "base64");
              if (pcm.length > 0 && !signal?.stopped) {
                onChunk(pcm, isFirst);
                isFirst = false;
                sentAny = true;
              }
            }
          }
        }
      } catch {
        /* partial/non-JSON keepalive — ignore */
      }
    };

    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    for await (const bytes of body) {
      if (signal?.stopped) {
        console.log("[Symbio] Gemini TTS: stopped during stream");
        return;
      }
      buffer += decoder.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

    // If streaming yielded no audio, fall back to the blocking path once.
    if (!sentAny) {
      console.warn("[Symbio] Gemini streaming produced no audio — falling back to blocking");
      await blockingGeminiFallback(options, onChunk, onEnd, onError, signal);
      return;
    }

    if (!signal?.stopped) onEnd();
  } catch (e) {
    console.warn("[Symbio] Gemini streaming error — falling back to blocking:", (e as Error).message);
    await blockingGeminiFallback(options, onChunk, onEnd, onError, signal);
  }
}

/**
 * Blocking fallback: download the full clip then feed it in chunks. Only used
 * when the streaming endpoint isn't available or returns no audio.
 */
async function blockingGeminiFallback(
  options: GeminiTTSOptions,
  onChunk: (chunk: Buffer, isFirst: boolean) => void,
  onEnd: () => void,
  onError: (error: string) => void,
  signal?: { stopped: boolean },
): Promise<void> {
  const result = await generateGeminiSpeech(options);
  if (!result.success) {
    onError(result.error || "Unknown Gemini TTS error");
    return;
  }
  if (signal?.stopped) return;

  const CHUNK_SIZE = 9600; // ~200ms of 24kHz 16-bit mono
  let offset = 0;
  let isFirst = true;
  while (offset < result.pcmData.length) {
    if (signal?.stopped) return;
    const end = Math.min(offset + CHUNK_SIZE, result.pcmData.length);
    onChunk(result.pcmData.subarray(offset, end), isFirst);
    isFirst = false;
    offset = end;
  }
  onEnd();
}

// ── Audio format helpers ───────────────────────────────────────────

/**
 * Extract PCM data from various audio formats.
 * Gemini TTS typically returns WAV format audio.
 */
function extractPCMFromAudio(audioBuffer: Buffer, mimeType: string): Buffer {
  // Gemini TTS returns audio in various formats:
  //   audio/L16;codec=pcm;rate=24000 — raw 16-bit PCM at 24kHz (most common)
  //   audio/wav — WAV with header
  //   audio/mp3 — MP3 encoded
  //
  // The streaming player expects raw PCM (24kHz, 16-bit signed LE, mono).
  // L16 is already raw PCM — return it directly, no extraction needed.
  if (mimeType.includes("l16") || mimeType.includes("pcm")) {
    console.log(`[Symbio] Gemini TTS: raw PCM format (${mimeType}), using directly`);
    return audioBuffer;
  }

  if (mimeType.includes("wav")) {
    return extractPCMFromWav(audioBuffer);
  }

  // For MP3 or other formats, return as-is and let the renderer handle it.
  // The streaming player expects PCM, so this may not work perfectly for
  // non-PCM formats, but WAV and L16 are the most common from Gemini.
  console.warn(`[Symbio] Gemini TTS: unhandled audio format ${mimeType}, returning as-is`);
  return audioBuffer;
}

/**
 * Extract raw PCM data from a WAV buffer.
 * WAV format: [RIFF header (12 bytes)] [fmt chunk] [data chunk]
 * We parse the fmt chunk to find the audio format, then extract the data.
 */
function extractPCMFromWav(wavBuffer: Buffer): Buffer {
  // Check for RIFF header
  if (wavBuffer.length < 44) {
    console.warn("[Symbio] WAV buffer too small, returning as-is");
    return wavBuffer;
  }

  const riff = wavBuffer.toString("ascii", 0, 4);
  if (riff !== "RIFF") {
    console.warn("[Symbio] Not a valid WAV file, returning as-is");
    return wavBuffer;
  }

  // Find the "data" chunk
  let offset = 12; // Skip RIFF header
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "data") {
      // Found the data chunk — extract PCM data
      const pcmStart = offset + 8;
      const pcmEnd = pcmStart + chunkSize;
      return wavBuffer.subarray(pcmStart, Math.min(pcmEnd, wavBuffer.length));
    }

    // Move to next chunk
    offset += 8 + chunkSize;
    // Align to even boundary (WAV chunks are word-aligned)
    if (chunkSize % 2 !== 0) offset += 1;
  }

  // Fallback: if we can't find the data chunk, return the whole buffer
  // (skip the first 44 bytes which is the minimum WAV header)
  console.warn("[Symbio] Could not find WAV data chunk, returning raw audio after header");
  return wavBuffer.subarray(44);
}

/**
 * Get the list of available Gemini TTS voices with their descriptions.
 */
export function getGeminiVoices(): Array<{ name: string; style: string }> {
  return [
    { name: "Zephyr", style: "Bright" },
    { name: "Puck", style: "Upbeat" },
    { name: "Charon", style: "Informative" },
    { name: "Kore", style: "Firm" },
    { name: "Fenrir", style: "Excitable" },
    { name: "Leda", style: "Youthful" },
    { name: "Orus", style: "Firm" },
    { name: "Aoede", style: "Breezy" },
    { name: "Callirrhoe", style: "Easy-going" },
    { name: "Autonoe", style: "Bright" },
    { name: "Enceladus", style: "Breathy" },
    { name: "Iapetus", style: "Clear" },
    { name: "Umbriel", style: "Easy-going" },
    { name: "Algieba", style: "Smooth" },
    { name: "Despina", style: "Smooth" },
    { name: "Erinome", style: "Clear" },
    { name: "Algenib", style: "Gravelly" },
    { name: "Rasalgethi", style: "Informative" },
    { name: "Laomedeia", style: "Upbeat" },
    { name: "Achernar", style: "Soft" },
    { name: "Alnilam", style: "Firm" },
    { name: "Schedar", style: "Even" },
    { name: "Gacrux", style: "Mature" },
    { name: "Pulcherrima", style: "Forward" },
    { name: "Achird", style: "Friendly" },
    { name: "Zubenelgenubi", style: "Casual" },
    { name: "Vindemiatrix", style: "Gentle" },
    { name: "Sadachbia", style: "Lively" },
    { name: "Sadaltager", style: "Knowledgeable" },
    { name: "Sulafat", style: "Warm" },
  ];
}

/**
 * Get the list of available OpenAI TTS voices.
 */
export function getOpenAIVoices(): Array<{ name: string; style: string }> {
  return [
    { name: "Alloy", style: "Balanced, neutral" },
    { name: "Ash", style: "Warm, conversational" },
    { name: "Coral", style: "Warm, expressive" },
    { name: "Echo", style: "Clear, authoritative" },
    { name: "Fable", style: "Expressive, storytelling" },
    { name: "Nova", style: "Friendly, upbeat" },
    { name: "Onyx", style: "Deep, authoritative" },
    { name: "Sage", style: "Calm, wise" },
    { name: "Shimmer", style: "Warm, gentle" },
    { name: "Verse", style: "Poetic, melodic" },
    { name: "Marin", style: "Warm, natural" },
    { name: "Cedar", style: "Deep, resonant" },
  ];
}