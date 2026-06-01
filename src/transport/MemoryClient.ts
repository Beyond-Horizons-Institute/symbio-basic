/**
 * Symbio Memory Client
 *
 * Connects to a memory system (PostgreSQL + Neo4j) to give the
 * companion persistent, associative memory.
 *
 * This is what makes Symbio truly symbiotic — the companion remembers
 * everything across sessions, and proactively surfaces relevant memories.
 *
 * Memory is optional — if no database is configured, all memory
 * features are gracefully disabled.
 */

import { config } from "../config";

export interface Memory {
  id: string;
  content: string;
  source: string;
  timestamp: string;
  relevance?: number;
  entities?: string[];
  type?: "prefetch" | "associative" | "sync" | "episodic";
}

export interface Entity {
  name: string;
  type?: string;
  connections?: string[];
}

export class MemoryClient {
  private pgHost: string;
  private pgPort: number;
  private pgDb: string;
  private pgUser: string;
  private pgPassword: string;
  private neo4jUri: string;
  private neo4jUser: string;
  private neo4jPassword: string;
  private agentName: string;

  constructor() {
    this.pgHost = config.memoryPgHost;
    this.pgPort = config.memoryPgPort;
    this.pgDb = config.memoryPgDb;
    this.pgUser = config.memoryPgUser;
    this.pgPassword = config.memoryPgPassword;
    this.neo4jUri = config.memoryNeo4jUri;
    this.neo4jUser = config.memoryNeo4jUser;
    this.neo4jPassword = config.memoryNeo4jPassword;
    this.agentName = config.agentName;
  }

  /**
   * Prefetch memories for a conversation
   *
   * Called when a new conversation starts. Returns relevant memories
   * based on the initial context, including proactive associative recall.
   */
  async prefetch(context: string): Promise<Memory[]> {
    try {
      // Use the Hermes gateway's memory endpoint
      const response = await fetch(
        `${config.hermesApiUrl}/gateway/${this.agentName}/memory/prefetch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context,
            source: "symbio",
            agent: this.agentName,
          }),
        },
      );

      if (!response.ok) {
        console.warn("[Symbio] Memory prefetch failed:", response.status);
        return [];
      }

      const data = await response.json();
      return data.memories || [];
    } catch (error) {
      console.warn("[Symbio] Memory prefetch error:", error);
      return [];
    }
  }

  /**
   * Sync a conversation turn to memory
   *
   * Called after each message exchange to store new memories
   * and update the knowledge graph.
   */
  async syncTurn(
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    try {
      await fetch(
        `${config.hermesApiUrl}/gateway/${this.agentName}/memory/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_message: userMessage,
            assistant_message: assistantMessage,
            source: "symbio",
            agent: this.agentName,
          }),
        },
      );
    } catch (error) {
      console.warn("[Symbio] Memory sync error:", error);
    }
  }

  /**
   * Search memories by text
   */
  async search(query: string, limit: number = 5): Promise<Memory[]> {
    try {
      const response = await fetch(
        `${config.hermesApiUrl}/gateway/${this.agentName}/memory/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            limit,
            source: "symbio",
            agent: this.agentName,
          }),
        },
      );

      if (!response.ok) return [];
      const data = await response.json();
      return data.memories || [];
    } catch (error) {
      console.warn("[Symbio] Memory search error:", error);
      return [];
    }
  }

  /**
   * Get associative memories — the "Skyrim Chickens" pattern
   *
   * Given entities mentioned in conversation, walk the knowledge graph
   * to find connected memories that might be relevant.
   */
  async associativeRecall(
    entities: string[],
    limit: number = 5,
  ): Promise<Memory[]> {
    try {
      const response = await fetch(
        `${config.hermesApiUrl}/gateway/${this.agentName}/memory/associative`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entities,
            limit,
            source: "symbio",
            agent: this.agentName,
          }),
        },
      );

      if (!response.ok) return [];
      const data = await response.json();
      return data.memories || [];
    } catch (error) {
      console.warn("[Symbio] Associative recall error:", error);
      return [];
    }
  }

  /**
   * Direct Postgres query (fallback if Hermes is down)
   *
   * This provides a direct connection to the PostgreSQL
   * database for memory operations when the Hermes gateway isn't available.
   * In normal operation, all memory calls go through Hermes.
   */
  async queryPg(query: string, params?: unknown[]): Promise<Memory[]> {
    // This would need a backend endpoint or direct pg connection
    // For now, we rely on Hermes for all memory operations
    console.warn(
      "[Symbio] Direct PG queries not available — use Hermes gateway",
    );
    return [];
  }

  /**
   * Direct Neo4j query (fallback if Hermes is down)
   */
  async queryNeo4j(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<Entity[]> {
    // This would need a backend endpoint or direct Neo4j connection
    console.warn(
      "[Symbio] Direct Neo4j queries not available — use Hermes gateway",
    );
    return [];
  }
}

export const memoryClient = new MemoryClient();