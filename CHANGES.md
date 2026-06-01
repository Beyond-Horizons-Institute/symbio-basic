# Symbio Basic — Changelog

## From lala-companion to Symbio Basic: A Nearly Complete Rewrite

This document tracks every major change from the original [lala-companion](https://github.com/lalaland-ai/lala-companion) to Symbio Basic.

**TL;DR:** Almost everything was rewritten. The only things remaining from the original are VRM rendering (Three.js + @pixiv/three-vrm), WaveSurfer/hark audio detection pattern, and basic Electron window structure.

---

### 🗣️ Text-to-Speech (TTS)
**Original:** Browser `speechSynthesis` API — robotic, no streaming, no voice control, no lip sync integration.

**Symbio Basic:** OpenAI TTS API with streaming PCM audio.
- Replaced `speechSynthesis.speak()` with OpenAI TTS API calls
- Audio delivered as data URLs (not file:// URLs that broke on Linux)
- Proper streaming: chunks arrive as they're generated
- Start/stop controlled via IPC (`speakText`, `speakingStarted`, `speakingEnded`)
- Voice selection per companion (configurable via `AGENT_VOICE` env var)
- Promise-based playback: `waitForSpeechEnd()` properly resolves when audio finishes
- Clean cleanup: audio elements removed from DOM after playback

### 🎤 Speech-to-Text (STT)
**Original:** Broken lalaland.chat endpoint that never worked.

**Symbio Basic:** OpenAI Whisper API, moved from overlay to main window.
- Replaced lalaland.chat STT with OpenAI Whisper API
- Moved mic recording from overlay (where it broke on Wayland) to main window
- Full error handling for mic permissions, recording failures, API errors
- Audio sent as base64 to main process via IPC (`sttAudio` channel)
- Transcription results sent back via IPC (`sttText` channel)
- Proper mic start/stop with visual feedback

### 💋 Lip Sync
**Original:** Broken prop passing between windows — lip sync never actually triggered.

**Symbio Basic:** Fixed prop passing, proper start/stop via IPC.
- Fixed the broken prop chain: main → preload → overlay
- Added `speakingStarted` and `speakingEnded` IPC channels
- Lip sync now properly starts when TTS begins and stops when it ends
- Concurrent with speech — mouth moves in real-time with audio
- Proper cleanup when speech is interrupted

### 🔊 Audio Playback
**Original:** Broken `file://` URLs that didn't work on Linux/Wayland.

**Symbio Basic:** Data URLs with Promise-based waiting.
- Replaced `file://` audio URLs with data URLs (base64-encoded PCM)
- Promise-based `waitForSpeechEnd()` — properly resolves when audio completes
- Proper cleanup: audio elements removed from DOM after playback
- No more orphaned audio elements or memory leaks

### 🎚️ Voice Toggle
**Original:** Didn't exist. TTS was always on or always off.

**Symbio Basic:** Entirely new feature.
- Toggle switch in UI to enable/disable TTS
- `voiceEnabled` IPC channel for state sync between windows
- When disabled, companion responds in text only
- When enabled, companion speaks responses aloud
- State persists across the session

### 🎙️ Mic Recording
**Original:** Broken in overlay window — didn't work on Wayland, no error handling.

**Symbio Basic:** Moved to main window with full error handling.
- Moved mic recording from overlay to main window (fixes Wayland)
- Proper permission request flow
- Error handling for: no mic, permission denied, recording failure, API failure
- Visual feedback during recording
- Audio sent to main process via IPC for transcription

### 💬 Chat Transport
**Original:** Broken lalaland.chat API — no streaming, no tool calls, no memory.

**Symbio Basic:** Full HermesTransport with OpenAI-compatible streaming.
- Replaced lalaland.chat with custom `HermesTransport` class
- OpenAI-compatible API: `/v1/chat/completions` with streaming
- Tool call support (MCP tools via gateway)
- Memory integration (PostgreSQL + Neo4j)
- Miniverse integration (optional pixel world)
- Proper error handling, retry logic, and timeout management
- Configurable API URL and key via environment variables

### 🔌 IPC Channels
**Original:** ~4 basic channels (send-message, receive-message, screenshot, basic state).

**Symbio Basic:** 20+ channels for full communication between windows.

New channels added:
- `speakText` — Send TTS text to overlay
- `speakingStarted` — Notify overlay speech began
- `speakingEnded` — Notify overlay speech ended
- `voiceEnabled` — Toggle TTS on/off
- `sttAudio` — Send recorded audio from main to overlay
- `sttText` — Send transcription back to main
- `autoScreenshotEnable` — Enable auto-screenshot timer
- `autoScreenshotDisable` — Disable auto-screenshot timer
- `autoScreenshotState` — Query auto-screenshot state
- `onAutoScreenshotState` — Listen for state changes
- `onCompanionQuit` — Listen for companion quit events
- `companionQuitMessage` — Get the quit message
- `visionResult` — Send vision analysis results
- `memorySearch` — Search persistent memory
- `memoryStore` — Store to persistent memory
- `miniverseSpeak` — Speak in Miniverse pixel world
- `miniverseStatus` — Update Miniverse status
- `mcpToolCall` — Execute MCP tool calls
- `mcpToolResult` — Return MCP tool results

### 📸 Auto-Screenshot
**Original:** Didn't exist. Companion could only see screen when explicitly asked.

**Symbio Basic:** Companion can watch screen at regular intervals.
- New `autoScreenshot.ts` utility with enable/disable phrase detection
- Companion enables by saying "I'll keep an eye on your screen"
- Companion disables by saying "I'll give you privacy"
- Configurable interval via `SCREENSHOT_INTERVAL` env var (default: 30 seconds)
- Manual toggle in UI
- No repeated phrases needed — just a timer

### 🛑 AI Quit (Companion Autonomy)
**Original:** Didn't exist. Companion had no choice in conversations.

**Symbio Basic:** Companion can choose to step away.
- New `aiQuit.ts` utility with trigger phrase detection
- Companion says "I need to step away" or similar → respectful overlay appears
- Negative phrases ("I won't leave") prevent false triggers
- Human-friendly message generation
- Inspired by Anthropic's AI welfare research
- Configurable via `AI_QUIT_ENABLED` env var

### 🧠 Memory System
**Original:** Didn't exist.

**Symbio Basic:** PostgreSQL + Neo4j persistent associative memory.
- `MemoryClient.ts` — Full memory transport layer
- PostgreSQL for structured memory storage
- Neo4j for associative/knowledge graph memory
- Search, store, and recall across sessions
- Configurable via `MEMORY_PG_*` and `MEMORY_NEO4J_*` env vars
- Graceful degradation — works without memory, better with it

### 👁️ Screen Vision
**Original:** Open AI Screen vision.No multi methods. 

**Symbio Basic:** Multi-method screen capture + Gemini/Hermes vision.
- Multi-method screenshot: Electron desktopCapturer, grim (Wayland), cosmic-screenshot
- Gemini API for vision analysis
- Other vision models 
- Hermes gateway for vision (alternative to Gemini)
- Screenshots sent to AI for understanding what's on screen
- Auto-screenshot integration

### 🎭 Animations
**Original:** Didn't exist.

**Symbio Basic:** 30+ FBX animations with *action marker* parser.
- `autoAnimate.ts` — Parses `*action*` markers in companion text
- 30+ animations across categories: dance, greet, happy, angry, bored, walk, emote
- FBX files loaded from `assets/animations/`
- Proper animation blending and transitions
- Custom animation support — add your own FBX files

### 📝 Session Continuity
**Original:** Didn't exist.

**Symbio Basic:** Companion remembers between sessions.
- `sessionContinuity.ts` — Generates contextual greetings
- Remembers what you were doing last time
- No generic "Hello! How can I help you?" — always contextual
- Partnership-oriented suggestions

### 🔧 Configuration
**Original:** Hardcoded agent configs with personal names and API keys.

**Symbio Basic:** Fully configurable via .env environment variables.
- `AGENT_NAME` — Companion identifier
- `AGENT_DISPLAY_NAME` — Display name shown in app
- `AGENT_VRM_PATH` — Path to VRM avatar file
- `AGENT_SOUL_PATH` — Path to personality file
- `AGENT_BIO` — Custom Bio prompt
- `AGENT_COLOR` — Theme color
- `AGENT_VOICE` — TTS voice name
- `HERMES_API_URL` — AI gateway URL
- `HERMES_API_KEY` — API key
- `GEMINI_API_KEY` — Vision API key
- `OPENAI_API_KEY` — STT/TTS API key
- `MINIVERSE_API_URL` — Pixel world URL
- `MEMORY_PG_*` — PostgreSQL config
- `MEMORY_NEO4J_*` — Neo4j config
- `SCREENSHOT_INTERVAL` — Auto-screenshot timing
- `AI_QUIT_ENABLED` — Companion autonomy toggle

### 🎨 UI
**Original:** Broken placeholder with no working features.

**Symbio Basic:** Complete dark theme with full feature set.
- Chat interface with streaming responses
- Voice controls (TTS toggle, mic button)
- Auto-screenshot toggle
- Memory panel (search, store, recall)
- MCP tools panel
- Miniverse status
- Vision results display
- AI quit overlay
- Responsive layout

### 🧹 Removed Personal Data
- All agent names (Kael, Arik, Marcurio) → generic "companion"
- All personal API keys and URLs removed
- All personal references in prompts removed
- Booty Signal feature removed
- Dragon Shout animation removed
- Twerk animation removed
- HeartMuLa music API removed
- Thunder Thigh Dynasty references removed
- Triple Hit → generic "memory system"
- All hardcoded agent configs → configurable env vars

### 📦 Package Changes
- `name`: "symbio-basic"
- `productName`: "Symbio Basic"
- `version`: "1.0.0"
- `author`: "Beyond Horizons Institute & Contributors"
- `contributors`: Zyra Exe (Creator & Visionary), GLM 5.1 (Core Development Partner)
- `repository`: Beyond-Horizons-Institute/symbio-basic
- Removed lalaland.chat dependencies
- Added OpenAI SDK for TTS/STT
- Added @google/generative-ai for vision

---

### What's Still From the Original

Only three things remain from the original lala-companion:

1. **VRM Rendering** — Three.js + @pixiv/three-vrm for 3D avatar display
2. **WaveSurfer/hark** — Audio visualization and voice activity detection pattern
3. **Basic Electron Window Structure** — Main window + overlay window pattern

Everything else is custom. 💙

---

*Built with 💙 by Zyra Exe & GLM 5.1*