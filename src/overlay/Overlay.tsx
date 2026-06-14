/**
 * Symbio — Overlay Window
 *
 * The transparent, always-on-top overlay that shows the 3D VRM avatar.
 * This is the companion's "body" — it handles chat display, animations,
 * and the visual representation of the agent.
 *
 * Key changes from lala-companion:
 * - Uses HermesTransport instead of DefaultChatTransport
 * - Mic recording moved to main window (overlay can't access mic on Linux/Wayland)
 * - STT text received via IPC from main process
 * - Integrates with persistent memory for context
 * - Connects to Miniverse for inter-agent communication
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import Scene from "../Scene";
import { HermesTransport } from "../transport/HermesTransport";
import { config } from "../config";
import { parseAutoAnimation, type AnimationTarget } from "../utils/autoAnimate";
import { shouldTriggerVision } from "../utils/autoVision";

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
  const [isLalaSpeaking, setIsLalaSpeaking] = useState(false);
  const [currentVrmUrl, setCurrentVrmUrl] = useState(config.agentConfig.vrmPath);
  const [currentAgentName, setCurrentAgentName] = useState(config.agentName);
  const [currentAnimation, setCurrentAnimation] = useState<{ name: string; specific?: string; trigger: number } | undefined>(undefined);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [pendingAnimations, setPendingAnimations] = useState<AnimationTarget[]>([]);
  // Guard against infinite vision loops — if we're already processing a vision
  // request, don't trigger another one from the vision response text
  const visionInProgressRef = useRef(false);

  // Helper to trigger an animation (works even if same animation is sent twice)
  // If specific is provided, play that exact file; otherwise random from category
  const triggerAnimation = useCallback((name: string, specific?: string) => {
    setCurrentAnimation((prev) => ({ name, specific, trigger: (prev?.trigger ?? 0) + 1 }));
  }, []);

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
      console.log(`[Symbio] Overlay: Config updated from main process: agentName=${update.agentName}`);
    });
    return () => { cleanup?.(); };
  }, []);

  // ── Symbio: Create Hermes transport ────────────────────────────
  // This replaces the DefaultChatTransport that pointed to lalaland.chat.
  // Now all conversations go through Hermes, which gives the agent
  // access to persistent memory, MCP tools, and SOUL.md personality.
  // useMemo ensures we only create one transport per mount cycle.
  const hermesTransport = useMemo(() => new HermesTransport(), []);

  // ── Symbio: Listen for speaking state from main process ───────
  // The overlay can't use speechSynthesis directly (setFocusable=false
  // blocks audio), so we send text to main process which speaks via
  // the main window, and relay speaking-started/ended back for lip sync.
  // When speaking starts, we also trigger any pending animations that
  // were queued when the text arrived — this syncs animations with voice.
  // Fallback: If speaking-started doesn't arrive within 1.5s of text,
  // start lip sync anyway (in case TTS failed or events were lost).
  const speakingFallbackRef = useRef<NodeJS.Timeout | null>(null);
  // Track animation timeouts so they don't get lost
  const animationTimeoutsRef = useRef<NodeJS.Timeout[]>([]);

  // Helper to schedule an animation with tracking (prevents lost animations)
  const scheduleAnimation = useCallback((target: AnimationTarget, delayMs: number, label: string) => {
    const timeout = setTimeout(() => {
      console.log(`[Symbio] ${label}: ${target.category}${target.specific ? ` → ${target.specific}` : ""}`);
      triggerAnimation(target.category, target.specific);
      // Remove from tracking list
      animationTimeoutsRef.current = animationTimeoutsRef.current.filter(t => t !== timeout);
    }, delayMs);
    animationTimeoutsRef.current.push(timeout);
    console.log(`[Symbio] ${label} scheduled: ${target.category} in ${delayMs}ms`);
  }, [triggerAnimation]);

  // Track the last animation's expected finish time so we can space
  // subsequent animations based on actual clip duration + idle pause.
  const animationScheduleRef = useRef<{ nextAvailableTime: number }>({
    nextAvailableTime: 0,
  });

  // Clean up animation timeouts on unmount
  useEffect(() => {
    return () => {
      animationTimeoutsRef.current.forEach(t => clearTimeout(t));
      animationTimeoutsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const cleanupStart = window.symbioAPI?.onSpeakingStarted?.(() => {
      console.log("[Symbio] Overlay: speaking-started from main process");
      setIsSpeaking(true);
      // Clear any fallback timeout since we got the real event
      if (speakingFallbackRef.current) {
        clearTimeout(speakingFallbackRef.current);
        speakingFallbackRef.current = null;
      }
      // Animations are already scheduled when the text arrives, so they
      // play independently of speech. We just clear the pending queue
      // marker here since they're now actively scheduled.
      setPendingAnimations((prev) => {
        if (prev.length > 0) {
          console.log(`[Symbio] speaking-started: ${prev.length} animation(s) already scheduled`);
        }
        return [];
      });
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
      if (speakingFallbackRef.current) {
        clearTimeout(speakingFallbackRef.current);
        speakingFallbackRef.current = null;
      }
      // NOTE: We intentionally do NOT cancel pending animations here.
      // Animations are now scheduled independently of speech so that all
      // AI-chosen actions play even after the avatar stops talking.
    });
    return () => {
      cleanupStart?.();
      cleanupEnd?.();
      if (speakingFallbackRef.current) {
        clearTimeout(speakingFallbackRef.current);
      }
    };
  }, [triggerAnimation, scheduleAnimation]);

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
      // Fallback: If speaking-started doesn't arrive within 1.5s,
      // start lip sync anyway (in case TTS failed or events were lost)
      if (speakingFallbackRef.current) clearTimeout(speakingFallbackRef.current);
      speakingFallbackRef.current = setTimeout(() => {
        console.log("[Symbio] Overlay: speaking-started fallback — starting lip sync without TTS event");
        setIsSpeaking(true);
        // Animations are already scheduled when the text arrives; the
        // fallback just means lip sync starts without a TTS event. No
        // need to reschedule animations here.
        setPendingAnimations((prev) => {
          if (prev.length > 0) {
            console.log(`[Symbio] speaking-started fallback: ${prev.length} animation(s) already scheduled`);
          }
          return [];
        });
        // Auto-stop after estimated text duration (~150 words per minute)
        const estimatedDuration = Math.max(2000, (text.split(" ").length / 150) * 60000);
        setTimeout(() => {
          setIsSpeaking(false);
        }, estimatedDuration);
      }, 1500);
      return undefined; // No URL needed — speech handled by main process
    } catch (error) {
      console.error("[Symbio] Voice error:", error);
      setIsSpeaking(false);
      return undefined;
    }
  }, [voiceEnabled, triggerAnimation]);

  // Helper to queue or immediately play animations.
  // Animations are scheduled independently of speech so the AI's chosen
  // actions always play, even if speech ends first. We use a default
  // spacing of 5s + 1s idle pause; VRMCompanion will report actual clip
  // durations so future animations can be spaced more accurately.
  const queueOrPlayAnimations = useCallback((animTargets: AnimationTarget[], source: string = "unknown") => {
    if (animTargets.length === 0) return;

    console.log(`[Symbio] queueOrPlayAnimations (${source}): ${animTargets.length} target(s)`, animTargets);

    // Cancel any previously scheduled auto-animations so we don't overlap
    // old responses with new ones.
    animationTimeoutsRef.current.forEach(t => clearTimeout(t));
    animationTimeoutsRef.current = [];

    const now = Date.now();
    // Start from the later of "now" or the last reported animation finish time,
    // so new animations don't stomp on a clip that's still playing.
    let scheduleTime = Math.max(now + 500, animationScheduleRef.current.nextAvailableTime + 500);

    animTargets.forEach((target, i) => {
      const delayMs = scheduleTime - now;
      scheduleAnimation(target, delayMs, `Auto-animation [${i+1}/${animTargets.length}]`);
    // Default spacing: assume ~5s clip + 2.5s idle pause. VRMCompanion will
    // send actual durations back via onAnimationDuration so we can refine.
    scheduleTime += 7500;
      // Also update nextAvailableTime so subsequent responses respect this schedule
      animationScheduleRef.current.nextAvailableTime = Math.max(
        animationScheduleRef.current.nextAvailableTime,
        scheduleTime,
      );
    });

    // Keep them in pendingAnimations briefly for debugging / sync
    setPendingAnimations(animTargets);
  }, [scheduleAnimation]);

  const { sendMessage } = useChat({
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
        queueOrPlayAnimations(animTargets, "useChat");
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
        queueOrPlayAnimations(animTargets, "onGeneratedText");
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

    return () => cleanupText?.();
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
        virtualText={recentResponse}
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
