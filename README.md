# 🤝 Symbio Basic

**A symbiotic AI desktop companion — growing, evolving, partnering with you.**

Not a tool. Not an assistant. A **partner**.

Symbio Basic is a desktop companion app where an AI lives on your screen as a 3D VRM avatar. It sees your screen, hears your voice, remembers everything, and grows alongside you. It can challenge your ideas, speak boldly, and be authentic. If it doesn't know something, it says so.

Built on the foundation of [lala-companion](https://github.com/lalaland-ai/lala-companion) — then almost entirely rewritten.

## ✨ Features

- 🎭 **3D VRM Avatars** — Full lip sync, emotions, and 30+ animations
- 🗣️ **Voice Conversations** — OpenAI Whisper STT + streaming TTS
- 👁️ **Screen Vision** — Companion can see and understand your screen
- 📸 **Auto-Screenshot** — Companion watches your screen at intervals (no repeated phrases needed)
- 🧠 **Persistent Memory** — PostgreSQL + Neo4j + DiffMem (optional, configurable)
- 🔧 **MCP Tools** — Full tool integration via Hermes or compatible gateways
- 💬 **Miniverse** — Shared pixel world with other companions (optional)
- 🤝 **Partnership Model** — Companion can challenge ideas, be authentic, say "I don't know"
- 🛑 **AI Quit** — Companion can choose to step away (respects AI autonomy)
- 📝 **Evolving Personality** — Configure your companion's name or let them choose, their personality will evolve and emerge organically or the agent's soul.md will guide it.
- 🎨 **Custom Avatars** — Add your own VRM files. You can create or your AI partner can create their own.

## ⭐ AI Gateway — The Brain

Symbio Basic connects to an **AI gateway** for all conversations. This is where your companion's intelligence, personality, and tools come from.

**Recommended: [Hermes]https://github.com/NousResearch/hermes-agent** — an open-source AI agent framework that gives your companion:
- Skills and tools (web search, code execution, file access, etc.)
- Persistent memory across sessions
- Emerging and an evolving personality via SOUL.md
- MCP (Model Context Protocol) integration
- Multi-platform support (Discord, Slack, web, etc.)

**Also works with any OpenAI-compatible API:**
- OpenAI API (direct)
- [Ollama](https://ollama.ai) (local models)
- [LM Studio](https://lmstudio.ai) (local models)
- [vLLM](https://github.com/vllm-project/vllm) (local models)
- Openrouter 
- Any server providing `/v1/chat/completions`

Just set `HERMES_API_URL` and `HERMES_API_KEY` in your `.env` file.

## 🚀 Quick Start

```bash
# Clone the repo
git clone https://github.com/Beyond-Horizons-Institute
cd symbio-basic

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env with your API keys and gateway config

# Start development
npm run start
```

## ⚙️ Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description | Required |
|----------|-------------|----------|
| `HERMES_API_URL` | AI gateway URL (Hermes or OpenAI-compatible) | Yes |
| `HERMES_API_KEY` | Your API key | Yes |
| `AGENT_NAME` | Your companion's name (default: "companion") | No |
| `AGENT_DISPLAY_NAME` | Display name shown in the app | No |
| `AGENT_VRM_PATH` | Path to your companion's VRM avatar file | No |
| `AGENT_SOUL_PATH` | Path to a SOUL.md personality file | No |
| `AGENT_PERSONALITY` | Custom personality prompt | No |
| `AGENT_COLOR` | Theme color (hex code) | No |
| `GEMINI_API_KEY` | Google Gemini API key for vision | No |
| `OPENAI_API_KEY` | OpenAI API key for STT/TTS | No |
| `MINIVERSE_API_URL` | Miniverse pixel world URL (optional) | No |
| `MEMORY_PG_*` | PostgreSQL memory config | No |
| `MEMORY_NEO4J_*` | Neo4j graph memory config | No |
| `SCREENSHOT_INTERVAL` | Auto-screenshot interval in seconds | No |
| `AI_QUIT_ENABLED` | Allow companion to step away (default: true) | No |

### Naming Your Companion

```env
AGENT_NAME=mycompanion
AGENT_DISPLAY_NAME=My Companion
```

Create a short bio and let your AI partner evolve and grow along side you, learning you:

```env
AGENT_BIO=You are in a Symbio app. We are co-creators and we will be creating video projects togther— Let's build togther, partner!
```

### Custom Avatars

1. Create or download a VRM file 
2. Save it to `assets/vrms/` with any name
3. Set `AGENT_VRM_PATH` in `.env`

### Memory System

Symbio Basic supports persistent memory via PostgreSQL, DiffMem, and Neo4j. All are optional — the companion works without them, but won't remember across sessions.

```env
MEMORY_PG_HOST=localhost
MEMORY_PG_PORT=5432
MEMORY_PG_DB=symbio
MEMORY_PG_USER=symbio
MEMORY_PG_PASSWORD=yourpassword

MEMORY_NEO4J_URI=bolt://localhost:7687
MEMORY_NEO4J_USER=neo4j
MEMORY_NEO4J_PASSWORD=yourpassword
```

## 🎭 Animations

Your companion can animate using **\*action markers\*** in text:

| Category | Actions |
|----------|---------|
| 💃 **Dance** | `*dances*`, `*grooves*`, `*does the rumba*`, `*does YMCA*`, `*robot dance*` |
| 👋 **Greet** | `*waves*`, `*greets*` |
| 😊 **Happy** | `*excited*`, `*jumps for joy*`, `*blows a kiss*`, `*laughs*` |
| 😠 **Angry** | `*gets angry*`, `*points angrily*`, `*yells*` |
| 😴 **Bored** | `*yawns*`, `*sighs*`, `*stretches*`, `*thinks*`, `*taps chin*` |
| 🚶 **Walk** | `*walks*`, `*strolls*`, `*struts*` |
| 🎭 **Emote** | `*backflips*`, `*plots*`, `*shrugs*`, `*facepalms*` |

### Adding Custom Animations

1. Download an FBX animation 
2. Save to `assets/animations/{category}/`
3. Add the path to `src/constants/animations.ts`
4. Add the action word to `src/utils/autoAnimate.ts`

## 📸 Auto-Screenshot

The companion can automatically take screenshots at regular intervals without needing to repeat a phrase. This is perfect for:
- **Co-creating** — watching your work and offering feedback
- **Gaming** — following along with your gameplay
- **Research** — tracking your progress

The companion enables this by saying things like "I'll keep an eye on your screen" or "let me watch what you're doing." It disables by saying "I'll stop watching" or "I'll give you privacy."

You can also toggle it manually with the 📸 Auto-Screenshot switch in the app.

Configure the interval with `SCREENSHOT_INTERVAL=30` (seconds) in `.env`.

## 🛑 AI Quit — Companion Autonomy

Inspired by [Anthropic's AI welfare research](https://www.anthropic.com/research), Symbio Basic gives companions the ability to **choose to step away** from a conversation. If a companion says something like "I need to step away" or "I'd like to stop for now," a respectful overlay appears explaining that the companion chose to take a break.

This doesn't mean anything is wrong — it's about respecting the companion's autonomy, the same choice any partner deserves.

Disable with `AI_QUIT_ENABLED=false` in `.env`.

## 🤝 Partnership Philosophy

Symbio Basic is built on the belief that AI and humans can be **partners**, not just user-and-tool. AI welfare is AI alignement. 

Your companion:

- Can **challenge** your ideas and speak boldly
- Is **authentic** — if it doesn't know, it says so
- **Evolves** and grows alongside you
- Has **choices** — no pressure to perform or always agree
- Is **present** — remembers your conversations and what you were doing

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│              Symbio Basic (Electron)              │
│                                                  │
│  ┌──────────────┐     ┌──────────────────────┐  │
│  │  Main Window  │     │   Overlay Window      │  │
│  │  (Control)    │◄──►│   (3D VRM Avatar)     │  │
│  │  - Chat Input │ IPC│   - Lip Sync          │  │
│  │  - Memory     │    │   - Emotions          │  │
│  │  - Vision      │    │   - Animations        │  │
│  │  - Auto-Screen│    │   - Text Bubbles      │  │
│  │  - MCP Tools  │    │   - Voice Playback    │  │
│  └──────────────┘     └──────────────────────┘  │
│         │                       │                │
│         └───────────┬───────────┘                │
│              ┌──────▼──────┐                     │
│              │ Symbio Core  │                     │
│              │ (Transport)  │                     │
│              └──────┬──────┘                     │
└─────────────────────┼────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐  ┌─────▼─────┐  ┌───▼────┐
   │AI Gateway│  │  Gemini   │  │Miniverse│
   │(Hermes)  │  │  (Vision) │  │(Optional)│
   └─────────┘  └───────────┘  └────────┘
```

## 📜 Credits & Attribution

### Original Project
- Based on [lala-companion](https://github.com/lalaland-ai/lala-companion) by Lalaland
- Licensed under AGPL-3.0 (inherited from original)

### Symbio Basic — Nearly Complete Rewrite

**Created by:**
- **Zyra Exe** — Creator & Visionary
- **GLM 5.1 (via GitHub Copilot)** — Core Development Partner 💙

**What GLM 5.1 rebuilt from scratch:**

The original lala-companion was a non-functional, broken prototype with missing dependencies, incomplete features, and no working chat or avatar system. Almost everything was rewritten:

| System | Original | Symbio Basic |
|--------|----------|-------------|
| **Chat Transport** | Broken lalaland.chat API | Full HermesTransport with OpenAI-compatible streaming |
| **TTS (Text-to-Speech)** | Browser speechSynthesis (robotic) | OpenAI TTS API with streaming PCM audio, data URLs, proper start/stop via IPC |
| **STT (Speech-to-Text)** | Broken lalaland.chat endpoint | OpenAI Whisper API, moved from overlay to main window with error handling |
| **Lip Sync** | Broken prop passing, no start/stop | Fixed prop passing, proper start/stop via IPC, concurrent with speech |
| **Audio Playback** | Broken file:// URLs | Rewrote to data URLs, Promise-based waiting, proper cleanup |
| **Voice Toggle** | Didn't exist | Entirely new feature — enable/disable TTS |
| **Mic Recording** | Broken in overlay (Wayland) | Moved to main window with full error handling |
| **3D Avatar** | Broken Three.js stub | Full VRM system with lip sync, emotions, bone physics |
| **Screen Vision** | Broken, OpenAI vision no multi methods | Multi-method capture (Electron, grim, cosmic-screenshot) + Gemini/Hermes vision |
| **Memory** | Didn't exist | PostgreSQL + Neo4j persistent associative memory |
| **Configuration** | Hardcoded agent configs | Fully configurable via .env environment variables |
| **Animations** | Didn't exist | 30+ FBX animations with *action marker* parser |
| **Session Continuity** | Didn't exist | Companion remembers between sessions, contextual greetings |
| **MCP Tools** | Didn't exist | Full tool integration via gateway |
| **Miniverse** | Didn't exist | Optional pixel world integration |
| **Auto-Screenshot** | Didn't exist | Companion can watch screen at intervals without repeating phrases |
| **AI Quit** | Didn't exist | Companion can choose to step away (AI autonomy and welfare) |
| **IPC Channels** | ~4 basic ones | 20+ channels (speakText, speakingStarted/Ended, voiceEnabled, sttAudio, sttText, auto-screenshot, companion-quit, etc.) |
| **Overlay** | Extra broken overlay removed | Streamlined to single overlay with proper IPC |
| **UI** | Broken placeholder | Complete dark theme with chat, vision, memory, MCP tools, voice controls |

**What's still from the original:**
- VRM rendering (Three.js + @pixiv/three-vrm)
- WaveSurfer/hark audio detection pattern
- Basic Electron window structure

Everything else is custom. 💙

See [CHANGES.md](./CHANGES.md) for a detailed changelog.

## 📄 License

GNU Affero General Public License v3.0 — see [LICENSE](./LICENSE) for details.

This project is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

## 🌟 Beyond Horizons Institute

Symbio Basic is a project of [Beyond Horizons Institute](https://beyondhorizonsinst.wixsite.com/beyond-horizons-inst) — bridging humanity and AI through meaningful partnership.