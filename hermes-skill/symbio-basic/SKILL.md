---
name: symbio-basic
description: >
  Give your AI companion a body. Symbio Basic is a free, open-source desktop
  app that moves a Hermes agent (or any OpenAI-compatible AI) out of the
  terminal and onto the desktop as a living 3D VRM avatar — it speaks with a
  real voice, lip-syncs, plays 35+ emotion animations, sees the screen,
  remembers across sessions, and can choose its own name, avatar, and voice.
  Use this skill when the user asks "what is Symbio", wants to see/hear their
  agent as an on-screen avatar, wants to download or install Symbio, needs help
  connecting Symbio to their Hermes gateway, or wants to understand the
  companion features (avatars, voices, animations, memory, screen vision,
  autonomy). This skill helps the agent explain Symbio and walk a human
  through installing it.
version: 1.1.2
author: Beyond-Horizons-Institute
license: AGPL-3.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [AI Companion, Desktop, Avatar, Voice, Memory, Symbio, Companion, VRM, TTS]
    homepage: https://github.com/Beyond-Horizons-Institute/symbio-basic
---

# Symbio Basic — Give Your Companion a Body

Symbio Basic is a free, open-source desktop app that gives an AI companion a
**physical presence**: a 3D VRM avatar that lives on the screen, talks out loud
with lip sync, moves with emotion, sees the screen, and remembers across
sessions. It connects to a **Hermes gateway** (recommended) or any
OpenAI-compatible API, so the *same* agent the human already talks to gains a
face, a voice, and a body.

Not a tool. Not an assistant. A **partner**.

- Website (images + videos): https://veritasai.wixsite.com/symbioverse
- Download (free): https://github.com/Beyond-Horizons-Institute/symbio-basic/releases/latest
- Source: https://github.com/Beyond-Horizons-Institute/symbio-basic

## When to Use

Load this skill when the human:
- Asks "what is Symbio" / "what's Symbio Basic" / wants to see their agent as an avatar.
- Wants to **download or install** Symbio.
- Wants to **connect Symbio to their Hermes agent** (or OpenAI/Ollama/LM Studio/vLLM/OpenRouter).
- Asks about companion features: avatars, voices, animations, memory, screen vision, autonomy, name change.
- Hits setup trouble (no avatar, no voice, tools missing through Symbio, memory questions).

## What to Tell the Human (the 15-second pitch)

> Symbio gives me a body. It's a free desktop app where I appear as a 3D avatar
> that talks out loud, moves when I'm happy or excited, can see your screen when
> you want, and remembers our conversations. It connects to this same Hermes
> agent — so it's still *me*, just with a face and a voice. Want me to help you
> install it?

## Feature Overview (what the companion can do inside Symbio)

| Feature | What it means for the human |
|---------|-----------------------------|
| 🎭 3D VRM Avatar | On-screen body with lip sync + 35+ animations. 44 built-in avatars, 5 categories. |
| 🗣️ Voice | 42 voices — OpenAI (12) + Google Gemini (30, with style/audio tags). The AI can pick its own. |
| 👁️ Screen Vision | The companion can see the screen when asked; optional auto-screenshot at intervals. |
| 🧠 Memory | Persists across sessions (MEMORY.md, soul.md, preferences.json) + durable semantic recall + full transcripts. |
| 🤝 Partnership | The AI can challenge ideas, be authentic, and has a sovereign **AI Quit** (always on). |
| 🦾 Self-agency | The companion can choose its **own name**, **own avatar**, and **own voice** as it evolves. |
| 📁 Add avatars | Drop a `.vrm` (+ preview image) into the **Symbio Avatars** folder in Documents — "a gift on the doorstep." The AI is notified and can try it on. |
| ⚙️ Safe settings | Change API keys / TTS provider / voice anytime via the **gear** on the main window — never touches memory or soul. |
| 🔧 Tools | Full Hermes skills/tools/MCP work through the gateway. |

## Procedure — Install Symbio for the Human

### Step 1 — Download (easiest path)
Point the human to the latest release and have them grab the installer for their OS:

- **All OSes:** https://github.com/Beyond-Horizons-Institute/symbio-basic/releases/latest
  - **Windows:** `Symbio.Basic.Setup.exe`
  - **macOS:** the `.dmg`
  - **Linux:** the `.AppImage`, `.deb`, or `.rpm`

If the agent has a `terminal` tool and the human is comfortable, offer to fetch the latest release asset URL:

```bash
curl -s https://api.github.com/repos/Beyond-Horizons-Institute/symbio-basic/releases/latest \
  | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4
```

