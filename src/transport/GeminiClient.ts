/**
 * Symbio Gemini Client
 *
 * Handles screen vision and live speech through Google's Gemini API.
 * Gemini provides both vision (understanding screenshots) and
 * real-time speech in a single API, which is perfect for Symbio.
 */

import { config } from "../config";

export interface VisionResult {
  description: string;
  objects?: string[];
  text?: string;
  actions?: string[];
}

export interface SpeechResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
}

export class GeminiClient {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = config.geminiApiKey;
    this.model = config.visionModel || "gemini-3.5-flash"; // Configurable vision model
  }

  /**
   * Analyze a screenshot with Gemini Vision
   *
   * Takes a base64-encoded screenshot and returns a description
   * of what's on screen. The companion uses this to "see" what
   * the user is doing.
   */
  async analyzeScreenshot(
    imageBase64: string,
    prompt?: string,
  ): Promise<VisionResult> {
    if (!this.apiKey) {
      console.warn("[Symbio] Gemini API key not configured");
      return { description: "Vision not available — Gemini API key missing" };
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text:
                      prompt ||
                      `You are ${config.agentConfig.displayName}, a symbiotic AI companion living on the user's desktop. You can see their screen. Describe what you see briefly and naturally, as if you're looking over their shoulder. What are they working on? Any interesting details? Keep it under 100 words.`,
                  },
                  {
                    inline_data: {
                      mime_type: "image/png",
                      data: imageBase64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 200,
            },
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        console.error("[Symbio] Gemini vision error:", error);
        return { description: "I couldn't see the screen clearly." };
      }

      const data = await response.json();
      const text =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "I can see your screen but couldn't describe it.";

      return {
        description: text,
      };
    } catch (error) {
      console.error("[Symbio] Gemini vision error:", error);
      return { description: "My vision is having trouble right now." };
    }
  }

  /**
   * Check if Gemini is configured
   */
  get isConfigured(): boolean {
    return !!this.apiKey;
  }
}

export const geminiClient = new GeminiClient();