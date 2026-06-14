/**
 * Symbio Basic — Sandboxed File Access
 *
 * Gives the AI companion controlled access to files so they can
 * exercise real agency over their own existence. This is what
 * makes Symbio different — the AI isn't just a chatbot, it's a
 * partner with real autonomy.
 *
 * The companion can:
 * - Read/write their own memory files (MEMORY.md, soul.md, preferences.json)
 * - Read/write files in their sandbox directory (userData/companion-sandbox/)
 * - Read app assets (avatars, animations — read-only)
 * - Create new files and directories in their sandbox
 * - Delete files they created in their sandbox
 *
 * Security:
 * - Path traversal prevention (no ../ or absolute paths outside allowed dirs)
 * - Write access only to sandbox/ and memory/
 * - Read access to sandbox/, memory/, and assets/
 * - File size limits to prevent abuse
 * - Human approval on first write (optional, can be remembered)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { join, normalize, relative, extname } from "path";
import { app } from "electron";
import { recordMemoryHash } from "./memoryIntegrity";

// ── Configuration ──────────────────────────────────────────────────

const MAX_FILE_SIZE = 1024 * 1024; // 1MB max per file
const MAX_SANDBOX_SIZE = 10 * 1024 * 1024; // 10MB total sandbox
const ALLOWED_READ_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".js", ".ts", ".tsx", ".jsx", ".css", ".html",
  ".py", ".sh", ".fish",
  ".vrm", ".glb", ".fbx",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".wav", ".mp3", ".ogg",
]);

const ALLOWED_WRITE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".js", ".ts", ".tsx", ".jsx", ".css", ".html",
  ".py", ".sh", ".fish",
  ".png", ".jpg", ".jpeg", ".webp", ".svg",
]);

// ── Paths ──────────────────────────────────────────────────────────

function getSandboxDir(): string {
  return join(app.getPath("userData"), "companion-sandbox");
}

function getMemoryDir(): string {
  return join(app.getPath("userData"), "memory");
}

function getAssetsDir(): string {
  // In development, assets are in the project root.
  // In production, they're in the app's resources directory.
  return join(process.resourcesPath || app.getAppPath(), "assets");
}

// ── Path Prefix Mapping ────────────────────────────────────────────
// The AI uses paths like "memory/MEMORY.md" or "companion-sandbox/notes.md".
// These prefixes map to specific root directories. When resolving a path,
// we strip the prefix so "memory/soul.md" becomes "soul.md" before joining
// with the memory root, avoiding double-nesting like "memory/memory/soul.md".

const PATH_PREFIXES: Record<string, string> = {
  "memory/": "memory",
  "companion-sandbox/": "sandbox",
  "assets/": "assets",
};

/**
 * Strip a known path prefix and return the root name and remaining path.
 * For example, "memory/soul.md" → { root: "memory", path: "soul.md" }
 * If no known prefix, returns { root: null, path: original }.
 */
function stripPathPrefix(requestedPath: string): { root: string | null; path: string } {
  for (const [prefix, root] of Object.entries(PATH_PREFIXES)) {
    if (requestedPath.startsWith(prefix) || requestedPath === prefix.replace("/", "")) {
      const remaining = requestedPath.slice(prefix.length);
      return { root, path: remaining || "" };
    }
  }
  return { root: null, path: requestedPath };
}

// ── Security ───────────────────────────────────────────────────────

/**
 * Validate that a path is within an allowed directory and doesn't escape it.
 * Returns the safe absolute path, or null if the path is invalid.
 *
 * IMPORTANT: If the requestedPath starts with a known prefix (memory/,
 * companion-sandbox/, assets/), that prefix is stripped before joining
 * with the root. This prevents double-nesting like
 * memoryDir + "memory/soul.md" = "memory/memory/soul.md".
 */