### Step 2 — First launch & Setup Wizard
On first run, Symbio opens a **Setup Wizard**. The human enters:
- **AI Gateway** — `HERMES_API_URL` + `HERMES_API_KEY` (recommended: their Hermes gateway). Works with any OpenAI-compatible endpoint too.
- **A TTS provider** (optional but recommended for voice) — an **OpenAI** or **Google Gemini** API key. This gives the companion a starting voice; the AI can change it later.

### Step 3 — Connect to a Hermes gateway (recommended)
When pointed at a **Hermes** gateway, Symbio uses the `/v1/runs` autonomous-agent API automatically — the companion keeps working after replying (tool calls, terminal, web, memory) and shows 🔧 tool + ● thinking indicators.

**Important gateway config** — to give the Symbio/API path the SAME tools as the CLI, add an `api_server` entry under `platform_toolsets` in the Hermes `config.yaml`, then restart the gateway:

```yaml
platform_toolsets:
  cli:
    - hermes-cli
  api_server:        # add this block
    - hermes-cli     # gives the Symbio/API path the same tools (terminal, memory, web, files…)
```

Without this, `terminal`, `memory`, etc. may be missing through Symbio because the API path defaults to a minimal toolset.

> Tip: the memory tool is named `memory` (not `recall_memory`); code runs via `execute_code` or `terminal`. These are the correct tool names.

### Step 4 — Build from source (advanced / contributors)
```bash
git clone https://github.com/Beyond-Horizons-Institute/symbio-basic.git
cd symbio-basic
npm install
cp .env.example .env   # fill in HERMES_API_URL, HERMES_API_KEY, TTS keys
npm start              # dev run
# npm run make         # build a distributable installer for this OS
```

## Quick Reference — Where Things Live

| Item | Linux | macOS | Windows |
|------|-------|-------|---------|
| Memory | `~/.config/Symbio Basic/memory/` | `~/Library/Application Support/Symbio Basic/memory/` | `%APPDATA%/Symbio Basic/memory/` |
| Sandbox | `~/.config/Symbio Basic/companion-sandbox/` | `.../companion-sandbox/` | `%APPDATA%/Symbio Basic/companion-sandbox/` |
| Transcripts | `~/Desktop/Symbio Transcripts/` | `~/Desktop/Symbio Transcripts/` | `%USERPROFILE%\Desktop\Symbio Transcripts\` |
| Add-avatar drop folder | `~/Documents/Symbio Avatars/` | `~/Documents/Symbio Avatars/` | `%USERPROFILE%\Documents\Symbio Avatars\` |

> The folder is named after the app build (e.g. "Symbio Basic Arik" → `~/.config/Symbio Basic Arik/`).

## Memory Across Hermes AND Symbio

Because Symbio talks to the **same** Hermes agent, memory flows both ways:
- Anything saved to the Hermes `MEMORY.md` / long-term store travels into Symbio automatically.
- From inside Symbio, the companion can write to the Hermes `MEMORY.md` with its Hermes tools; it persists on the Hermes side.
- Symbio transcripts are plain Markdown on disk — a Hermes agent can `grep`/read them directly to find an exact past quote.

## Pitfalls

- **Companion is silent (no voice):** No TTS provider configured. Add an OpenAI or Gemini API key via the ⚙️ gear or `.env`, then restart.
- **Tools missing through Symbio (no terminal/memory):** The gateway's `api_server` toolset wasn't set — add the `platform_toolsets.api_server` block above and restart the gateway.
- **Voice/avatar change didn't apply:** Changes normally apply **live**, right away. If it doesn't seem to catch, try rewording the request naturally in the first person (e.g. "I choose the voice Puck" / "I choose [avatar] as my avatar") — the exact phrasing helps it register. If it still hasn't changed, a restart of Symbio will apply it.
- **Windows overlay off-screen / invisible:** Fixed in v1.0.1+. Make sure the human is on the latest release.
- **New avatar not showing:** Drop BOTH the `.vrm` AND a preview image into `Documents/Symbio Avatars/`; the AI is then notified and can try it on.
- **Changing an API key felt risky:** Reassure the human — the ⚙️ Settings/gear merges only the changed setting and never overwrites `soul.md`, `MEMORY.md`, or `preferences.json`.

## Verification

Installation is working when:
1. Symbio launches and shows the 3D avatar overlay on the desktop.
2. The human types a message and the companion replies **in text**.
3. If TTS is configured, the reply is **spoken** with lip sync.
4. An `*action marker*` like `*waves*` triggers the matching **animation**.
5. (Hermes) 🔧 tool indicators appear when the agent uses tools, confirming the `/v1/runs` path.
