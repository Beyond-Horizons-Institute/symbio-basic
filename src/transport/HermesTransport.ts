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

    super({
      api: `${apiUrl}/v1/chat/completions`,
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      body: {
        // The "model" field tells Hermes which agent to route to.
        // We use the dynamic agent name so switching works.
        model: agentName,
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
    const response = await fetch(
      `${apiUrl}/v1/chat/completions`,
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
      // Fallback: try the agent endpoint
      return await callHermesAgentEndpoint(
        messages[messages.length - 1]?.content || "",
        agentName,
      );
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
    console.error("[Symbio] Hermes gateway error:", error);
    return await callHermesAgentEndpoint(
      messages[messages.length - 1]?.content || "",
      agentName,
    );
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
    const response = await fetch(`${apiUrl}/gateway/${name}`, {
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