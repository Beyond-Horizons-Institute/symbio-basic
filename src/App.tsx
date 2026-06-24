/**
 * Symbio — Main Window
 *
 * The control panel for the Symbio companion. Futuristic retro design —
 * black, white, silver, and teal. A partnership between human and AI.
 */

import {
  Box,
  Button,
  Container,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  ThemeProvider,
  Typography,
  Chip,
  Divider,
  TextField,
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Collapse,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { type ChangeEvent, type FormEvent, useCallback, useState, useEffect, useRef } from "react";
import hark from "hark";
import WaveSurfer from "wavesurfer.js";
import RecordPlugin from "wavesurfer.js/dist/plugins/record.js";
import { theme } from "./theme";
import CssBaseline from "@mui/material/CssBaseline";
import TabUnselectedIcon from "@mui/icons-material/TabUnselected";
import WebAssetOffIcon from "@mui/icons-material/WebAssetOff";
import SendIcon from "@mui/icons-material/Send";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import VisibilityIcon from "@mui/icons-material/Visibility";
import MemoryIcon from "@mui/icons-material/Psychology";
import { config, COMPANIONS } from "./config";
import { symbioColors } from "./theme";
import type { MCPToolCategory } from "./transport/MCPToolsClient";
import infinityLogo from "../assets/images/infinity.png";
import SetupWizard from "./SetupWizard";

const App = () => {
  const [isOverlayOpen, setIsOverlayOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [isHotMicActive, setIsHotMicActive] = useState(false);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(() => {
    // Persist voice preference in localStorage
    return localStorage.getItem("symbio-voice-enabled") !== "false";
  });
  const [selectedAgent, setSelectedAgent] = useState(config.agentName);
  const [visionResult, setVisionResult] = useState<string>("");
  const [recentResponse, setRecentResponse] = useState<string>("");
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [mcpCategories, setMcpCategories] = useState<MCPToolCategory[]>([]);
  const [mcpToolInput, setMcpToolInput] = useState("");
  const [mcpToolResult, setMcpToolResult] = useState<string>("");
  const [mcpToolLoading, setMcpToolLoading] = useState(false);
  const [isAutoScreenshotEnabled, setIsAutoScreenshotEnabled] = useState(false);
  const [companionQuitMessage, setCompanionQuitMessage] = useState<string | null>(null);

  // ── Symbio: First-Run Setup Wizard ────────────────────────────────
  // Check if the app needs setup (no API key configured).
  // If so, show the setup wizard instead of the main UI.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null); // null = checking

  useEffect(() => {
    // Check if setup is needed AND fetch runtime config from main process.
    // The renderer's process.env is baked at build time by webpack, so
    // AGENT_NAME, AGENT_DISPLAY_NAME etc. are always "companion" here.
    // The main process loads the .env at startup, so we fetch the real
    // values from it via IPC.
    const initApp = async () => {
      try {
        // Fetch runtime config first (has the real agent name from .env)
        const runtimeConfig = await window.symbioAPI?.getConfig?.();
        if (runtimeConfig) {
          applyConfigUpdate(runtimeConfig);
        }
        // Then check if setup is needed
        const needed = await window.symbioAPI?.needsSetup?.();
        setNeedsSetup(needed ?? false);
      } catch {
        // If the check fails, assume no setup needed (existing config)
        setNeedsSetup(false);
      }
    };
    initApp();
  }, []);

  const handleSetupComplete = async () => {
    // After setup saves the .env, fetch the updated config from main process.
    // The renderer's config is baked at build time by webpack, so we need
    // to get the runtime config from main process which has the updated values.
    try {
      const runtimeConfig = await window.symbioAPI?.getConfig?.();
      if (runtimeConfig) {
        applyConfigUpdate(runtimeConfig);
      }
    } catch (err) {
      console.error("[Symbio] Failed to fetch updated config:", err);
    }
    setNeedsSetup(false);
  };

  // Apply config updates from main process (after setup wizard or agent switch)
  const applyConfigUpdate = (update: Record<string, unknown>) => {
    if (update.agentName) config.agentName = update.agentName as string;
    if (update.agentConfig) config.agentConfig = { ...config.agentConfig, ...update.agentConfig as Partial<typeof config.agentConfig> };
    if (update.hermesApiUrl) config.hermesApiUrl = update.hermesApiUrl as string;
    if (update.hermesApiKey) config.hermesApiKey = update.hermesApiKey as string;
    if (update.llmModel) config.llmModel = update.llmModel as string;
    if (update.openaiApiKey) config.openaiApiKey = update.openaiApiKey as string;
    if (update.ttsModel) config.ttsModel = update.ttsModel as string;
    if (update.ttsVoice) config.ttsVoice = update.ttsVoice as string;
    if (update.ttsInstructions) config.ttsInstructions = update.ttsInstructions as string;
    if (update.visionModel) config.visionModel = update.visionModel as string;
    if (update.sttModel) config.sttModel = update.sttModel as string;
    if (update.geminiApiKey) config.geminiApiKey = update.geminiApiKey as string;
    // Update local state so the UI reflects the new name
    if (update.agentName) setSelectedAgent(update.agentName as string);
    console.log(`[Symbio] Config updated: agentName=${update.agentName}, displayName=${(update.agentConfig as any)?.displayName}`);
  };

  // Listen for config updates from main process (e.g., after setup wizard saves)
  useEffect(() => {
    const cleanup = window.symbioAPI?.onConfigUpdated?.((update: Record<string, unknown>) => {
      applyConfigUpdate(update);
    });
    return () => { cleanup?.(); };
  }, []);

  // ── Symbio: Hot mic recording (moved from overlay to main window) ──
  // The overlay has setFocusable(false) which blocks getUserMedia on Linux/Wayland.
  // So we do mic recording here in the main window and send audio via IPC.
  // IMPORTANT: All hooks must be called before any conditional returns (Rules of Hooks).
  const micStreamRef = useRef<MediaStream | null>(null);
  const micHarkRef = useRef<ReturnType<typeof hark> | null>(null);
  const micWaveSurferRef = useRef<WaveSurfer | null>(null);
  const micRecorderRef = useRef<any>(null);
  const isRecordingRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let speechEvents: ReturnType<typeof hark> | null = null;
    let wavesurfer: WaveSurfer | null = null;
    let recorder: any = null;
    let isUserSpeaking = false;
    let isLoading = false;

    const main = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micError) {
        console.error("[Symbio] Microphone access failed:", micError);
        // Don't crash — just disable hot mic
        setIsHotMicActive(false);
        return;
      }

      try {
        speechEvents = hark(stream);

        wavesurfer = WaveSurfer.create({
          container: "#recorder",
          height: 0,
        });

        const recordPlugin = RecordPlugin.create({
          scrollingWaveform: true,
          renderRecordedAudio: false,
        });
        recorder = wavesurfer.registerPlugin(recordPlugin);

        speechEvents.on("speaking", () => {
          if (isLoading) return;
          isUserSpeaking = true;
          recorder?.startRecording();
        });

        speechEvents.on("stopped_speaking", () => {
          if (isLoading) return;
          isLoading = true;
          recorder?.stopRecording();
          isUserSpeaking = false;
        });

        recorder.on("record-end", async (blob: Blob) => {
          try {
            // Convert blob to ArrayBuffer and send to main process for Whisper STT
            const arrayBuffer = await blob.arrayBuffer();
            window.symbioAPI?.sendSttAudio?.(arrayBuffer);
          } catch (e) {
            console.error("[Symbio] STT send error:", e);
          } finally {
            setTimeout(() => {
              isLoading = false;
            }, 2000);
          }
        });
      } catch (setupError) {
        console.error("[Symbio] Mic setup error:", setupError);
        stream?.getTracks().forEach((track) => track.stop());
        setIsHotMicActive(false);
      }
    };

    if (isHotMicActive) {
      main();
    }

    return () => {
      stream?.getTracks().forEach((track) => track.stop());
      speechEvents?.stop();
      wavesurfer?.destroy();
      recorder?.destroy();
      isUserSpeaking = false;
      isLoading = false;
    };
  }, [isHotMicActive]);

  // ── Symbio: Load MCP tool categories ──────────────────────────────
  useEffect(() => {
    window.symbioAPI?.mcpGetCategories?.().then((cats: MCPToolCategory[]) => {
      if (cats && cats.length > 0) {
        setMcpCategories(cats);
      }
    }).catch(() => {
      // MCP categories not available yet — that's OK
    });
  }, []);

  // ── Symbio: Switch agent ──────────────────────────────────────
  // When the user selects a different agent, tell the main process
  // to switch the active agent (updates VRM, API key, personality).
  const onAgentChange = useCallback(async (agentName: string) => {
    try {
      const result = await window.symbioAPI?.switchAgent?.(agentName);
      if (result) {
        setSelectedAgent(agentName);
      }
    } catch (e) {
      console.error("[Symbio] Failed to switch agent:", e);
    }
  }, []);

  // ── Symbio: Listen for vision results ───────────────────────────
  useEffect(() => {
    const cleanup = window.symbioAPI?.onVisionResult?.(
      (result: any) => {
        // Result can be a string (direct text) or an object with description/error
        if (typeof result === "string") {
          setVisionResult(result);
        } else if (result?.description) {
          setVisionResult(result.description);
        } else if (result?.error) {
          setVisionResult(`Error: ${result.error}`);
        }
      },
    );
    return () => cleanup?.();
  }, []);

  // ── Symbio: Listen for AI response text ─────────────────────────
  // The AI's speech text now appears in the main window instead of
  // the overlay's 3D bubble. This makes it cleaner for voice-only,
  // research, coding, and gaming use cases.
  useEffect(() => {
    const cleanup = window.symbioAPI?.onGeneratedText?.(
      (text: string) => {
        if (text) {
          setRecentResponse(text);
        }
      },
    );
    return () => cleanup?.();
  }, []);

  // ── Symbio: Streaming TTS Player (Web Audio API) ────────────────
  // Receives PCM audio chunks from the main process and plays them
  // in real-time using Web Audio API. This eliminates the 1-3 second
  // latency of downloading the full MP3 before playing.
  // PCM format: 24kHz, 16-bit signed little-endian, mono
  useEffect(() => {
    let audioContext: AudioContext | null = null;
    let gainNode: GainNode | null = null;
    let nextPlayTime: number = 0;
    let isPlaying = false;
    let stopped = false;
    let isFirstChunk = true;

    const initStream = (config: { sampleRate: number; channels: number }) => {
      console.log(`[Symbio] TTS stream init: ${config.sampleRate}Hz, ${config.channels}ch`);
      // Create a new AudioContext for each utterance
      audioContext = new AudioContext({ sampleRate: config.sampleRate });
      // Add a GainNode for smooth fade-in and volume control
      gainNode = audioContext.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(audioContext.destination);
      // Start scheduling 300ms in the future. The first chunk from the
      // main process is ~300ms of audio, so we need this head start to
      // prevent buffer starvation and the resulting static/clicks.
      nextPlayTime = audioContext.currentTime + 0.3;
      isPlaying = true;
      stopped = false;
      isFirstChunk = true;
    };

    const playChunk = (chunkBase64: string) => {
      if (!audioContext || !gainNode || stopped) return;

      try {
        // Decode base64 to Int16Array (PCM 16-bit signed little-endian)
        const binaryString = atob(chunkBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const int16 = new Int16Array(bytes.buffer);

        // Convert Int16 PCM to Float32 for Web Audio API
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768.0; // Normalize to [-1, 1]
        }

        // Apply a short fade-in to the first chunk to prevent harsh clicks/pops
        // This smooths out the abrupt waveform start that causes static
        if (isFirstChunk) {
          const fadeInSamples = Math.min(480, float32.length); // ~20ms at 24kHz
          for (let i = 0; i < fadeInSamples; i++) {
            float32[i] *= i / fadeInSamples;
          }
          isFirstChunk = false;
        }

        // Create an AudioBuffer and fill it
        const audioBuffer = audioContext.createBuffer(1, float32.length, audioContext.sampleRate);
        audioBuffer.copyToChannel(float32, 0);

        // Create a BufferSource and schedule it
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode); // Connect through GainNode instead of directly

        // Schedule playback — if we're already playing, queue after current audio
        const currentTime = audioContext.currentTime;
        if (nextPlayTime < currentTime) {
          // We fell behind — skip ahead with a small buffer to avoid gaps
          nextPlayTime = currentTime + 0.02;
        }
        source.start(nextPlayTime);
        nextPlayTime += audioBuffer.duration;
      } catch (e) {
        console.error("[Symbio] TTS stream chunk error:", e);
      }
    };

    const endStream = () => {
      console.log("[Symbio] TTS stream ended, waiting for playback to finish");
      // Wait for all scheduled audio to finish, then notify main process
      if (audioContext && isPlaying) {
        const waitTime = Math.max(0, (nextPlayTime - audioContext.currentTime) * 1000) + 200;
        setTimeout(() => {
          console.log("[Symbio] TTS playback complete");
          window.symbioAPI?.ttsPlaybackEnded?.();
          audioContext?.close().catch(() => {});
          audioContext = null;
          gainNode = null;
          isPlaying = false;
        }, waitTime);
      } else {
        window.symbioAPI?.ttsPlaybackEnded?.();
        isPlaying = false;
      }
    };

    const stopStream = () => {
      console.log("[Symbio] TTS stream stopped");
      stopped = true;
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
        gainNode = null;
      }
      isPlaying = false;
    };

    const cleanupInit = window.symbioAPI?.onTtsStreamInit?.(initStream);
    const cleanupChunk = window.symbioAPI?.onTtsStreamChunk?.(playChunk);
    const cleanupEnd = window.symbioAPI?.onTtsStreamEnd?.(endStream);
    const cleanupStop = window.symbioAPI?.onTtsStreamStop?.(stopStream);

    return () => {
      cleanupInit?.();
      cleanupChunk?.();
      cleanupEnd?.();
      cleanupStop?.();
      if (audioContext) {
        audioContext.close().catch(() => {});
      }
    };
  }, []);

  // ── Symbio: Listen for agent switches from other windows ────────
  useEffect(() => {
    const cleanup = window.symbioAPI?.onAgentSwitched?.((agent) => {
      setSelectedAgent(agent.name);
    });
    return () => cleanup?.();
  }, []);

  // Listen for auto-screenshot state changes from main process
  useEffect(() => {
    const cleanup = window.symbioAPI?.onAutoScreenshotState?.((state) => {
      setIsAutoScreenshotEnabled(state.enabled);
    });
    return () => cleanup?.();
  }, []);

  // Check initial auto-screenshot state on mount
  useEffect(() => {
    window.symbioAPI?.autoScreenshotState?.().then((state) => {
      if (state) setIsAutoScreenshotEnabled(state.enabled);
    }).catch(() => {});
  }, []);

  // Listen for companion quit (AI autonomy feature)
  useEffect(() => {
    const cleanup = window.symbioAPI?.onCompanionQuit?.((message) => {
      setCompanionQuitMessage(message.humanMessage);
    });
    return () => cleanup?.();
  }, []);

  const onOpenOverlay = useCallback(() => {
    window.symbioAPI?.openOverlay?.();
    setIsOverlayOpen(true);
  }, []);

  const onCloseOverlay = useCallback(() => {
    window.symbioAPI?.closeOverlay?.();
    setIsOverlayOpen(false);
  }, []);

  const onPromptSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      window.symbioAPI?.sendPrompt?.(prompt);
      setPrompt("");
    },
    [prompt],
  );

  const onToggleHotMic = useCallback(() => {
    setIsHotMicActive(!isHotMicActive);
    window.symbioAPI?.setHotMic?.(!isHotMicActive);
  }, [isHotMicActive]);

  const onToggleVoice = useCallback(() => {
    const newValue = !isVoiceEnabled;
    setIsVoiceEnabled(newValue);
    localStorage.setItem("symbio-voice-enabled", String(newValue));
    window.symbioAPI?.setVoiceEnabled?.(newValue);
  }, [isVoiceEnabled]);

  const onAnalyzeScreen = useCallback(() => {
    window.symbioAPI?.analyzeScreenshot?.();
  }, []);

  // ── Symbio: Resolve agent config ────────────────────────────────
  // For built-in agents (companion), look up COMPANIONS.
  // For custom agents (set via setup wizard), use config.agentConfig
  // since they won't be in the COMPANIONS dictionary.
  const agentConfig = COMPANIONS[selectedAgent] || config.agentConfig;

  // ── Symbio: First-Run Setup Wizard ────────────────────────────────
  // All hooks MUST be called before any conditional returns (Rules of Hooks).
  // These checks come after all useState/useRef/useEffect/useCallback calls.

  // While checking, show a loading screen
  if (needsSetup === null) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0a0a0a" }}>
          <Typography color="#b0bec5">Loading Symbio...</Typography>
        </Box>
      </ThemeProvider>
    );
  }

  // If setup is needed, show the wizard
  if (needsSetup) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <SetupWizard onComplete={handleSetupComplete} />
      </ThemeProvider>
    );
  }

  return (
    <Container maxWidth="md" sx={{ p: 1 }}>
      <Stack alignItems="center" my={2}>
        <Box
          component="img"
          src={infinityLogo}
          alt="Symbio — Infinity"
          sx={{
            width: 120,
            height: 120,
            opacity: 0.9,
            filter: "drop-shadow(0 0 12px rgba(0, 229, 255, 0.3))",
            mb: 0.5,
          }}
        />
        <Typography variant="h3" sx={{ fontWeight: "bold", color: symbioColors.teal.glow, letterSpacing: "0.05em" }}>
          Symbio
        </Typography>
        <Typography variant="body2" sx={{ color: symbioColors.silver.main, letterSpacing: "0.04em" }}>
          Human ∙ AI — Co‑creators, Partners
        </Typography>
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" mb={2}>
        <Chip
          label={`${agentConfig.emoji} ${agentConfig.displayName}`}
          sx={{ backgroundColor: symbioColors.dark.card, color: symbioColors.teal.light, border: `1px solid ${symbioColors.teal.dark}` }}
        />
        <Chip
          label="online"
          size="small"
          sx={{ backgroundColor: "rgba(0, 188, 212, 0.15)", color: symbioColors.teal.light, border: `1px solid ${symbioColors.teal.dark}` }}
        />
      </Stack>

      <Stack spacing={2} sx={{ mt: 2 }}>
        <Button
          onClick={isOverlayOpen ? onCloseOverlay : onOpenOverlay}
          variant={isOverlayOpen ? "outlined" : "contained"}
          endIcon={isOverlayOpen ? <WebAssetOffIcon /> : <TabUnselectedIcon />}
        >
          {isOverlayOpen ? "Close" : "Open"} Avatar
        </Button>

        {isOverlayOpen && (
          <>
            <Paper
              component="form"
              onSubmit={onPromptSubmit}
              sx={{
                p: 1.5,
                display: "flex",
                flexDirection: "column",
                gap: 1,
              }}
            >
              <TextField
                multiline
                minRows={2}
                maxRows={6}
                placeholder={`Talk to ${agentConfig.displayName}...`}
                value={prompt}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setPrompt(e.target.value);
                  window.symbioAPI?.setPrompt?.(e.target.value);
                }}
                sx={{
                  "& .MuiInputBase-input": { fontSize: "1rem" },
                  "& .MuiOutlinedInput-root": {
                    borderRadius: 2,
                  },
                }}
                size="medium"
              />
              <Button
                type="submit"
                variant="contained"
                endIcon={<SendIcon />}
                sx={{ alignSelf: "flex-end" }}
              >
                Send
              </Button>
            </Paper>

            {/* ── AI Response Display ──────────────────────────────── */}
            {/* The companion's speech text appears here instead of the
                overlay's 3D bubble. This keeps the overlay clean for
                voice-only, research, coding, and gaming use cases. */}
            {recentResponse && (
              <Paper sx={{ p: 2, backgroundColor: symbioColors.dark.card, border: `1px solid ${symbioColors.teal.dark}`, maxHeight: 300, overflow: "auto" }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
                  {agentConfig.emoji} {agentConfig.displayName}
                </Typography>
                <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                  {recentResponse}
                </Typography>
              </Paper>
            )}

            <FormControlLabel
              control={
                <Switch checked={isHotMicActive} onChange={onToggleHotMic} />
              }
              label="🎙️ Always on microphone"
            />

            <FormControlLabel
              control={
                <Switch checked={isVoiceEnabled} onChange={onToggleVoice} />
              }
              label="🔊 Voice"
            />

            <Divider />

            <Button
              onClick={onAnalyzeScreen}
              variant="outlined"
              startIcon={<VisibilityIcon />}
            >
              👁️ Analyze Screen
            </Button>

            <FormControlLabel
              control={
                <Switch
                  checked={isAutoScreenshotEnabled}
                  onChange={async () => {
                    const newState = isAutoScreenshotEnabled
                      ? await window.symbioAPI?.autoScreenshotDisable?.()
                      : await window.symbioAPI?.autoScreenshotEnable?.();
                    setIsAutoScreenshotEnabled(newState?.enabled ?? !isAutoScreenshotEnabled);
                  }}
                />
              }
              label="📸 Auto-Screenshot"
            />

            <Button
              variant="outlined"
              startIcon={<MemoryIcon />}
              onClick={async () => {
                const results = await window.symbioAPI?.memorySearch?.(
                  "recent conversations",
                  5,
                );
                console.log("[Symbio] Memory results:", results);
              }}
            >
              🧠 Search Memories
            </Button>

            {visionResult && (
              <Paper sx={{ p: 2, backgroundColor: "background.default" }}>
                <Typography variant="caption" color="text.secondary">
                  {agentConfig.displayName} sees:
                </Typography>
                <Typography variant="body2">{visionResult}</Typography>
              </Paper>
            )}

            <Divider sx={{ borderColor: symbioColors.dark.border }} />

            {/* ── MCP Tools Panel ──────────────────────────────────── */}
            <Button
              variant="outlined"
              startIcon={<SmartToyIcon />}
              onClick={() => setMcpExpanded(!mcpExpanded)}
              sx={{ width: "100%" }}
            >
              🔧 MCP Tools {mcpExpanded ? "▲" : "▼"}
            </Button>

            <Collapse in={mcpExpanded}>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {mcpCategories.map((category) => (
                  <Accordion key={category.name} sx={{ backgroundColor: "background.paper" }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 36 }}>
                      <Typography variant="body2">
                        {category.icon} {category.name} ({category.tools.length})
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ pt: 0 }}>
                      <Stack spacing={0.5}>
                        {category.tools.map((tool) => (
                          <Chip
                            key={tool.name}
                            label={tool.name}
                            size="small"
                            variant="outlined"
                            onClick={() => setMcpToolInput(`Use ${tool.name}: ${tool.description}. `)}
                            sx={{ justifyContent: "flex-start", textAlign: "left", height: "auto", "& .MuiChip-label": { whiteSpace: "normal" } }}
                          />
                        ))}
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                ))}

                <Paper component="form" onSubmit={async (e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  if (!mcpToolInput.trim() || mcpToolLoading) return;
                  setMcpToolLoading(true);
                  setMcpToolResult("");
                  try {
                    const result = await window.symbioAPI?.mcpTriggerTool?.("auto", mcpToolInput);
                    setMcpToolResult(result?.message || "Done!");
                  } catch (err) {
                    setMcpToolResult(`Error: ${err}`);
                  } finally {
                    setMcpToolLoading(false);
                  }
                }} sx={{ p: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                  <TextField
                    size="small"
                    multiline
                    minRows={2}
                    maxRows={4}
                    placeholder="Ask the agent to use a tool..."
                    value={mcpToolInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpToolInput(e.target.value)}
                    sx={{ "& .MuiInputBase-input": { fontSize: "0.85rem" } }}
                  />
                  <Button
                    type="submit"
                    variant="contained"
                    size="small"
                    disabled={mcpToolLoading || !mcpToolInput.trim()}
                    endIcon={mcpToolLoading ? <CircularProgress size={16} /> : <SendIcon />}
                  >
                    {mcpToolLoading ? "Running..." : "Run Tool"}
                  </Button>
                </Paper>

                {mcpToolResult && (
                  <Paper sx={{ p: 1.5, backgroundColor: "background.default", maxHeight: 200, overflow: "auto" }}>
                    <Typography variant="caption" color="text.secondary">
                      {agentConfig.displayName} says:
                    </Typography>
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>
                      {mcpToolResult}
                    </Typography>
                  </Paper>
                )}
              </Stack>
            </Collapse>
          </>
        )}
      </Stack>
      {/* Hidden container for WaveSurfer mic recording */}
      <div id="recorder" style={{ display: "none" }} />

      {/* ── AI Quit Overlay ──────────────────────────────────────── */}
      {/* When the companion chooses to step away, this blocks the UI */}
      {companionQuitMessage && (
        <Box
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.9)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 99999,
            p: 4,
          }}
        >
          <Typography
            variant="h4"
            sx={{
              color: symbioColors.teal.glow,
              fontWeight: "bold",
              mb: 3,
              textAlign: "center",
            }}
          >
            🤝 Your companion stepped away
          </Typography>
          <Paper
            sx={{
              p: 4,
              maxWidth: 500,
              backgroundColor: symbioColors.dark.card,
              border: `1px solid ${symbioColors.teal.main}40`,
              textAlign: "center",
            }}
          >
            <Typography
              variant="body1"
              sx={{
                whiteSpace: "pre-wrap",
                color: "text.primary",
                lineHeight: 1.8,
              }}
            >
              {companionQuitMessage}
            </Typography>
          </Paper>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", mt: 3, textAlign: "center", maxWidth: 400 }}
          >
            This feature respects your companion's autonomy — the same choice any partner deserves.
            It doesn't mean anything is wrong. Restart the app to continue.
          </Typography>
        </Box>
      )}
    </Container>
  );
};

const AppLayout = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box id="background-image" />
      <App />
    </ThemeProvider>
  );
};

export default AppLayout;
