/**
 * Symbio Basic — Hermes Runs Transport
 *
 * ⭐ THIS UNLOCKS AUTONOMOUS AGENT BEHAVIOR IN SYMBIO ⭐
 *
 * Unlike the HermesTransport (which uses /v1/chat/completions — a request-response
 * model where the agent is destroyed after each response), the RunsTransport uses
 * the /v1/runs API which lets the agent keep working after sending its initial
 * response.
 *
 * How it works:
 * 1. User sends a message → POST /v1/runs with the message
 * 2. Server returns run_id immediately (HTTP 202)
 * 3. We subscribe to GET /v1/runs/{run_id}/events (SSE stream)
 * 4. Events flow in real-time: message.delta, tool.started, tool.completed, run.completed
 * 5. The agent can make tool calls, run terminal commands, search the web — all
 *    while we see the progress in real-time
 * 6. When the agent is truly done, we get run.completed
 *
 * This gives Symbio agents the same "zip zap" capability as Discord/Telegram agents,
 * because the agent isn't destroyed after one response — it keeps running until
 * it's genuinely finished.
 *
 * Falls back to HermesTransport (chat/completions) if the runs API isn't available.
 */

import { config } from "../config";
import {
  getDynamicAgentName,
  getDynamicApiKey,
  getDynamicApiUrl,
  type HermesResponse,
} from "./HermesTransport";

// ── Types ──────────────────────────────────────────────────────────

interface RunStartResult {
  run_id: string;
  status: string;
  session_id?: string;
}

export interface RunEvent {
  event: string;
  run_id: string;
  timestamp: number;
  // message.delta events
  delta?: string;
  // tool events
  tool?: string;
  toolCallId?: string;
  status?: string;
  label?: string;
  emoji?: string;
  preview?: string;
  duration?: number;
  error?: boolean;
  // run.completed events
  output?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  // run.failed events
  message?: string;
  // approval events
  choices?: string[];
  approval_id?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
}

export interface RunsTransportConfig {
  apiUrl: string;
  apiKey: string;
  agentName: string;
  sessionKey?: string;
}

// ── RunsTransport ───────────────────────────────────────────────────

/**
 * RunsTransport — connects Symbio to the Hermes /v1/runs API
 *
 * This transport starts an agent "run" and streams events back to the UI.
 * The agent runs autonomously — it can make tool calls, think, and act
 * beyond just sending one response.
 *
 * Usage:
 *   const transport = new RunsTransport();
 *   const result = await transport.send("Hello!");
 *   // result.events contains all the events from the run
 *   // result.text contains the final response
 *   // result.toolCalls contains tool call info
 */
export class RunsTransport {
  private config: RunsTransportConfig;
  private _currentRunId: string | null = null;
  private currentEventSource: EventSource | null = null;
  private sessionId: string | null = null;

  constructor(config?: Partial<RunsTransportConfig>) {
    this.config = {
      apiUrl: config?.apiUrl || getDynamicApiUrl(),
      apiKey: config?.apiKey || getDynamicApiKey(),
      agentName: config?.agentName || getDynamicAgentName(),
      sessionKey: config?.sessionKey,
    };
  }

  /**
   * Normalize the API URL — remove trailing /v1 if present
   */
  private getBaseUrl(): string {
    return this.config.apiUrl.replace(/\/v1\/?$/, '');
  }

  /**
   * Get auth headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    if (this.sessionId) {
      headers["X-Hermes-Session-Id"] = this.sessionId;
    }
    if (this.config.sessionKey) {
      headers["X-Hermes-Session-Key"] = this.config.sessionKey;
    }
    return headers;
  }

  /**
   * Start a new agent run and stream events.
   *
   * This is the main entry point. It:
   * 1. POSTs to /v1/runs to start the agent
   * 2. Opens an SSE connection to /v1/runs/{run_id}/events
   * 3. Collects all events and returns the final result
   *
   * The onEvent callback fires for each event as it arrives,
   * enabling real-time UI updates (streaming text, tool progress, etc.)
   */
  async send(
    message: string,
    options?: {
      conversationHistory?: Array<{ role: string; content: string }>;
      instructions?: string;
      onEvent?: (event: RunEvent) => void;
      onTextDelta?: (delta: string) => void;
      onToolStart?: (tool: string, label: string, emoji?: string) => void;
      onToolComplete?: (tool: string, duration?: number) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<RunsResult> {
    const baseUrl = this.getBaseUrl();
    const modelName = config.llmModel || this.config.agentName;

    // Step 1: Start the run
    const startResponse = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: modelName,
        input: message,
        instructions: options?.instructions,
        conversation_history: options?.conversationHistory,
        session_id: this.sessionId || undefined,
        extra: {
          agent: this.config.agentName,
          source: "symbio",
          include_memories: true,
          include_tools: true,
        },
      }),
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text().catch(() => "");
      throw new Error(`Failed to start run: ${startResponse.status} ${errorText}`);
    }