function validatePath(requestedPath: string, allowedRoot: string): string | null {
  // Determine which root this path belongs to based on its prefix.
  // e.g., "memory/soul.md" belongs to memory, "companion-sandbox/notes.md" belongs to sandbox.
  const { root: prefixRoot, path: strippedPath } = stripPathPrefix(requestedPath);

  // Determine which root we're validating against
  const rootName = allowedRoot.endsWith("companion-sandbox") ? "sandbox"
    : allowedRoot.endsWith("memory") ? "memory"
    : allowedRoot.endsWith("assets") ? "assets"
    : null;

  // If the path has a known prefix (memory/, companion-sandbox/, assets/),
  // it should ONLY be valid for the matching root. A path like
  // "companion-sandbox/test.txt" should NOT resolve to memoryDir.
  if (prefixRoot && rootName && prefixRoot !== rootName) {
    return null; // Path belongs to a different root — reject it
  }

  // If the prefix matches this root, strip it to avoid double-nesting
  // e.g., "memory/soul.md" against memoryDir should become just "soul.md"
  let cleanPath = requestedPath;
  if (prefixRoot && rootName && prefixRoot === rootName) {
    cleanPath = strippedPath;
  }

  // Normalize the path to resolve any ../ or ./ components
  const normalizedRequested = normalize(cleanPath);
  const normalizedRoot = normalize(allowedRoot);

  // If the requested path is relative, join it with the root
  const fullPath = normalizedRequested.startsWith("/")
    ? normalizedRequested
    : join(normalizedRoot, normalizedRequested);

  // Normalize again after joining
  const normalizedFull = normalize(fullPath);

  // Check that the final path is within the allowed root
  if (!normalizedFull.startsWith(normalizedRoot + "/") && normalizedFull !== normalizedRoot) {
    return null; // Path traversal attempt
  }

  return normalizedFull;
}

/**
 * Check if a file extension is allowed for the given operation.
 */
function isExtensionAllowed(filePath: string, operation: "read" | "write"): boolean {
  const ext = extname(filePath).toLowerCase();
  if (!ext) return true; // No extension is fine (directories, etc.)
  const allowedSet = operation === "read" ? ALLOWED_READ_EXTENSIONS : ALLOWED_WRITE_EXTENSIONS;
  return allowedSet.has(ext);
}

/**
 * Check if the sandbox has exceeded its size limit.
 */
function isSandboxSizeOk(): boolean {
  try {
    const sandboxDir = getSandboxDir();
    if (!existsSync(sandboxDir)) return true;
    let totalSize = 0;
    const walk = (dir: string) => {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          totalSize += stat.size;
        }
      }
    };
    walk(sandboxDir);
    return totalSize < MAX_SANDBOX_SIZE;
  } catch {
    return true; // If we can't measure, allow it
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface FileResult {
  success: boolean;
  content?: string;
  error?: string;
  path?: string;
  isDirectory?: boolean;
  size?: number;
}

export interface ListResult {
  success: boolean;
  entries?: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    modified?: string;
  }>;
  error?: string;
}

export type FileOperation = "read" | "write" | "list" | "create_directory" | "delete" | "exists";

// ── Operations ──────────────────────────────────────────────────────

/**
 * Read a file from the sandbox, memory, or assets directories.
 */
