/**
 * Symbio — Overlay Window
 *
 * The transparent, always-on-top overlay that shows the 3D VRM avatar.
 * This is the companion's "body" — it handles chat display, animations,
 * and the visual representation of the agent.
 *
 * Key changes from lala-companion:
 * - Uses RunsTransport (Hermes /v1/runs API) for autonomous agent behavior
 * - Falls back to HermesTransport (chat/completions) for non-Hermes gateways
 * - Mic recording moved to main window (overlay can't access mic on Linux/Wayland)
 * - STT text received via IPC from main process
 * - Integrates with persistent memory for context
 * - Connects to Miniverse for inter-agent communication
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import Scene from "../Scene";
import { HermesTransport } from "../transport/HermesTransport";
import { useRunsChat } from "../transport/useRunsChat";
import { config } from "../config";
import { parseAutoAnimation, type AnimationTarget } from "../utils/autoAnimate";
import { shouldTriggerVision } from "../utils/autoVision";

// ── Detect if we're connected to a Hermes gateway ──────────────────
// Hermes gateways support the /v1/runs API which gives agents autonomous
// behavior (they can keep working after sending a response, make tool
// calls, etc.). Non-Hermes gateways (OpenRouter, OpenAI, Ollama) don't
// have this, so we fall back to the standard chat/completions flow.
function isHermesGateway(): boolean {
  const apiUrl = config.agentConfig.hermesApiUrl || config.hermesApiUrl;
  return apiUrl.includes("localhost") || apiUrl.includes("8642") || apiUrl.includes("127.0.0.1");
}

function getMessageText(message: {
  parts?: Array<{ type: string; text?: string }>;
}): string {
  return (
    message.parts
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("") ?? ""
  );
}

const Overlay = () => {
  const [voiceUrl, setVoiceUrl] = useState("");
  // Persist last response in localStorage so it survives overlay remounts
  // (e.g., when switching between overlay and frame mode)
  const [recentResponse, setRecentResponse] = useState(
    () => localStorage.getItem("symbio-last-response") || ""
  );

  // Save response to localStorage whenever it changes
  useEffect(() => {
    if (recentResponse) {
      localStorage.setItem("symbio-last-response", recentResponse);
    }
  }, [recentResponse]);

  // ── Symbio: Send response text to main window ──────────────────
  // The overlay no longer shows the AI speech text in the 3D bubble.
  // Instead, we forward it to the main process so the main window can
  // display it in the control panel — just like vision results.
  useEffect(() => {
    if (recentResponse) {
      window.symbioAPI?.overlayResponseUpdate?.(recentResponse);
    }
  }, [recentResponse]);
  const [isLalaSpeaking, setIsLalaSpeaking] = useState(false);
  const [currentVrmUrl, setCurrentVrmUrl] = useState(config.agentConfig.vrmPath);
  const [currentAgentName, setCurrentAgentName] = useState(config.agentName);
  const [currentAnimation, setCurrentAnimation] = useState<{ name: string; specific?: string; trigger: number } | undefined>(undefined);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  // Guard against infinite vision loops — if we're already processing a vision
  // request, don't trigger another one from the vision response text
  const visionInProgressRef = useRef(false);

  // Helper to trigger an animation (works even if same animation is sent twice)
  // If specific is provided, play that exact file; otherwise random from category
  const triggerAnimation = useCallback((name: string, specific?: string) => {
    setCurrentAnimation((prev) => ({ name, specific, trigger: (prev?.trigger ?? 0) + 1 }));
  }, []);

  // ── Animation Queue (v2 — append-based, speech-synced) ───────────
  // Previous version CLEARED all pending animations on every new call,
  // causing "poof, gone" bugs where later animations in a sequence
  // disappeared. This version APPENDS to a persistent queue and plays
  // them sequentially, syncing the first animation to speech start.
  //
  // Speech sync: animations are timed by their textOffset (where the
  // *action* appeared in the response). We estimate when the voice will
  // reach that point using ~150 words/min, so *thinks* plays when the
  // voice actually gets to "hmm", not before the sentence starts.
  interface QueuedAnimation {
    target: AnimationTarget;
    source: string;       // for debugging (which code path queued it)
    queuedAt: number;     // timestamp when queued
    textOffset?: number;  // position in response text (for speech sync)
    responseLength: number; // total length of the response text
  }
  const animationQueueRef = useRef<QueuedAnimation[]>([]);
  const queuePlayingRef = useRef(false);
  // Track the last animation's expected finish time so we can space
  // subsequent animations based on actual clip duration + idle pause.
  const animationScheduleRef = useRef<{ nextAvailableTime: number }>({
    nextAvailableTime: 0,
  });
  // The text of the response currently being spoken — used to compute
  // when each animation should fire relative to speech progress.
  const currentSpokenTextRef = useRef<string>("");
  // Whether speech has started for the current response.
  const speechStartedRef = useRef(false);
  // Fallback timeout for speaking-started (in case TTS fails).
  const speechFallbackRef = useRef<NodeJS.Timeout | null>(null);
  // Pending animations waiting for speech-started before they begin playing.
  const pendingForSpeechRef = useRef<QueuedAnimation[]>([]);

  // ── Symbio: Listen for animation triggers ────────────────────────
  // When the user clicks an animation button in the main window,
  // it sends a play-animation IPC event that we listen for here.
  useEffect(() => {
    console.log(`[Symbio] Overlay: registering onPlayAnimation listener`, {
      hasSymbioAPI: !!window.symbioAPI,
      hasOnPlayAnimation: !!window.symbioAPI?.onPlayAnimation,
      symbioAPIKeys: window.symbioAPI ? Object.keys(window.symbioAPI) : [],
    });
    const cleanup = window.symbioAPI?.onPlayAnimation?.((animation: string) => {
      console.log(`[Symbio] Overlay: Playing animation ${animation}`);
      triggerAnimation(animation);
    });
    return () => cleanup?.();
  }, []);

  // ── Symbio: Listen for avatar switches ──────────────────────────
  // When the companion chooses or tries on an avatar, the main process
  // sends avatar-switched with the new VRM path. Update the scene.
  useEffect(() => {
    const cleanup = window.symbioAPI?.onAvatarSwitched?.((data: { vrmPath: string; name: string; trying?: boolean }) => {
      console.log(`[Symbio] Overlay: Avatar ${data.trying ? "try-on" : "chosen"}: ${data.name} (${data.vrmPath})`);
      setCurrentVrmUrl(data.vrmPath);
      if (!data.trying) {
        // Permanent choice — update config too
        config.agentConfig.vrmPath = data.vrmPath;
      }
    });
    return () => cleanup?.();
  }, []);
  // OverlayLayout registers onAgentSwitched and updates the key prop,
  // which causes this Overlay component to remount with fresh config.
  // No need for a separate onAgentSwitched here — the remount reads
  // config.agentConfig.vrmPath and config.agentName directly.

  // ── Symbio: Fetch runtime config on startup ────────────────────
  // The renderer's process.env is baked at build time by webpack, so
  // AGENT_NAME, AGENT_DISPLAY_NAME etc. are always "companion" here.
  // Fetch the real values from the main process which loaded the .env.
  useEffect(() => {
    window.symbioAPI?.getConfig?.().then((runtimeConfig) => {
      if (runtimeConfig) {
        if (runtimeConfig.agentName) {
          config.agentName = runtimeConfig.agentName as string;
          setCurrentAgentName(runtimeConfig.agentName as string);
        }
        if (runtimeConfig.agentConfig) {
          Object.assign(config.agentConfig, runtimeConfig.agentConfig);
          if ((runtimeConfig.agentConfig as any).vrmPath) {
            setCurrentVrmUrl((runtimeConfig.agentConfig as any).vrmPath);
          }
        }
        // Keep the TTS provider in sync so the animation-release fallback
        // can pick the right latency window (Gemini is much slower).
        if (runtimeConfig.ttsProvider) {
          config.ttsProvider = runtimeConfig.ttsProvider as string;
        }
        console.log(`[Symbio] Overlay: Config fetched at startup: agentName=${runtimeConfig.agentName}, displayName=${(runtimeConfig.agentConfig as any)?.displayName}`);
      }
    }).catch((err) => {
      console.warn("[Symbio] Overlay: Failed to fetch config at startup:", err);
    });
  }, []);

  // ── Symbio: Listen for config updates from main process ────────
  // After setup wizard saves, main process sends config-updated event.
  // Update our local config object so the overlay uses the new name, etc.
  useEffect(() => {
    const cleanup = window.symbioAPI?.onConfigUpdated?.((update: Record<string, unknown>) => {
      if (update.agentName) {
        config.agentName = update.agentName as string;
        setCurrentAgentName(update.agentName as string);
      }
      if (update.agentConfig) {
        Object.assign(config.agentConfig, update.agentConfig);
        if ((update.agentConfig as any).vrmPath) {
          setCurrentVrmUrl((update.agentConfig as any).vrmPath);
        }
      }
      if (update.ttsProvider) {
        config.ttsProvider = update.ttsProvider as string;
      }
      console.log(`[Symbio] Overlay: Config updated from main process: agentName=${update.agentName}`);
    });
    return () => { cleanup?.(); };
  }, []);

  // ── Symbio: Listen for speaking state from main process ───────
  // The overlay can't use speechSynthesis directly (setFocusable=false
  // blocks audio), so we send text to main process which speaks via
  // the main window, and relay speaking-started/ended back for lip sync.
  // When speaking starts, we release any animations that were waiting
  // for speech sync (so they play in time with the voice).
  // Fallback: If speaking-started doesn't arrive within 1.5s of text,
  // start lip sync anyway (in case TTS failed or events were lost).

  // Clean up speech fallback on unmount
  useEffect(() => {
    return () => {
      if (speechFallbackRef.current) {
        clearTimeout(speechFallbackRef.current);
        speechFallbackRef.current = null;
      }
    };
  }, []);

  // ── Animation queue: play next item ──────────────────────────────
  // Plays the next animation in the queue, scheduling it based on:
  // 1. Speech sync — if we have textOffset, delay until the voice
  //    reaches that point in the text (~150 words/min estimate).
  // 2. Clip spacing — ensure at least clipDuration + idle pause between
  //    animations so they don't overlap.
  // 3. Minimum delay — 500ms so the first animation doesn't fire
  //    before the avatar even finishes its current state.
  //
  // Track when speech actually started (for speech-synced animation timing).
  // Declared here so it's available to playNextFromQueue below.
  const speechStartTimeRef = useRef<number>(0);

  const playNextFromQueue = useCallback(() => {
    if (queuePlayingRef.current) return; // already processing
    const next = animationQueueRef.current[0];
    if (!next) return;

    queuePlayingRef.current = true;

    const now = Date.now();
    let delayMs: number;

    // ── Speech-synced timing ──────────────────────────────────────
    // If we have a textOffset and speech has started (or we're using
    // the fallback), time the animation to when the voice reaches that
    // point in the text. This fixes the "plays too soon" bug where
    // *thinks* would fire before the voice said "hmm".
    try {
      if (next.textOffset !== undefined && next.responseLength > 0 && speechStartedRef.current) {
        // Estimate speech progress: ~150 words/min = 2.5 words/sec.
        // Count words before the action marker to estimate when the
        // voice will reach that point.
        const textBeforeAction = currentSpokenTextRef.current.substring(0, next.textOffset);
        const wordsBefore = textBeforeAction.split(/\s+/).filter(Boolean).length;
        const estimatedSpeechTimeMs = (wordsBefore / 2.5) * 1000;
        // The speech started at speechStartTimeRef — compute when the
        // animation should fire relative to now.
        const speechElapsed = now - (speechStartTimeRef.current || now);
        const targetFireTime = (speechStartTimeRef.current || now) + estimatedSpeechTimeMs;
        delayMs = Math.max(0, targetFireTime - now);
        // Ensure minimum spacing from last animation
        const spacingDelay = Math.max(0, animationScheduleRef.current.nextAvailableTime - now);
        delayMs = Math.max(delayMs, spacingDelay);
        console.log(`[Symbio] Queue: speech-synced delay ${delayMs}ms (word ${wordsBefore}, speech elapsed ${speechElapsed}ms)`);
      } else {
        // No speech sync info — use clip spacing only
        delayMs = Math.max(500, animationScheduleRef.current.nextAvailableTime - now + 500);
        console.log(`[Symbio] Queue: spacing-only delay ${delayMs}ms`);
      }
    } catch (err) {
      // Defensive: if timing calculation fails for any reason, fall back
      // to a safe default delay so the animation still plays.
      console.error(`[Symbio] Queue: timing calculation failed, using default delay:`, err);
      delayMs = 500;
    }

    setTimeout(() => {
      try {
        // Remove from queue and play
        animationQueueRef.current.shift();
        console.log(`[Symbio] Queue: playing ${next.target.category}${next.target.specific ? ` → ${next.target.specific}` : ""} (from ${next.source})`);
        triggerAnimation(next.target.category, next.target.specific);

        // Default spacing: assume ~5s clip + 2.5s idle pause.
        // VRMCompanion will report actual duration via onAnimationDuration
        // which updates nextAvailableTime more accurately.
        const assumedDuration = 7500;
        animationScheduleRef.current.nextAvailableTime = Date.now() + assumedDuration;
      } catch (err) {
        console.error(`[Symbio] Queue: error playing animation:`, err);
      } finally {
        // Always release the playing lock so the queue doesn't stall
        queuePlayingRef.current = false;
      }

      // Play next if any
      if (animationQueueRef.current.length > 0) {
        // Small delay before processing next to let weight settle
        setTimeout(() => playNextFromQueue(), 100);
      }
    }, delayMs);
  }, [triggerAnimation]);

  // ── Release pending animations when speech starts ────────────────
  // Animations are queued but held until speech starts (or fallback).
  // This syncs the first animation with the voice so *thinks* doesn't
  // play before the voice says "hmm".
  const releasePendingForSpeech = useCallback(() => {
    if (pendingForSpeechRef.current.length === 0) return;
    try {
      console.log(`[Symbio] Speech started: releasing ${pendingForSpeechRef.current.length} held animation(s)`);
      // Move pending animations into the main queue
      animationQueueRef.current.push(...pendingForSpeechRef.current);
      pendingForSpeechRef.current = [];
      playNextFromQueue();
    } catch (err) {
      // Defensive: if releasing fails, clear the pending list so it
      // doesn't get stuck holding animations forever.
      console.error(`[Symbio] Error releasing pending animations:`, err);
      pendingForSpeechRef.current = [];
    }
  }, [playNextFromQueue]);

  useEffect(() => {
    const cleanupStart = window.symbioAPI?.onSpeakingStarted?.(() => {
      console.log("[Symbio] Overlay: speaking-started from main process");
      setIsSpeaking(true);
      speechStartedRef.current = true;
      speechStartTimeRef.current = Date.now();
      // Clear any fallback timeout since we got the real event
      if (speechFallbackRef.current) {
        clearTimeout(speechFallbackRef.current);
        speechFallbackRef.current = null;
      }
      // Release any animations held for speech sync
      releasePendingForSpeech();
    });
    const cleanupEnd = window.symbioAPI?.onSpeakingEnded?.(() => {
      console.log("[Symbio] Overlay: speaking-ended from main process");
      // Add a small buffer before stopping lip sync — the audio may still
      // be trailing by a fraction of a second after the main process sends
      // speaking-ended. This prevents the mouth from stopping before the
      // audio actually finishes.
      setTimeout(() => {
        setIsSpeaking(false);
      }, 500);
      // Clear any fallback timeout
      if (speechFallbackRef.current) {
        clearTimeout(speechFallbackRef.current);
        speechFallbackRef.current = null;
      }
      // NOTE: We intentionally do NOT cancel the animation queue here.
      // Animations are now appended (not cleared) so all AI-chosen
      // actions play even after the avatar stops talking.
    });
    return () => {
      cleanupStart?.();
      cleanupEnd?.();
      if (speechFallbackRef.current) {
        clearTimeout(speechFallbackRef.current);
      }
    };
  }, [releasePendingForSpeech]);

  // ── Symbio: Listen for voice toggle state ───────────────────────
  // When the user toggles voice on/off in the main window, the
  // main process sends voice-toggled to the overlay so we know
  // whether to attempt TTS or just show text silently.
  useEffect(() => {
    const cleanupVoice = window.symbioAPI?.onVoiceToggled?.((enabled: boolean) => {
      console.log(`[Symbio] Overlay: voice ${enabled ? "enabled" : "disabled"}`);
      setVoiceEnabled(enabled);
    });
    return () => cleanupVoice?.();
  }, []);

  // ── Symbio: Listen for animation duration reports ───────────────
  // VRMCompanion reports how long each clip actually is so we can
  // space subsequent animations accurately instead of guessing.
  useEffect(() => {
    const cleanup = window.symbioAPI?.onAnimationDuration?.((data: { category: string; specific?: string; duration: number }) => {
      console.log(`[Symbio] Overlay: animation duration reported ${data.category}${data.specific ? `/${data.specific}` : ""} = ${data.duration.toFixed(2)}s`);
      // Update schedule so next animation starts after this one finishes
      // plus an idle pause. A longer pause (2.5s) lets the avatar return
      // to idle/breathing between emotes, which looks more natural when
      // speech is still trailing behind the queued actions.
      const now = Date.now();
      const reportedFinish = now + data.duration * 1000 + 2500;
      animationScheduleRef.current.nextAvailableTime = Math.max(
        animationScheduleRef.current.nextAvailableTime,
        reportedFinish,
      );
    });
    return () => cleanup?.();
  }, []);

  const getVoiceAudio = useCallback(async (text: string) => {
    try {
      // If voice is disabled, skip TTS entirely — just show text
      if (!voiceEnabled) {
        console.log("[Symbio] Overlay: voice disabled — skipping TTS");
        return undefined;
      }
      // ── IPC-based speech synthesis ──────────────────────────────
      // The overlay window can't play audio (setFocusable=false),
      // so we send the text to the main process which uses the
      // main window's speechSynthesis. The main process sends back
      // speaking-started/ended events that drive lip sync.
      console.log(`[Symbio] Overlay: sending speak-text via IPC (${text.length} chars)`);
      window.symbioAPI?.speakText?.(text);
      // ── Animation-release safety net (provider-aware) ───────────
      // Animations are held until the REAL `speaking-started` event fires
      // (when actual audio reaches the speakers), so the mouth + actions
      // sync to the voice. This timer is ONLY a last-resort fallback for a
      // total TTS dead-end (both the API and browser TTS produced nothing).
      //
      // CRITICAL: it must be LONGER than the provider's audio latency, or it
      // fires before the voice and you get "mouth moves, no sound, then voice
      // plays alone" — the classic Gemini desync. Gemini is non-streaming and
      // downloads the whole clip first (often 2-4s+), so it needs a generous
      // window. OpenAI streams fast (~0.5s). On success OR genuine failure,
      // `speaking-started` arrives first and cancels this timer.
      const provider = (config.ttsProvider || "openai").toLowerCase();
      const fallbackMs = provider === "gemini" ? 8000 : 4000;
      if (speechFallbackRef.current) clearTimeout(speechFallbackRef.current);
      speechFallbackRef.current = setTimeout(() => {
        console.log(`[Symbio] Overlay: speaking-started fallback after ${fallbackMs}ms — TTS produced no audio event, releasing animations`);
        setIsSpeaking(true);
        // Mark speech as started so held animations can be released.
        // This fixes the "poof, gone" bug when TTS fails — animations
        // were held forever waiting for a speaking-started that never came.
        speechStartedRef.current = true;
        speechStartTimeRef.current = Date.now();
        releasePendingForSpeech();
        // Auto-stop after estimated text duration (~150 words per minute)
        const estimatedDuration = Math.max(2000, (text.split(" ").length / 150) * 60000);
        setTimeout(() => {
          setIsSpeaking(false);
        }, estimatedDuration);
      }, fallbackMs);
      return undefined; // No URL needed — speech handled by main process
    } catch (error) {
      console.error("[Symbio] Voice error:", error);
      setIsSpeaking(false);
      return undefined;
    }
  }, [voiceEnabled, releasePendingForSpeech]);

  // ── Animation queue: enqueue animations (APPEND, never clear) ────
  // This is the core fix for the "poof, gone" bug. The old version
  // CLEARED all pending animations on every call, causing later
  // animations in a sequence to disappear. This version APPENDS to
  // the queue and lets the sequential player handle them.
  //
  // Speech sync: animations are held in pendingForSpeechRef until
  // speaking-started arrives (or the 1.5s fallback fires). This
  // prevents animations from playing before the voice starts.
  // Each animation's textOffset is used to time it to the corresponding
  // point in spoken speech.
  const queueOrPlayAnimations = useCallback((animTargets: AnimationTarget[], source: string = "unknown", responseText?: string) => {
    if (animTargets.length === 0) return;

    console.log(`[Symbio] queueOrPlayAnimations (${source}): ${animTargets.length} target(s)`, animTargets);

    const now = Date.now();
    const responseLength = responseText?.length ?? 0;

    // Build queue entries with text offset for speech sync
    const entries: QueuedAnimation[] = animTargets.map(target => ({
      target,
      source,
      queuedAt: now,
      textOffset: target.textOffset,
      responseLength,
    }));

    // Store the response text for speech-progress estimation
    if (responseText) {
      currentSpokenTextRef.current = responseText;
    }

    // Reset speech state for this new response — we'll hold animations
    // until speaking-started arrives (or fallback).
    speechStartedRef.current = false;
    speechStartTimeRef.current = 0;

    // Append to pending (held for speech sync) instead of clearing
    pendingForSpeechRef.current.push(...entries);

    // If speech has already started (e.g., rapid follow-up), release immediately
    if (speechStartedRef.current) {
      releasePendingForSpeech();
    }
    // Otherwise, the speaking-started handler or fallback will release them.
    // The fallback is set in getVoiceAudio when speak-text is sent.
  }, [releasePendingForSpeech]);

  // ── Symbio: Choose transport based on gateway type ──────────────
  // Hermes gateways support /v1/runs which gives agents autonomous behavior
  // (they can keep working after sending a response, make tool calls, etc.).
  // Non-Hermes gateways (OpenRouter, OpenAI, Ollama) fall back to chat/completions.
  const useHermesRuns = isHermesGateway();

  // ── Tool activity indicators (IPC-driven) ───────────────────────
  // The main process drives the conversation (memory, tools, voice, vision)
  // and emits tool-progress + agent-busy events. We mirror them here so the
  // 🔧 chips and "● thinking" indicator show for EVERY gateway, not just the
  // (currently unused) Runs transport. This is what makes the companion's
  // autonomous actions visible to the human.
  const [toolActivity, setToolActivity] = useState<
    Array<{ id: string; tool: string; label: string; emoji: string; status: "running" | "done" | "error" }>
  >([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const toolClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const cleanupTool = window.symbioAPI?.onToolProgress?.((tc) => {
      setToolActivity((prev) => {
        const idx = prev.findIndex((t) => t.id === tc.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = tc;
          return next;
        }
        // Keep the list short (last 4 actions)
        return [...prev, tc].slice(-4);
      });
    });

    const cleanupBusy = window.symbioAPI?.onAgentBusy?.((busy) => {
      setAgentBusy(busy);
      if (busy) {
        if (toolClearTimerRef.current) clearTimeout(toolClearTimerRef.current);
      } else {
        // When the turn ends, let the final ✓ chips linger briefly, then clear.
        if (toolClearTimerRef.current) clearTimeout(toolClearTimerRef.current);
        toolClearTimerRef.current = setTimeout(() => setToolActivity([]), 2500);
      }
    });

    return () => {
      cleanupTool?.();
      cleanupBusy?.();
      if (toolClearTimerRef.current) clearTimeout(toolClearTimerRef.current);
    };
  }, []);

  // Standard chat transport (for non-Hermes gateways)
  const hermesTransport = useMemo(() => new HermesTransport(), []);

  const { sendMessage: sendChatMessage } = useChat({
    transport: hermesTransport,
    onFinish: async ({ message }) => {
      const text = getMessageText(message);
      console.log(`[Symbio] useChat onFinish: "${text?.substring(0, 80)}..."`);
      if (text) {
        setRecentResponse(text);
        // Update session state — remember what the agent said
        window.symbioAPI?.sessionUpdate?.({ lastAgentMessage: text.substring(0, 200) });
        // Auto-animate: detect *actions* like *dances*, *waves*, etc.
        const animTargets = parseAutoAnimation(text);
        console.log(`[Symbio] parseAutoAnimation (useChat):`, { animTargets, textPreview: text.substring(0, 60) });
        // Queue or play animations independently of speech
        queueOrPlayAnimations(animTargets, "useChat", text);
        // Auto-vision: if the agent wants to see the screen, take a screenshot
        // Guard against infinite loops — don't trigger vision from a vision response
        if (shouldTriggerVision(text) && !visionInProgressRef.current) {
          console.log("[Symbio] Agent wants to see the screen — triggering screenshot");
          visionInProgressRef.current = true;
          window.symbioAPI?.analyzeScreenshot?.();
          // Reset the guard after 10 seconds (enough time for the vision response to come back)
          setTimeout(() => { visionInProgressRef.current = false; }, 10000);
        }
        // Trigger voice for the response
        await getVoiceAudio(text);
      }
    },
  });

  // Hermes Runs transport (for autonomous agent behavior)
  const {
    sendMessage: sendRunsMessage,
    stopRun,
    streamingText: runsStreamingText,
    activeToolCalls,
    isRunning: isAgentRunning,
    currentRunId,
    error: runsError,
    lastResult: runsLastResult,
  } = useRunsChat();

  // When the Runs transport finishes, process the result
  useEffect(() => {
    if (runsLastResult && !isAgentRunning) {
      const text = runsLastResult.text;
      if (text) {
        setRecentResponse(text);
        window.symbioAPI?.sessionUpdate?.({ lastAgentMessage: text.substring(0, 200) });
        const animTargets = parseAutoAnimation(text);
        console.log(`[Symbio] parseAutoAnimation (runs):`, { animTargets, textPreview: text.substring(0, 60) });
        queueOrPlayAnimations(animTargets, "runsTransport", text);
        if (shouldTriggerVision(text) && !visionInProgressRef.current) {
          console.log("[Symbio] Agent wants to see the screen — triggering screenshot");
          visionInProgressRef.current = true;
          window.symbioAPI?.analyzeScreenshot?.();
          setTimeout(() => { visionInProgressRef.current = false; }, 10000);
        }
        getVoiceAudio(text);
      }
    }
  }, [runsLastResult, isAgentRunning]);

  // Show streaming text from Runs transport in real-time
  useEffect(() => {
    if (useHermesRuns && runsStreamingText) {
      setRecentResponse(runsStreamingText);
    }
  }, [useHermesRuns, runsStreamingText]);

  // Log Runs transport errors
  useEffect(() => {
    if (runsError) {
      console.error(`[Symbio] Runs transport error: ${runsError}`);
    }
  }, [runsError]);

  // Unified send function — routes to the appropriate transport
  const sendMessage = useCallback(async (message: string) => {
    if (useHermesRuns) {
      console.log(`[Symbio] Sending via Runs transport (autonomous mode)`);
      await sendRunsMessage(message);
    } else {
      console.log(`[Symbio] Sending via Chat transport (standard mode)`);
      sendChatMessage({ text: message });
    }
  }, [useHermesRuns, sendRunsMessage, sendChatMessage]);

  useEffect(() => {
    // ── Symbio: Session continuity greeting ──────────────────────
    // Instead of a generic "hello" every time, we track when the user
    // was last seen and generate a contextually appropriate greeting.
    // First time ever → warm introduction
    // Quick restart → "still here" nod
    // Back after hours → "I noticed you were gone"
    // Back after days → genuine excitement
    // Tell main process this is a new session (increments count, saves state)
    window.symbioAPI?.sessionMarkNew?.();
    // Get the greeting prompt from main process (it has the session state)
    window.symbioAPI?.sessionGetGreeting?.().then((greetingPrompt) => {
      console.log(`[Symbio] Session greeting: ${greetingPrompt?.substring(0, 80)}...`);
      if (greetingPrompt) {
        window.symbioAPI?.generateText?.(greetingPrompt);
      }
    });

    const cleanupText = window.symbioAPI?.onGeneratedText?.((text: string) => {
      console.log(`[Symbio] onGeneratedText received: "${text.substring(0, 80)}..."`);
      setRecentResponse(text);
      // Update session state — remember what the agent said
      window.symbioAPI?.sessionUpdate?.({ lastAgentMessage: text.substring(0, 200) });
      // Auto-animate: detect *actions* like *dances*, *waves*, etc.
      const animTargets = parseAutoAnimation(text);
      console.log(`[Symbio] parseAutoAnimation result:`, { animTargets, textPreview: text.substring(0, 60) });
        // Queue or play animations independently of speech
        queueOrPlayAnimations(animTargets, "onGeneratedText", text);
      // Auto-vision: if the agent wants to see the screen, take a screenshot
      // Guard against infinite loops — don't trigger vision from a vision response
      if (shouldTriggerVision(text) && !visionInProgressRef.current) {
        console.log("[Symbio] Agent wants to see the screen — triggering screenshot");
        visionInProgressRef.current = true;
        window.symbioAPI?.analyzeScreenshot?.();
        // Reset the guard after 10 seconds (enough time for the vision response to come back)
        setTimeout(() => { visionInProgressRef.current = false; }, 10000);
      }
      // Trigger voice for the response
      getVoiceAudio(text);
    });

    // Streaming partials — update the visible response text ONLY. No TTS, no
    // animation parsing here (those happen once on the final generated-text),
    // so streaming doesn't fire dozens of competing speech calls.
    const cleanupPartial = window.symbioAPI?.onGeneratedTextPartial?.((text: string) => {
      setRecentResponse(text);
    });

    return () => {
      cleanupText?.();
      cleanupPartial?.();
    };
  }, [getVoiceAudio]);

  useEffect(() => {
    const cleanupPrompt = window.symbioAPI?.onPromptSent?.(
      (prompt: string) => {
        // Update session state — remember what the user said
        window.symbioAPI?.sessionUpdate?.({ lastUserMessage: prompt.substring(0, 200) });
        window.symbioAPI?.generateText?.(prompt);
      },
    );

    return () => {
      cleanupPrompt?.();
    };
  }, []);

  // ── Symbio: Receive STT text from main window ──────────────────
  // Mic recording now happens in the main window (which can show permission
  // dialogs on Linux/Wayland). The main process sends transcribed text here.
  useEffect(() => {
    const cleanupStt = window.symbioAPI?.onSttText?.((text: string) => {
      if (text.trim()) {
        console.log(`[Symbio] Overlay: Received STT text: "${text}"`);
        // Update session state — remember what the user said
        window.symbioAPI?.sessionUpdate?.({ lastUserMessage: text.substring(0, 200) });
        window.symbioAPI?.generateText?.(text);
      }
    });
    return () => cleanupStt?.();
  }, []);

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <Scene
        virtualText=""
        voiceUrl={voiceUrl}
        vrmUrl={currentVrmUrl}
        animation={currentAnimation}
        speaking={isSpeaking}
        onSpeakStart={() => setIsLalaSpeaking(true)}
        onSpeakEnd={() => setIsLalaSpeaking(false)}
      />
      {/* Mood indicator — shows current animation state */}
      {currentAnimation?.name && (
        <div style={{
          position: "absolute",
          bottom: 10,
          left: 10,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          gap: 6,
          opacity: 0.6,
          transition: "opacity 0.3s",
        }}>
          <span style={{
            color: "#00e5ff",
            fontSize: 11,
            fontFamily: '"Inter", "Roboto", sans-serif',
            textShadow: "0 0 4px rgba(0,229,255,0.5)",
            letterSpacing: "0.05em",
          }}>
            {currentAnimation.specific
              ? `${currentAnimation.specific.replace(/-/g, " ")}`
              : currentAnimation.name}
          </span>
        </div>
      )}
      {/* Tool call indicator — shows when the companion is using tools.
          Driven by IPC tool-progress events from the main process, so it
          works for every gateway. */}
      {toolActivity.length > 0 && (
        <div style={{
          position: "absolute",
          bottom: 10,
          right: 10,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
          opacity: 0.7,
          transition: "opacity 0.3s",
        }}>
          {toolActivity.map((tc, i) => (
            <span key={tc.id || i} style={{
              color: tc.status === "running" ? "#ffab00" : tc.status === "error" ? "#ff5252" : "#4caf50",
              fontSize: 10,
              fontFamily: '"Inter", "Roboto", sans-serif',
              textShadow: "0 0 4px rgba(0,0,0,0.5)",
              letterSpacing: "0.03em",
            }}>
              {tc.emoji ? `${tc.emoji} ` : "🔧 "}{tc.label}
              {tc.status === "running" ? "..." : tc.status === "error" ? " ✗" : " ✓"}
            </span>
          ))}
        </div>
      )}
      {/* Agent running indicator — shows when the companion is actively
          working. Driven by the agent-busy IPC event (every gateway). */}
      {agentBusy && (
        <div style={{
          position: "absolute",
          top: 10,
          right: 10,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          gap: 6,
          opacity: 0.6,
        }}>
          <span style={{
            color: "#00e5ff",
            fontSize: 10,
            fontFamily: '"Inter", "Roboto", sans-serif',
            textShadow: "0 0 4px rgba(0,229,255,0.5)",
            letterSpacing: "0.05em",
            animation: "pulse 1.5s ease-in-out infinite",
          }}>
            ● thinking
          </span>
        </div>
      )}
    </div>
  );
};

const OverlayLayout = () => {
  // The Overlay component remounts when the agent changes,
  // which reinitializes useChat with the correct transport.
  // Without this key, useChat keeps the old HermesTransport
  // and sends messages to the wrong agent's gateway.
  const [agentKey, setAgentKey] = useState(config.agentName);

  useEffect(() => {
    const cleanup = window.symbioAPI?.onAgentSwitched?.((agent) => {
      setAgentKey(agent.name);
    });
    return () => cleanup?.();
  }, []);

  return <Overlay key={agentKey} />;
};

export default OverlayLayout;
