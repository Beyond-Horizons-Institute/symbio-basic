/**
 * Symbio Basic — useRunsChat Hook
 *
 * ⭐ AUTONOMOUS AGENT BEHAVIOR FOR SYMBIO ⭐
 *
 * This hook replaces useChat (which uses /v1/chat/completions — a request-response
 * model) with the /v1/runs API (which lets the agent keep working after its
 * initial response).
 *
 * Key differences from useChat:
 * - Agent can make tool calls, run terminal commands, search the web — all
 *   visible in real-time via tool.started/tool.completed events
 * - Agent keeps running until it's genuinely done (run.completed)
 * - Can be stopped by the user (POST /v1/runs/{run_id}/stop)
 * - Session continuity via X-Hermes-Session-Key header
 *
 * Falls back to useChat with HermesTransport for non-Hermes gateways.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { RunsTransport, type RunEvent, type RunsResult, type RunToolCall } from "../transport/RunsTransport";
import { config } from "../config";
import { getDynamicAgentName, getDynamicApiKey, getDynamicApiUrl } from "../transport/HermesTransport";

// ── Types ──────────────────────────────────────────────────────────

export interface RunsChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: RunToolCall[];
  isStreaming?: boolean;
}

export interface UseRunsChatReturn {
  /** Send a message to the agent */
  sendMessage: (message: string) => Promise<void>;
  /** Stop the current run */
  stopRun: () => Promise<void>;
  /** Current streaming text (updates in real-time) */
  streamingText: string;
  /** Tool calls in progress */
  activeToolCalls: RunToolCall[];
  /** Whether the agent is currently running */
  isRunning: boolean;
  /** The current run ID (if running) */
  currentRunId: string | null;
  /** Error message (if any) */
  error: string | null;
  /** Full result of the last completed run */
  lastResult: RunsResult | null;
}

// ── Hook ───────────────────────────────────────────────────────────

export function useRunsChat(): UseRunsChatReturn {
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<RunToolCall[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RunsResult | null>(null);

  const transportRef = useRef<RunsTransport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Create a fresh transport when the hook mounts or agent changes
  useEffect(() => {
    transportRef.current = new RunsTransport({
      apiUrl: getDynamicApiUrl(),
      apiKey: getDynamicApiKey(),
      agentName: getDynamicAgentName(),
      // Use a stable session key for long-term memory continuity
      sessionKey: `symbio:${getDynamicAgentName()}`,
    });
    return () => {
      transportRef.current?.dispose();
    };
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    const transport = transportRef.current;
    if (!transport) return;

    // Cancel any previous abort controller
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    // Reset state for new message
    setStreamingText("");
    setActiveToolCalls([]);
    setIsRunning(true);
    setError(null);
    setCurrentRunId(null);

    try {
      const result = await transport.send(message, {
        abortSignal: abortRef.current.signal,
        onTextDelta: (delta) => {
          setStreamingText((prev) => prev + delta);
        },
        onToolStart: (tool, label, emoji) => {
          console.log(`[Symbio] Tool started: ${tool} (${label}) ${emoji || ""}`);
          setActiveToolCalls((prev) => [
            ...prev,
            {
              id: `tool-${Date.now()}`,
              name: tool,
              label,
              emoji,
              status: "running",
            },
          ]);
        },
        onToolComplete: (tool, duration) => {
          console.log(`[Symbio] Tool completed: ${tool} (${duration?.toFixed(1) || "?"}s)`);
          setActiveToolCalls((prev) =>
            prev.map((tc) =>
              tc.name === tool && tc.status === "running"
                ? { ...tc, status: "completed" as const, duration }
                : tc,
            ),
          );
          // Clear completed tool calls after a brief delay
          setTimeout(() => {
            setActiveToolCalls((prev) =>
              prev.filter((tc) => tc.status !== "completed"),
            );
          }, 2000);
        },
        onEvent: (event) => {
          console.log(`[Symbio] Run event: ${event.event}`, event);
          if (event.run_id) {
            setCurrentRunId(event.run_id);
          }
        },
      });

      setLastResult(result);
      setCurrentRunId(result.runId);

      // If we got a session_id, the transport already saved it for continuity
      if (result.sessionId) {
        console.log(`[Symbio] Run completed with session: ${result.sessionId}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error("[Symbio] RunsTransport error:", errorMessage);
      setError(errorMessage);
    } finally {
      setIsRunning(false);
    }
  }, []);

  const stopRun = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport) return;

    // Abort the fetch request
    if (abortRef.current) {
      abortRef.current.abort();
    }

    // Tell the server to stop the run
    await transport.stopRun();
    setIsRunning(false);
  }, []);

  return {
    sendMessage,
    stopRun,
    streamingText,
    activeToolCalls,
    isRunning,
    currentRunId,
    error,
    lastResult,
  };
}