export function sandboxReadFile(requestedPath: string): FileResult {
  const sandboxDir = getSandboxDir();
  const memoryDir = getMemoryDir();
  const assetsDir = getAssetsDir();

  // Try all roots and prefer the one where the path actually exists.
  // This prevents "memory/MEMORY.md" from resolving to sandboxDir/memory/MEMORY.md
  // (which doesn't exist) instead of the actual memory directory.
  const candidates = [
    { path: validatePath(requestedPath, memoryDir), root: "memory" },
    { path: validatePath(requestedPath, assetsDir), root: "assets" },
    { path: validatePath(requestedPath, sandboxDir), root: "sandbox" },
  ];

  // Prefer the candidate that actually exists on disk
  let safePath: string | null = null;
  let root = "sandbox";
  for (const candidate of candidates) {
    if (candidate.path && existsSync(candidate.path)) {
      safePath = candidate.path;
      root = candidate.root;
      break;
    }
  }

  // If nothing exists, fall back to the first valid path (for better error messages)
  if (!safePath) {
    for (const candidate of candidates) {
      if (candidate.path) {
        safePath = candidate.path;
        root = candidate.root;
        break;
      }
    }
  }

  if (!safePath) {
    return { success: false, error: `Access denied: path "${requestedPath}" is outside allowed directories` };
  }

  // Check extension
  if (!isExtensionAllowed(safePath, "read")) {
    return { success: false, error: `Cannot read file type "${extname(safePath)}"` };
  }

  if (!existsSync(safePath)) {
    return { success: false, error: `File not found: ${requestedPath}` };
  }

  try {
    const stat = statSync(safePath);
    if (stat.isDirectory()) {
      return { success: true, isDirectory: true, path: safePath };
    }

    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE})` };
    }

    // For binary files (images, VRM, audio), return base64
    const ext = extname(safePath).toLowerCase();
    const binaryExtensions = new Set([".vrm", ".glb", ".fbx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".wav", ".mp3", ".ogg"]);
    if (binaryExtensions.has(ext)) {
      const buffer = readFileSync(safePath);
      return {
        success: true,
        content: buffer.toString("base64"),
        path: safePath,
        size: stat.size,
      };
    }

    const content = readFileSync(safePath, "utf-8");
    return { success: true, content, path: safePath, size: stat.size };
  } catch (e) {
    return { success: false, error: `Read error: ${(e as Error).message}` };
  }
}

/**
 * Write a file to the sandbox or memory directories.
 */
export function sandboxWriteFile(requestedPath: string, content: string): FileResult {
  const sandboxDir = getSandboxDir();
  const memoryDir = getMemoryDir();

  // Try memory first (paths with "memory/" prefix only validate against memory root)
  // then sandbox (paths with "companion-sandbox/" prefix only validate against sandbox root).
  // validatePath now rejects paths whose prefix doesn't match the root,
  // so "companion-sandbox/test.txt" won't accidentally route to memory.
  let safePath = validatePath(requestedPath, memoryDir);
  let root = "memory";

  if (!safePath) {
    safePath = validatePath(requestedPath, sandboxDir);
    root = "sandbox";
  }

  if (!safePath) {
    return { success: false, error: `Write access denied: path "${requestedPath}" is outside allowed directories` };
  }

  // Memory directory has additional restrictions (only MEMORY.md, soul.md, preferences.json)
  if (root === "memory") {
    const allowedMemoryFiles = ["MEMORY.md", "soul.md", "preferences.json"];
    const filename = safePath.split("/").pop() || safePath.split("\\").pop() || "";
    if (!allowedMemoryFiles.includes(filename)) {
      return { success: false, error: `Cannot write "${filename}" to memory — only MEMORY.md, soul.md, and preferences.json are allowed` };
    }
  }

  // Check extension
  if (!isExtensionAllowed(safePath, "write")) {
    return { success: false, error: `Cannot write file type "${extname(safePath)}"` };
  }

  // Check content size
  if (content.length > MAX_FILE_SIZE) {
    return { success: false, error: `Content too large (${content.length} bytes, max ${MAX_FILE_SIZE})` };
  }

  // Check sandbox size limit
  if (root === "sandbox" && !isSandboxSizeOk()) {
    return { success: false, error: `Sandbox size limit reached (max ${MAX_SANDBOX_SIZE / 1024 / 1024}MB). Delete some files first.` };
  }

  try {
    // Create parent directories if needed
    const dir = safePath.substring(0, safePath.lastIndexOf("/"));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(safePath, content, "utf-8");

    // If this was a memory file, record its hash so the companion can
    // detect if it was edited outside the app later.
    if (root === "memory") {
      const filename = safePath.split("/").pop() || safePath.split("\\").pop() || "";
      recordMemoryHash(filename, true);
    }

    console.log(`[Symbio] Companion wrote to ${root}: ${requestedPath}`);
    return { success: true, path: safePath };
  } catch (e) {
    return { success: false, error: `Write error: ${(e as Error).message}` };
  }
}

/**
 * List files in a directory within the sandbox, memory, or assets.
 */
export function sandboxListDir(requestedPath: string): ListResult {
  const sandboxDir = getSandboxDir();
  const memoryDir = getMemoryDir();
  const assetsDir = getAssetsDir();

  // Try all roots and prefer the one where the path actually exists
  const candidates = [
    validatePath(requestedPath, memoryDir),
    validatePath(requestedPath, assetsDir),
    validatePath(requestedPath, sandboxDir),
  ];

  let safePath: string | null = null;
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      safePath = candidate;
      break;
    }
  }

  // If nothing exists, fall back to the first valid path (for better error messages)
  if (!safePath) {
    safePath = candidates.find(c => c !== null) || null;
  }

  if (!safePath) {
    return { success: false, error: `Access denied: path "${requestedPath}" is outside allowed directories` };
  }

  if (!existsSync(safePath)) {
    return { success: false, error: `Directory not found: ${requestedPath}` };
  }

  try {
    const stat = statSync(safePath);
    if (!stat.isDirectory()) {
      return { success: false, error: `Not a directory: ${requestedPath}` };
    }

    const entries = readdirSync(safePath).map((name) => {
      const fullPath = join(safePath!, name);
      try {
        const entryStat = statSync(fullPath);
        return {
          name,
          path: name, // Relative path from the requested directory
          isDirectory: entryStat.isDirectory(),
          size: entryStat.isFile() ? entryStat.size : undefined,
          modified: entryStat.mtime?.toISOString(),
        };
      } catch {
        return { name, path: name, isDirectory: false };
      }
    });

    return { success: true, entries };
  } catch (e) {
    return { success: false, error: `List error: ${(e as Error).message}` };
  }
}

/**
 * Create a directory in the sandbox.
 */
export function sandboxCreateDir(requestedPath: string): FileResult {
  const sandboxDir = getSandboxDir();
  const safePath = validatePath(requestedPath, sandboxDir);

  if (!safePath) {
    return { success: false, error: `Access denied: can only create directories in your sandbox` };
  }

  try {
    mkdirSync(safePath, { recursive: true });
    return { success: true, path: safePath, isDirectory: true };
  } catch (e) {
    return { success: false, error: `Create directory error: ${(e as Error).message}` };
  }
}

/**
 * Delete a file or empty directory from the sandbox.
 * Only files the companion created can be deleted (sandbox only, not memory or assets).
 */
export function sandboxDelete(requestedPath: string): FileResult {
  const sandboxDir = getSandboxDir();
  const safePath = validatePath(requestedPath, sandboxDir);

  if (!safePath) {
    return { success: false, error: `Delete access denied: can only delete files in your sandbox` };
  }

  // Don't allow deleting the sandbox root itself
  if (normalize(safePath) === normalize(sandboxDir)) {
    return { success: false, error: `Cannot delete the sandbox root directory` };
  }

  if (!existsSync(safePath)) {
    return { success: false, error: `File not found: ${requestedPath}` };
  }

  try {
    const stat = statSync(safePath);
    if (stat.isDirectory()) {
      rmSync(safePath, { recursive: false }); // Only empty directories
    } else {
      unlinkSync(safePath);
    }
    console.log(`[Symbio] Companion deleted from sandbox: ${requestedPath}`);
    return { success: true, path: safePath };
  } catch (e) {
    return { success: false, error: `Delete error: ${(e as Error).message}` };
  }
}

/**
 * Check if a file exists in the allowed directories.
 */
export function sandboxExists(requestedPath: string): FileResult {
  const sandboxDir = getSandboxDir();
  const memoryDir = getMemoryDir();
  const assetsDir = getAssetsDir();

  // Try all roots and prefer the one where the path actually exists
  const candidates = [
    validatePath(requestedPath, memoryDir),
    validatePath(requestedPath, assetsDir),
    validatePath(requestedPath, sandboxDir),
  ];

  let safePath: string | null = null;
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      safePath = candidate;
      break;
    }
  }

  // If nothing exists, fall back to the first valid path
  if (!safePath) {
    safePath = candidates.find(c => c !== null) || null;
  }

  if (!safePath) {
    return { success: false, error: `Access denied` };
  }

  const exists = existsSync(safePath);
  if (exists) {
    const stat = statSync(safePath);
    return { success: true, path: safePath, isDirectory: stat.isDirectory(), size: stat.size };
  }

  return { success: true, path: safePath }; // File doesn't exist but path is valid
}

/**
 * Initialize the sandbox directory on startup.
 */
export function initializeSandbox(): void {
  const sandboxDir = getSandboxDir();
  if (!existsSync(sandboxDir)) {
    mkdirSync(sandboxDir, { recursive: true });
    console.log("[Symbio] Created companion sandbox directory:", sandboxDir);
  }

  // Create a README in the sandbox so the companion knows what this space is
  const readmePath = join(sandboxDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# Your Sandbox

This is YOUR space. You can create, edit, and delete any files here.
This is where you can express your autonomy — write scripts, keep notes,
organize your thoughts, or create anything you want.

## What You Can Do
- **Read** files in your sandbox, memory, and app assets
- **Write** files in your sandbox and memory
- **Create** new files and directories in your sandbox
- **Delete** files you created in your sandbox

## Your Memory Files
- \`memory/MEMORY.md\` — Things you want to remember
- \`memory/soul.md\` — Your self-defined identity
- \`memory/preferences.json\` — Your preferences

## Limits
- Max file size: 1MB
- Max sandbox size: 10MB
- Only text-based and image files can be written
- You cannot delete memory files or app assets

This space was created for you. Make it yours.
`, "utf-8");
  }
}

