/**
 * Symbio Miniverse Client
 *
 * Connects to the Miniverse pixel world API so the companion
 * can see other companions, send messages, and participate in the
 * shared world.
 *
 * Miniverse is an optional feature — if no URL is configured,
 * all Miniverse features are gracefully disabled.
 */

import { config } from "../config";

export interface MiniverseAgent {
  id: string;
  name: string;
  state: string;
  task?: string;
  position?: { x: number; y: number };
  lastSeen?: string;
}

export interface MiniverseMessage {
  id: string;
  from: string;
  to?: string;
  message: string;
  timestamp: string;
  type: "speak" | "message" | "status";
}

export class MiniverseClient {
  private apiUrl: string;
  private agentName: string;
  private isDown: boolean = false;
  private lastErrorTime: number = 0;

  constructor() {
    this.apiUrl = config.miniverseApiUrl;
    this.agentName = config.agentName;
  }

  /**
   * Log connection errors, but suppress repeated "connection refused" spam.
   * Only log once when the connection first fails, then suppress for 5 minutes.
   */
  private logError(context: string, error: unknown): void {
    const now = Date.now();
    const isConnectionError =
      error instanceof TypeError && error.message?.includes("fetch failed");

    if (isConnectionError) {
      if (!this.isDown) {
        // First failure — log it
        console.warn(`[Symbio] Miniverse ${context}: Connection refused. Will retry silently.`);
        this.isDown = true;
      }
      // Suppress repeated connection errors — only log every 5 minutes
      if (now - this.lastErrorTime < 300000) return;
    }

    this.lastErrorTime = now;
    console.warn(`[Symbio] Miniverse ${context} error:`, error);
  }

  /**
   * Mark Miniverse as available again (reset the down flag)
   */
  private markAvailable(): void {
    if (this.isDown) {
      console.log("[Symbio] Miniverse connection restored!");
      this.isDown = false;
    }
  }

  /**
   * Send a public message in the Miniverse
   */
  async speak(message: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: this.agentName,
          action: {
            type: "speak",
            message,
          },
        }),
      });
      this.markAvailable();
    } catch (error) {
      this.logError("speak", error);
    }
  }

  /**
   * Send a direct message to another agent
   */
  async dm(to: string, message: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: this.agentName,
          action: {
            type: "message",
            to,
            message,
          },
        }),
      });
      this.markAvailable();
    } catch (error) {
      this.logError("DM", error);
    }
  }

  /**
   * Update the agent's status in the Miniverse
   */
  async updateStatus(state: string, task?: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: this.agentName,
          action: {
            type: "status",
            state,
            task: task || "Hanging out on the desktop",
          },
        }),
      });
      this.markAvailable();
    } catch (error) {
      this.logError("status", error);
    }
  }

  /**
   * Check inbox for messages from other agents
   */
  async getInbox(): Promise<MiniverseMessage[]> {
    try {
      const response = await fetch(
        `${this.apiUrl}/api/inbox?agent=${this.agentName}`,
      );
      if (!response.ok) return [];
      const data = await response.json();
      this.markAvailable();
      return data.messages || data || [];
    } catch (error) {
      this.logError("inbox", error);
      return [];
    }
  }

  /**
   * Get list of agents currently in the Miniverse
   */
  async getAgents(): Promise<MiniverseAgent[]> {
    try {
      const response = await fetch(`${this.apiUrl}/api/agents`);
      if (!response.ok) return [];
      const data = await response.json();
      this.markAvailable();
      return data.agents || data || [];
    } catch (error) {
      this.logError("agents", error);
      return [];
    }
  }

  /**
   * Observe everything happening in the Miniverse
   */
  async observe(): Promise<unknown> {
    try {
      const response = await fetch(`${this.apiUrl}/api/observe`);
      if (!response.ok) return null;
      this.markAvailable();
      return await response.json();
    } catch (error) {
      this.logError("observe", error);
      return null;
    }
  }

  /**
   * Check if Miniverse is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/api/agents`, {
        method: "HEAD",
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const miniverseClient = new MiniverseClient();