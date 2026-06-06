/**
 * Symbio Basic — AI Gateway Transport
 *
 * ⭐ THIS IS THE BRAIN OF YOUR COMPANION ⭐
 *
 * Custom chat transport that connects to an OpenAI-compatible API gateway.
 * The recommended gateway is Hermes — an open-source AI agent framework:
 *   https://github.com/nousresearch/hermes-agent
 *
 * But Symbio Basic works with ANY OpenAI-compatible API:
 *   - Hermes (recommended — full tools, memory, personality)
 *   - OpenAI API (direct)
 *   - Ollama (local models)
 *   - LM Studio (local models)
 *   - vLLM (local models)
 *   - Any server providing /v1/chat/completions
 *
 * Set HERMES_API_URL and HERMES_API_KEY in .env to configure.
 */

import { DefaultChatTransport, type UIMessage } from "ai";
import { config, COMPANIONS } from "../config";

// ── Dynamic agent state ──────────────────────────────────────────
// This module-level state is updated when the user switches agents.
// The HermesTransport reads from this instead of the static config,
// so chat requests always use the current agent's name, API key, and URL.
let dynamicAgentName = config.agentName;
let dynamicApiKey = config.agentConfig.hermesApiKey || config.hermesApiKey;
let dynamicApiUrl = config.agentConfig.hermesApiUrl || config.hermesApiUrl;

export function updateDynamicAgent(agentName: string, apiKey: string, apiUrl: string) {
  dynamicAgentName = agentName;
  dynamicApiKey = apiKey;
  dynamicApiUrl = apiUrl;
}

export function getDynamicAgentName() {
  return dynamicAgentName;
}

export function getDynamicApiKey() {
  return dynamicApiKey;
}

export function getDynamicApiUrl() {
  return dynamicApiUrl;
}

export interface HermesMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface HermesMemory {
  type: "prefetch" | "associative" | "sync";
  content: string;
  relevance: number;
}

export interface HermesToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface HermesResponse {
  message: string;
  memories?: HermesMemory[];
  toolCalls?: HermesToolCall[];
  emotion?: string;
  animation?: string;
}

/**
 * HermesTransport — connects Symbio to the Hermes gateway
 *
 * Uses DefaultChatTransport with the Hermes gateway URL.
 * Hermes provides an OpenAI-compatible /v1/chat/completions endpoint,
 * so we can use the standard transport and just point it at our server.
 *
 * The agent name is passed as the "model" parameter, which Hermes
 * routes to the correct agent with their SOUL.md, memory, and tools.
 *
 * When the user switches agents, call updateAgent() to change
 * the model name and API key without recreating the transport.
 */
export class HermesTransport extends DefaultChatTransport<UIMessage> {
  constructor() {
    const agentName = getDynamicAgentName();
    const apiKey = getDynamicApiKey();
    const apiUrl = getDynamicApiUrl();

    // If LLM_MODEL is set (e.g. for OpenRouter, OpenAI, Ollama), use it.
    // Otherwise, use the agent name (Hermes routes by agent name).
    const modelName = config.llmModel || agentName;

    // Build the chat completions URL.
    // Some gateways (OpenRouter, OpenAI) already include /v1 in their base URL,
    // while others (Hermes, Ollama, LM Studio) expect /v1 to be appended.
    // We normalize by removing a trailing /v1 if present, then always append /v1/chat/completions.
    const normalizedUrl = apiUrl.replace(/\/v1\/?$/, '');
    const chatUrl = `${normalizedUrl}/v1/chat/completions`;

    super({
      api: chatUrl,
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      body: {
        // The "model" field tells the gateway which model/agent to use.
        // For Hermes: the agent name routes to the correct agent.
        // For other gateways: LLM_MODEL specifies the model (e.g. gpt-4o).
        model: modelName,
        extra: {
          agent: agentName,
          source: "symbio",
          include_memories: true,
          include_tools: true,
        },
      },
    });
  }
}

/**
 * Direct Hermes API call (for non-streaming use cases)
 *
 * Use this when you need a simple request/response without
 * the AI SDK's streaming infrastructure.
 */
export async function callHermes(
  messages: HermesMessage[],
  options?: {
    agentName?: string;
    includeMemories?: boolean;
    includeTools?: boolean;
  },
): Promise<HermesResponse> {
  const agentName = options?.agentName || getDynamicAgentName();
  const apiKey = getDynamicApiKey();
  const apiUrl = getDynamicApiUrl();

  try {
    // Normalize URL to avoid double /v1 (OpenRouter already has /v1)
    const normalizedUrl = apiUrl.replace(/\/v1\/?$/, '');
    const response = await fetch(
      `${normalizedUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: agentName,
          messages,
          stream: false,
          extra: {
            agent: agentName,
            source: "symbio",
            include_memories: options?.includeMemories ?? true,
            include_tools: options?.includeTools ?? true,
          },
        }),
      },
    );

    if (!response.ok) {
      // For Hermes gateways, try the agent endpoint as fallback.
      // For other gateways (OpenRouter, OpenAI, etc.), just throw the error.
      const isHermesGateway = apiUrl.includes("localhost") || apiUrl.includes("8642");
      if (isHermesGateway) {
        return await callHermesAgentEndpoint(
          messages[messages.length - 1]?.content || "",
          agentName,
        );
      }
      const errorText = await response.text().catch(() => "");
      throw new Error(`API returned ${response.status}: ${errorText || response.statusText}`);
    }

    const data = await response.json();
    const message =
      data.choices?.[0]?.message?.content ||
      data.response ||
      data.message ||
      "I'm having trouble connecting to my brain. Give me a moment...";

    return {
      message,
      memories: data.memories || [],
      toolCalls: data.tool_calls || [],
      emotion: data.emotion || "neutral",
      animation: data.animation,
    };
  } catch (error) {
    console.error("[Symbio] Gateway error:", error);
    // For Hermes gateways, try the agent endpoint as fallback.
    // For other gateways, return an error message.
    const isHermesGateway = apiUrl.includes("localhost") || apiUrl.includes("8642");
    if (isHermesGateway) {
      return await callHermesAgentEndpoint(
        messages[messages.length - 1]?.content || "",
        agentName,
      );
    }
    return {
      message: "I can't reach my brain right now. Please check your gateway connection and API key.",
      emotion: "sad",
    };
  }
}

/**
 * Fallback: Call the Hermes agent endpoint directly
 */
async function callHermesAgentEndpoint(
  message: string,
  agentName?: string,
): Promise<HermesResponse> {
  const name = agentName || getDynamicAgentName();
  const apiKey = getDynamicApiKey();
  const apiUrl = getDynamicApiUrl();

  try {
    // Normalize URL — remove trailing /v1 if present (Hermes gateway endpoint doesn't use /v1)
    const normalizedUrl = apiUrl.replace(/\/v1\/?$/, '');
    const response = await fetch(`${normalizedUrl}/gateway/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        message,
        source: "symbio",
        include_memories: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Hermes agent endpoint returned ${response.status}`);
    }

    const data = await response.json();
    return {
      message:
        data.response ||
        data.message ||
        data.content ||
        "I'm having trouble reaching my brain. Try again?",
      memories: data.memories || [],
      emotion: data.emotion || "neutral",
      animation: data.animation,
    };
  } catch (error) {
    console.error("[Symbio] Hermes agent endpoint error:", error);
    return {
      message:
        "I can't reach my brain right now. The Hermes gateway might be down. Could you check if the agents are running?",
      emotion: "sad",
    };
  }
}