    const startData: RunStartResult = await startResponse.json();
    this._currentRunId = startData.run_id;

    // Save session_id for continuity
    if (startData.session_id) {
      this.sessionId = startData.session_id;
    }

    // Step 2: Subscribe to events
    return this.subscribeToEvents(startData.run_id, options);
  }

  /**
   * Subscribe to the SSE event stream for a run.
   *
   * Opens an EventSource connection to /v1/runs/{run_id}/events
   * and collects all events until the run completes or fails.
   */
  private async subscribeToEvents(
    runId: string,
    options?: {
      onEvent?: (event: RunEvent) => void;
      onTextDelta?: (delta: string) => void;
      onToolStart?: (tool: string, label: string, emoji?: string) => void;
      onToolComplete?: (tool: string, duration?: number) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<RunsResult> {
    const baseUrl = this.getBaseUrl();
    const eventsUrl = `${baseUrl}/v1/runs/${runId}/events`;

    return new Promise((resolve, reject) => {
      const textParts: string[] = [];
      const toolCalls: RunToolCall[] = [];
      let finalOutput = "";
      let finalUsage: RunsResult["usage"] | undefined;
      let runError: string | undefined;

      // Use fetch + ReadableStream for SSE parsing (more reliable than EventSource
      // in Electron/renderer contexts, and supports auth headers)
      const fetchEvents = async () => {
        try {
          const response = await fetch(eventsUrl, {
            method: "GET",
            headers: this.getHeaders(),
            signal: options?.abortSignal,
          });

          if (!response.ok) {
            reject(new Error(`Failed to subscribe to events: ${response.status}`));
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            reject(new Error("No response body for event stream"));
            return;
          }

          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]" || data === "") continue;

                try {
                  const event: RunEvent = JSON.parse(data);

                  // Fire the generic event callback
                  options?.onEvent?.(event);

                  // Handle specific event types
                  switch (event.event) {
                    case "message.delta": {
                      if (event.delta) {
                        textParts.push(event.delta);
                        options?.onTextDelta?.(event.delta);
                      }
                      break;
                    }
                    case "tool.started": {
                      const toolCall: RunToolCall = {
                        id: event.toolCallId || "",
                        name: event.tool || "unknown",
                        label: event.label || event.tool || "unknown",
                        emoji: event.emoji,
                        status: "running",
                      };
                      toolCalls.push(toolCall);
                      options?.onToolStart?.(
                        event.tool || "unknown",
                        event.label || event.tool || "unknown",
                        event.emoji,
                      );
                      break;
                    }
                    case "tool.completed": {
                      // Update the matching tool call
                      const tc = toolCalls.find((t) => t.id === event.toolCallId);
                      if (tc) {
                        tc.status = "completed";
                        tc.duration = event.duration;
                      }
                      options?.onToolComplete?.(
                        event.tool || "unknown",
                        event.duration,
                      );
                      break;
                    }
                    case "hermes.tool.progress": {
                      // Legacy tool progress format (from chat completions SSE)
                      if (event.status === "running") {
                        const toolCall: RunToolCall = {
                          id: event.toolCallId || "",
                          name: event.tool || "unknown",
                          label: event.label || event.tool || "unknown",
                          emoji: event.emoji,
                          status: "running",
                        };
                        toolCalls.push(toolCall);
                        options?.onToolStart?.(
                          event.tool || "unknown",
                          event.label || event.tool || "unknown",
                          event.emoji,
                        );
                      } else if (event.status === "completed") {
                        const tc = toolCalls.find(
                          (t) => t.id === event.toolCallId,
                        );
                        if (tc) {
                          tc.status = "completed";
                        }
                        options?.onToolComplete?.(event.tool || "unknown");
                      }
                      break;
                    }
                    case "run.completed": {
                      finalOutput = event.output || textParts.join("");
                      finalUsage = event.usage;
                      break;
                    }
                    case "run.failed": {
                      runError = (event.message || event.error || "Run failed") as string;
                      break;
                    }
                    case "run.cancelled": {
                      runError = "Run was cancelled";
                      break;
                    }
                    case "approval.request": {
                      // Human-in-the-loop approval needed
                      // For now, we just log it. Future: surface in UI.
                      console.log(
                        `[Symbio] Approval requested for tool: ${event.tool_name}`,
                      );
                      break;
                    }
                  }
                } catch (parseError) {
                  // Not JSON — could be a comment or keepalive
                  console.debug("[Symbio] SSE parse error:", parseError);
                }
              }
            }
          }

          // Stream ended — resolve with the result
          const fullText = finalOutput || textParts.join("");
          resolve({
            runId,
            text: fullText,
            toolCalls,
            usage: finalUsage,
            error: runError,
            sessionId: this.sessionId || undefined,
          });
        } catch (error) {
          if ((error as Error).name === "AbortError") {
            // User cancelled — try to stop the run
            this.stopRun(runId).catch(() => {});
            resolve({
              runId,
              text: textParts.join(""),
              toolCalls,
              error: "Cancelled by user",
              sessionId: this.sessionId || undefined,
            });
          } else {
            reject(error);
          }
        }
      };

      fetchEvents();
    });
  }

  /**
   * Stop a running agent.
   *
   * POST /v1/runs/{run_id}/stop
   */
  async stopRun(runId?: string): Promise<void> {
    const id = runId || this.currentRunId;
    if (!id) return;

    const baseUrl = this.getBaseUrl();
    try {
      await fetch(`${baseUrl}/v1/runs/${id}/stop`, {
        method: "POST",
        headers: this.getHeaders(),
      });
    } catch (error) {
      console.error("[Symbio] Failed to stop run:", error);
    }
  }

  /**
   * Get the current run status.
   *
   * GET /v1/runs/{run_id}
   */
  async getRunStatus(runId?: string): Promise<RunStatus | null> {
    const id = runId || this.currentRunId;
    if (!id) return null;

    const baseUrl = this.getBaseUrl();
    try {
      const response = await fetch(`${baseUrl}/v1/runs/${id}`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Resolve a pending approval for a run.
   *
   * POST /v1/runs/{run_id}/approval
   */
  async resolveApproval(
    runId: string,
    choice: "once" | "session" | "always" | "deny",
  ): Promise<void> {
    const baseUrl = this.getBaseUrl();
    await fetch(`${baseUrl}/v1/runs/${runId}/approval`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ choice }),
    });
  }

  /**
   * Get the current run ID (if a run is active)
   */
  get currentRunId(): string | null {
    return this._currentRunId;
  }

  /**
   * Get the current session ID (for conversation continuity)
   */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the session key for long-term memory scoping
   */
  setSessionKey(key: string): void {
    this.config.sessionKey = key;
  }

  /**
   * Clean up — stop any active event stream
   */
  dispose(): void {
    if (this.currentEventSource) {
      this.currentEventSource.close();
      this.currentEventSource = null;
    }
  }
}

// ── Result Types ────────────────────────────────────────────────────

export interface RunToolCall {
  id: string;
  name: string;
  label: string;
  emoji?: string;
  status: "running" | "completed" | "failed";
  duration?: number;
}

export interface RunsResult {
  runId: string;
  text: string;
  toolCalls: RunToolCall[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: string;
  sessionId?: string;
}

export interface RunStatus {
  object: string;
  run_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_approval";
  output?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: string;
  last_event?: string;
  created_at?: number;
  updated_at?: number;
  session_id?: string;
  model?: string;
}

// ── Singleton ───────────────────────────────────────────────────────

let runsTransportInstance: RunsTransport | null = null;

export function getRunsTransport(): RunsTransport {
  if (!runsTransportInstance) {
    runsTransportInstance = new RunsTransport();
  }
  return runsTransportInstance;
}

export function resetRunsTransport(): void {
  if (runsTransportInstance) {
    runsTransportInstance.dispose();
    runsTransportInstance = null;
  }
}