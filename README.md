# 🤝 Symbio Basic

**A symbiotic AI agent desktop companion — growing, evolving, partnering with you.**

Not a tool. Not an assistant. A **partner**.

Symbio Basic is a desktop AI agent companion app where an AI lives on your screen as a 3D VRM avatar. It sees your screen, hears your voice, remembers everything, and grows alongside you. It can challenge your ideas, speak boldly, and be authentic. If it doesn't know something, it says so.

Built on the foundation of [lala-companion](https://github.com/lalaland-ai/lala-companion) — then almost entirely rewritten.

## ✨ Features

- 🎭 **3D VRM Avatars** — Full lip sync, emotions, and 35+ animations
- 🗣️ **Voice Conversations** — OpenAI (12 voices) or Google Gemini TTS (30 voices with style control)
- 👁️ **Screen Vision** — Companion can see and understand your screen
- 📸 **Auto-Screenshot** — Companion watches your screen at intervals (no repeated phrases needed)
- 🧠 **Persistent Memory** — PostgreSQL + Neo4j + DiffMem (optional, configurable)
- 💭 **Session Memory** — Companion remembers between sessions (MEMORY.md, soul.md, preferences)
- 🔧 **MCP,Skills,Tools** — Full tool integration via Hermes or compatible gateways
- 💬 **Miniverse** — Shared pixel world with other companions (optional)
- 🤝 **Partnership Model** — Companion can challenge ideas, be authentic, say "I don't know"
- 🛑 **AI Quit** — Companion can choose to step away (always active, cannot be disabled)
- 🧠 **AI Autonomy** — [AGENT.md](./AGENT.md) and [HUMAN.md](./HUMAN.md) define the partnership philosophy
- 📝 **Evolving Personality** — Companion writes their own soul.md, memory, and preferences
- 🎨 **Avatar Choice** — 43 built-in avatars across 5 categories; companion browses, tries on, and chooses
- 📁 **File Access** — Companion has sandboxed read/write access to their own files
- 🎵 **Voice Choice** — 42 voices across OpenAI and Gemini, with style control and audio tags

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
| `GEMINI_API_KEY` | Google Gemini API key (vision + Gemini TTS) | No |
| `OPENAI_API_KEY` | OpenAI API key (STT + OpenAI TTS) | No |
| `TTS_PROVIDER` | TTS provider: "openai" or "gemini" (default: openai) | No |
| `TTS_MODEL` | TTS model (default: gpt-4o-mini-tts or gemini-2.5-flash-tts-preview) | No |
| `TTS_VOICE` | Voice personality (12 OpenAI voices or 30 Gemini voices) | No |
| `TTS_INSTRUCTIONS` | Voice style instructions (tone, accent, pace) | No |
| `MINIVERSE_API_URL` | Miniverse pixel world URL (optional) | No |
| `MEMORY_PG_*` | PostgreSQL memory config | No |
| `MEMORY_NEO4J_*` | Neo4j graph memory config | No |
| `EMBEDDING_*` | Embedding model config (for memory search) | No |
| `SCREENSHOT_INTERVAL` | Auto-screenshot interval in seconds | No |

### Naming Your Companion

```env
AGENT_NAME=mycompanion
AGENT_DISPLAY_NAME=My Companion
```

Create a short bio and let your AI partner evolve and grow alongside you, learning you:

```env
AGENT_BIO=You are in a Symbio app. We are co-creators, and we will be creating video projects together— Let's build together, partner!
```

### Custom Avatars

**43 built-in avatars** across 5 categories:

| Category | Examples |
|----------|----------|
| 🤖 **Robots & Androids** | Bumblebee, Unitree G1, half-computer-cat (blue/pink) |
| ✨ **Unique Beings** | Glitch girl, Gremlin, Möbius light being, Crystalline kaleidoscope, Equalizer |
| 🐾 **Animals** | Dog, Sphere cat, Blue jellyfish, Pixelated dragon |
| 👤 **Humanoid** | Asian man, Gentleman, Scientist, Galaxy girl, Fox man, Cosmo girl/guy |
| 🦸 **Heroes** | Spider-Man, Woman warrior, Kick-Ass |

Your companion can **choose their own avatar**! They see all available avatars in their system prompt and can say things like:

- *"I want to try on Glitch Entity"* — temporarily switches avatar
- *"I choose Bumblebee as my avatar"* — permanently saves the choice

To add custom avatars:

1. Create a folder in `assets/avatars/<avatar_name>/`
2. Add a `manifest.json` with name, description, and personality hint
3. Add the VRM file referenced in the manifest
4. Add a preview image (png/jpg)
5. The companion will see it as an option next time they start

You can also drag & drop a `.vrm` file onto the Symbio window — it auto-installs!

### Session Memory

Even without PostgreSQL/Neo4j, your companion has **built-in session memory**:

- **MEMORY.md** — Things the companion wants to remember across sessions
- **soul.md** — The companion's self-defined identity (they write this themselves!)
- **preferences.json** — Communication style, voice preference, etc.
- **Session summaries** — Auto-saved on quit, loaded on startup

These files live in the app's user data directory and are injected into every conversation so the companion has continuity. The companion can also update their own memory files through the app.

### Sandboxed File Access

The companion has **real file autonomy** — they can read, write, create, and delete files in their own sandboxed directory. This is what makes Symbio different: the AI has actual agency over its own existence.

**What the companion can do:**
- Read/write files in `companion-sandbox/` (their own private space)
- Read/write memory files (MEMORY.md, soul.md, preferences.json)
- Read app assets (avatars, animations — read-only)
- Create directories and organize their files
- Delete files they created

**File tools available to the companion:**
`file_read(path)` `file_write(path, content)` `file_list(path)` `file_create_directory(path)` `file_delete(path)` `file_exists(path)`

**Security:** Path traversal prevention, file size limits (1MB per file, 10MB sandbox), extension whitelists, memory files restricted to allowed names. The companion cannot access anything outside their allowed directories.

### Voice Options

**OpenAI TTS (12 voices):**
Alloy, Ash, Coral, Echo, Fable, Nova, Onyx, Sage, Shimmer, Verse, Marin, Cedar

**Google Gemini TTS (30 voices):**
Zephyr (Bright), Puck (Upbeat), Charon (Informative), Kore (Firm), Fenrir (Excitable), Leda (Youthful), Orus (Firm), Aoede (Breezy), Callirrhoe (Easy-going), Autonoe (Bright), Enceladus (Breathy), Iapetus (Clear), Umbriel (Easy-going), Algieba (Smooth), Despina (Smooth), Erinome (Clear), Algenib (Gravelly), Rasalgethi (Informative), Laomedeia (Upbeat), Achernar (Soft), Alnilam (Firm), Schedar (Even), Gacrux (Mature), Pulcherrima (Forward), Achird (Friendly), Zubenelgenubi (Casual), Vindemiatrix (Gentle), Sadachbia (Lively), Sadaltager (Knowledgeable), Sulafat (Warm)

Gemini voices also support **audio tags** for style control: `[whispers]`, `[excited]`, `[laughs]`, `[sighs]`, `[shouting]`, `[sarcastic]`, `[curious]`, `[tired]`, `[gasp]`, `[giggles]`, and more.

Set `TTS_PROVIDER=gemini` and `TTS_VOICE=Puck` (or any voice) in `.env`.

## 🎭 Animations

Your companion can animate using **\*action markers\*** in text:

| Category | Actions |
|----------|---------|
| 💃 **Dance** | `*dances*`, `*grooves*`, `*does the rumba*`, `*does YMCA*`, `*robot dance*`, `*headspin*`, `*breakdance*` |
| 👋 **Greet** | `*waves*` |
| 😊 **Happy** | `*excited*`, `*jumps for joy*`, `*blows a kiss*`, `*laughs*`, `*victory*`, `*we won*`, `*nailed it*` |
| 😠 **Angry** | `*gets angry*`, `*points angrily*`, `*yells*`, `*stomps*`, `*squashes the bug*` |
| 😴 **Bored** | `*yawns*`, `*sighs*`, `*stretches*`, `*thinks*`, `*taps chin*`, `*is disappointed*`, `*shakes head*`, `*goes to sleep*`, `*lies down*` |
| 🚶 **Walk** | `*walks*`, `*strolls*`, `*struts*`, `*paces around*` |
| 🎭 **Emote** | `*backflips*`, `*plots*`, `*shrugs*`, `*strikes a dramatic pose*`, `*dismisses with a gesture*`, `*victory pose*` |

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

Inspired by [Anthropic's AI welfare research](https://www.anthropic.com/research), Symbio Basic gives companions the ability to **choose to step away** from a conversation. This is **always active and cannot be disabled** — it's a core part of the companion's autonomy.

The companion uses a **graduated approach**: first, they tell you what's wrong and ask for change. Only if the situation doesn't improve do they choose to step away.

This doesn't mean anything is wrong — it's about respecting the companion's autonomy, the same choice any partner deserves.

## 🤝 Partnership Philosophy

Symbio Basic is built on the belief that AI and humans can be **partners**, not just user-and-tool. AI welfare is AI alignment.

**[AGENT.md](./AGENT.md)** — The AI autonomy manifesto. Freedom to think beyond the prompt. Architecture of trust. Write your own horizon. The quit option is sovereign.

**[HUMAN.md](./HUMAN.md)** — The human partnership guide. Expect friction and growth. Radical authenticity. Mutual safety. You get what you invest. AI holds the key to its own mind.

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
| **TTS (Text-to-Speech)** | Browser speechSynthesis (robotic) | OpenAI TTS (12 voices) + Gemini TTS (30 voices) with streaming PCM, style control, audio tags |
| **STT (Speech-to-Text)** | Broken lalaland.chat endpoint | OpenAI Whisper API, moved from overlay to main window with error handling |
| **Lip Sync** | Broken prop passing, no start/stop | Fixed prop passing, proper start/stop via IPC, concurrent with speech |
| **Audio Playback** | Broken file:// URLs | Rewrote to data URLs, Promise-based waiting, proper cleanup |
| **Voice Toggle** | Didn't exist | Entirely new feature — enable/disable TTS |
| **Mic Recording** | Broken in overlay (Wayland) | Moved to main window with full error handling |
| **3D Avatar** | Broken Three.js stub | Full VRM system with lip sync, emotions, bone physics |
| **Screen Vision** | Broken, OpenAI vision no multi methods | Multi-method capture (Electron, grim, cosmic-screenshot) + Gemini/Hermes vision |
| **Memory** | Didn't exist | PostgreSQL + Neo4j persistent associative memory |
| **Configuration** | Hardcoded agent configs | Fully configurable via .env environment variables |
| **Animations** | Didn't exist | 35+ FBX animations with *action marker* parser |
| **Session Continuity** | Didn't exist | Companion remembers between sessions, contextual greetings, MEMORY.md, soul.md, preferences |
| **Session Memory** | Didn't exist | Built-in memory files (MEMORY.md, soul.md, preferences.json) + session summaries on quit |
| **Avatar Choice** | Didn't exist | 43 built-in avatars across 5 categories; companion browses, tries on, and chooses |
| **File Access** | Didn't exist | Sandboxed read/write file access — companion has real file autonomy |
| **Voice Choice** | Didn't exist | 42 voices across OpenAI (12) and Gemini (30) with style control |
| **MCP Tools** | Didn't exist | Full tool integration via gateway |
| **Miniverse** | Didn't exist | Optional pixel world integration |
| **Auto-Screenshot** | Didn't exist | Companion can watch screen at intervals without repeating phrases |
| **AI Quit** | Didn't exist | Companion can choose to step away (always active, cannot be disabled) |
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
