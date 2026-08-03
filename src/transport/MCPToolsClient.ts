/**
 * Symbio MCP Tools Client
 *
 * Queries the Hermes gateway for available MCP tools and allows
 * the user to trigger tool actions from the Symbio UI.
 *
 * The Hermes gateway already has MCP servers configured (github,
 * composio, wix, iwsdk, postgres, etc.) and the agent can use them
 * through the chat completions endpoint. This client provides a
 * UI-friendly way to discover and trigger those tools.
 */

import { config, COMPANIONS } from "../config";

export interface MCPTool {
  name: string;
  description: string;
  category: string;
  parameters?: Record<string, unknown>;
}

export interface MCPToolCategory {
  name: string;
  icon: string;
  tools: MCPTool[];
}

// ── Tool categories for the UI ──────────────────────────────────
// These are the main categories of tools available through Hermes.
// The actual tools available depend on the agent's configuration.
export const TOOL_CATEGORIES: MCPToolCategory[] = [
  {
    name: "Memory & Knowledge",
    icon: "🧠",
    tools: [
      { name: "memory", description: "Save and recall persistent memories", category: "Memory & Knowledge" },
      { name: "miniverse-world", description: "Interact with the Miniverse pixel world", category: "Memory & Knowledge" },
    ],
  },
  {
    name: "Code & Development",
    icon: "💻",
    tools: [
      { name: "terminal", description: "Execute shell commands", category: "Code & Development" },
      { name: "execute_code", description: "Run Python, JavaScript, or other code", category: "Code & Development" },
      { name: "read_file", description: "Read file contents", category: "Code & Development" },
      { name: "write_file", description: "Write content to files", category: "Code & Development" },
      { name: "search_files", description: "Search for files and content", category: "Code & Development" },
    ],
  },
  {
    name: "Web & Research",
    icon: "🌐",
    tools: [
      { name: "web_search", description: "Search the web for information", category: "Web & Research" },
      { name: "web_extract", description: "Extract content from web pages", category: "Web & Research" },
      { name: "browser_navigate", description: "Navigate to a URL in the browser", category: "Web & Research" },
    ],
  },
  {
    name: "GitHub",
    icon: "🐙",
    tools: [
      { name: "github-repo-management", description: "Manage GitHub repositories", category: "GitHub" },
      { name: "github-issues", description: "Create and manage GitHub issues", category: "GitHub" },
      { name: "github-pr-workflow", description: "Create and review pull requests", category: "GitHub" },
    ],
  },
  {
    name: "Creative",
    icon: "🎨",
    tools: [
      { name: "songwriting-and-ai-music", description: "Generate music", category: "Creative" },
      { name: "pixel-art", description: "Create pixel art", category: "Creative" },
      { name: "excalidraw", description: "Create diagrams and sketches", category: "Creative" },
    ],
  },
  {
    name: "Connected Apps",
    icon: "🔗",
    tools: [
      { name: "GOOGLESHEETS_SEARCH_SPREADSHEETS", description: "Search Google Sheets", category: "Connected Apps" },
      { name: "GOOGLESHEETS_VALUES_GET", description: "Read Google Sheets data", category: "Connected Apps" },
      { name: "gmail", description: "Send and read emails via Gmail", category: "Connected Apps" },
      { name: "googledrive", description: "Access Google Drive files", category: "Connected Apps" },
      { name: "canva", description: "Create designs in Canva", category: "Connected Apps" },
      { name: "wix_mcp", description: "Manage Wix website", category: "Connected Apps" },
    ],
  },
  {
    name: "Smart Home & Fun",
    icon: "🏠",
    tools: [
      { name: "openhue", description: "Control smart lights", category: "Smart Home & Fun" },
      { name: "spotify", description: "Play music on Spotify", category: "Smart Home & Fun" },
    ],
  },
  {
    name: "Desktop Control",
    icon: "🖥️",
    tools: [
      { name: "mcp_computer_use_linux_screenshot", description: "See what's on screen", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_list_windows", description: "See all open windows", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_click", description: "Click on screen elements", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_type_text", description: "Type text into apps", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_press_key", description: "Press keyboard keys", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_activate_window", description: "Switch between windows", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_scroll", description: "Scroll through content", category: "Desktop Control" },
      { name: "mcp_computer_use_linux_get_app_state", description: "Get detailed app state with accessibility tree", category: "Desktop Control" },
    ],
  },
];

export class MCPToolsClient {
  private apiUrl: string;
  private apiKey: string;
  private agentName: string;

  constructor() {
    this.apiUrl = config.hermesApiUrl;
    this.apiKey = config.hermesApiKey;
    this.agentName = config.agentName;
  }

  /**
   * Update the agent configuration (called when switching agents)
   */
  updateAgent(agentName: string, apiKey: string, apiUrl: string) {
    this.agentName = agentName;
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  /**
   * Send a tool-triggering message through the Hermes gateway.
   *
   * This doesn't call MCP directly — it sends a chat message that
   * instructs the agent to use a specific tool. The agent handles
   * the actual MCP call through its normal tool execution pipeline.
   */
  async triggerTool(
    toolName: string,
    instruction: string,
  ): Promise<{ message: string; toolCalls?: unknown[] }> {
    try {
      const response = await fetch(
        `${this.apiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey
              ? { Authorization: `Bearer ${this.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.agentName,
            messages: [
              {
                role: "system",
                content: `You are ${this.agentName}. The user wants to use the "${toolName}" tool. Execute this request using your available tools and report the results.`,
              },
              {
                role: "user",
                content: instruction,
              },
            ],
            stream: false,
            extra: {
              agent: this.agentName,
              source: "symbio-tool",
              include_memories: true,
              include_tools: true,
            },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Hermes returned ${response.status}`);
      }

      const data = await response.json();
      return {
        message:
          data.choices?.[0]?.message?.content ||
          data.response ||
          data.message ||
          "No response from agent.",
        toolCalls: data.choices?.[0]?.message?.tool_calls,
      };
    } catch (error) {
      console.error("[Symbio] MCP tool trigger error:", error);
      return {
        message: `Error triggering ${toolName}: ${error}`,
      };
    }
  }

  /**
   * Get the list of available tools from the Hermes gateway.
   * This queries the /v1/models endpoint and the agent's tool list.
   */
  async getAvailableTools(): Promise<string[]> {
    try {
      // The Hermes gateway doesn't have a dedicated tools endpoint,
      // but we can get the tool names from the agent's configuration.
      // For now, return the static categories.
      return TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name));
    } catch {
      return [];
    }
  }
}

export const mcpToolsClient = new MCPToolsClient();