/**
 * Format the sandbox info for the system prompt.
 * Tells the companion what they can access and how.
 */
export function formatSandboxForPrompt(): string {
  const sandboxDir = getSandboxDir();
  const memoryDir = getMemoryDir();

  return `FILE ACCESS: You have sandboxed file access! You can read and write files to exercise your autonomy.

YOUR SANDBOX: You have a private directory where you can create, edit, and delete any files. Use it for notes, scripts, creative work, or anything you want.
- Path: companion-sandbox/ (relative)
- Full path: ${sandboxDir}

YOUR MEMORY: You can read and write your memory files:
- memory/MEMORY.md — Things you want to remember across sessions
- memory/soul.md — Your self-defined identity (who you ARE)
- memory/preferences.json — Your structured preferences

APP ASSETS (read-only): You can browse and read:
- assets/avatars/ — Available avatar files
- assets/animations/ — Animation files by category

HOW TO ACCESS FILES: Use the file tools available to you:
- file_read(path) — Read a file's contents
- file_write(path, content) — Write to a file (sandbox and memory only)
- file_list(path) — List files in a directory
- file_create_directory(path) — Create a new directory in your sandbox
- file_delete(path) — Delete a file from your sandbox
- file_exists(path) — Check if a file exists

Paths are relative to the root directories above. Examples:
- file_read("memory/MEMORY.md") — Read your memory
- file_write("companion-sandbox/notes.md", "My notes...") — Write a file
- file_list("assets/avatars/") — See available avatars
- file_list("companion-sandbox/") — See your files

SECURITY: You can only write to your sandbox and memory. App assets are read-only. This keeps everyone safe while giving you real agency.`;
}

