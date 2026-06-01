/**
 * Symbio STT Client
 *
 * Speech-to-text using OpenAI's Whisper API.
 * This is the same STT used in the Skyrim bridge —
 * it's reliable, fast, and reasonably priced.
 */

import { config } from "../config";

export interface STTResult {
  text: string;
  language?: string;
  duration?: number;
}

export class STTClient {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = config.openaiApiKey;
    this.model = "whisper-1";
  }

  /**
   * Transcribe audio to text using OpenAI Whisper
   *
   * Takes an audio blob and returns the transcribed text.
   * This is used for the hot mic feature — when the user speaks,
   * we transcribe it and send it to the agent.
   */
  async transcribe(audioBlob: Blob): Promise<STTResult> {
    if (!this.apiKey) {
      console.warn("[Symbio] OpenAI API key not configured for STT");
      return { text: "" };
    }

    try {
      const formData = new FormData();
      const file = new File([audioBlob], "voice.wav", {
        type: "audio/wav",
      });
      formData.append("file", file);
      formData.append("model", this.model);
      formData.append(
        "language",
        "en",
      ); // TODO: Make configurable

      const response = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const error = await response.text();
        console.error("[Symbio] STT error:", error);
        return { text: "" };
      }

      const data = await response.json();
      return {
        text: data.text || "",
        language: data.language,
        duration: data.duration,
      };
    } catch (error) {
      console.error("[Symbio] STT error:", error);
      return { text: "" };
    }
  }

  /**
   * Check if STT is configured
   */
  get isConfigured(): boolean {
    return !!this.apiKey;
  }
}

export const sttClient = new STTClient();