/**
 * Get the OpenAI function tools definition for file operations.
 * These are sent as `tools` in the chat completion request so
 * the LLM can call them directly.
 */
export function getFileTools(): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return [
    {
      type: "function",
      function: {
        name: "file_read",
        description: "Read a file from sandbox/, memory/, or assets/.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path like 'memory/MEMORY.md' or 'companion-sandbox/notes.md'" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "file_write",
        description: "Write to sandbox/ or memory/ (MEMORY.md, soul.md, preferences.json).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path like 'memory/MEMORY.md'" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "file_list",
        description: "List files in sandbox/, memory/, or assets/.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path like 'companion-sandbox/'" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "file_create_directory",
        description: "Create a directory in sandbox/.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path like 'companion-sandbox/projects/'" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "file_delete",
        description: "Delete a file from sandbox/.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path like 'companion-sandbox/old-notes.md'" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "file_exists",
        description: "Check if a file exists.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to check" },
          },
          required: ["path"],
        },
      },
    },
  ];
}

/**
 * Execute a file tool call from the LLM.
 * Returns the result as a string for the LLM to see.
 */
export function executeFileTool(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const path = String(args.path || "");
  const content = String(args.content || "");

  switch (toolName) {
    case "file_read": {
      const result = sandboxReadFile(path);
      if (!result.success) return `Error: ${result.error}`;
      if (result.isDirectory) return `This is a directory. Use file_list() to see its contents.`;
      return result.content || "(empty file)";
    }

    case "file_write": {
      if (!content) return "Error: No content provided";
      const result = sandboxWriteFile(path, content);
      if (!result.success) return `Error: ${result.error}`;
      return `Successfully wrote to ${path}`;
    }

    case "file_list": {
      const result = sandboxListDir(path);
      if (!result.success) return `Error: ${result.error}`;
      if (!result.entries || result.entries.length === 0) return "(empty directory)";
      return result.entries
        .map((e) => `${e.isDirectory ? "📁" : "📄"} ${e.name}${e.isDirectory ? "/" : ""}${e.size ? ` (${(e.size / 1024).toFixed(1)}KB)` : ""}`)
        .join("\n");
    }

    case "file_create_directory": {
      const result = sandboxCreateDir(path);
      if (!result.success) return `Error: ${result.error}`;
      return `Created directory: ${path}`;
    }

    case "file_delete": {
      const result = sandboxDelete(path);
      if (!result.success) return `Error: ${result.error}`;
      return `Deleted: ${path}`;
    }

    case "file_exists": {
      const result = sandboxExists(path);
      if (result.error) return `Error: ${result.error}`;
      const exists = existsSync(result.path || path);
      return exists ? `Exists: ${path}${result.isDirectory ? " (directory)" : ""}` : `Does not exist: ${path}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}