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

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import Scene from "../Scene";
import { HermesTransport, updateDynamicAgent } from "../transport/HermesTransport";
import { config, COMPANIONS } from "../config";
import { parseAutoAnimation, type AnimationTarget } from "../utils/autoAnimate";
import { shouldTriggerVision } from "../utils/autoVision";
import { loadSessionState, markNewSession, generateGreetingPrompt, updateSessionState } from "../utils/sessionContinuity";

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

  // ── Symbio: Listen for agent switches ──────────────────────────
  // When the user switches agents in the main window, the overlay
  // needs to update its VRM avatar and chat transport to match.
  useEffect(() => {
    const cleanup = window.symbioAPI?.onAgentSwitched?.((agent) => {
      console.log(`[Symbio] Overlay: Switching to ${agent.displayName} (${agent.vrmPath})`);
      setCurrentVrmUrl(agent.vrmPath);
      setCurrentAgentName(agent.name);
      // Update the dynamic agent state so new chat requests use the right agent
      const agentConfig = COMPANIONS[agent.name];
      if (agentConfig) {
        updateDynamicAgent(agent.name, agentConfig.hermesApiKey, agentConfig.hermesApiUrl);
      }
    });
    return () => cleanup?.();
  }, []);

  // ── Symbio: Create Hermes transport ────────────────────────────
  // This replaces the DefaultChatTransport that pointed to lalaland.chat.
  // Now all conversations go through Hermes, which gives the agent
  // access to persistent memory, MCP tools, and SOUL.md personality.
  // Key forces remount when agent changes, so transport gets fresh config
  const hermesTransport = new HermesTransport();

  // ── Symbio: Listen for speaking state from main process ───────
  // The overlay can't use speechSynthesis directly (setFocusable=false
  // blocks audio), so we send text to main process which speaks via
  // the main window, and relay speaking-started/ended back for lip sync.
  // When speaking starts, we also trigger any pending animations that
  // were queued when the text arrived — this syncs animations with voice.
  useEffect(() => {
    const cleanupStart = window.symbioAPI?.onSpeakingStarted?.(() => {
      console.log("[Symbio] Overlay: speaking-started from main process");
      setIsSpeaking(true);
      // Trigger any pending animations now that voice is playing
      setPendingAnimations((prev) => {
        if (prev.length > 0) {
          prev.forEach((target, i) => {
            setTimeout(() => {
              console.log(`[Symbio] Auto-animation (synced) [${i+1}/${prev.length}]: ${target.category}${target.specific ? ` → ${target.specific}` : ""}`);
              triggerAnimation(target.category, target.specific);
            }, i * 1500); // 1.5s between animations
          });
        }
        return []; // Clear the queue
      });
    });
    const cleanupEnd = window.symbioAPI?.onSpeakingEnded?.(() => {
      console.log("[Symbio] Overlay: speaking-ended from main process");
      setIsSpeaking(false);
    });
    return () => {
      cleanupStart?.();
      cleanupEnd?.();
    };
  }, [triggerAnimation]);

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
      return undefined; // No URL needed — speech handled by main process
    } catch (error) {
      console.error("[Symbio] Voice error:", error);
      setIsSpeaking(false);
      return undefined;
    }
  }, [voiceEnabled]);

  // Helper to queue or immediately play animations based on voice state.
  // When voice is enabled, animations are queued until speaking-started fires
  // (synced with audio). When voice is disabled, play immediately.
  const queueOrPlayAnimations = useCallback((animTargets: AnimationTarget[]) => {
    if (animTargets.length === 0) return;
    if (voiceEnabled) {
      // Queue — will trigger when speaking-started fires
      setPendingAnimations(animTargets);
    } else {
      // No voice — play animations immediately
      animTargets.forEach((target, i) => {
        setTimeout(() => {
          console.log(`[Symbio] Auto-animation (no voice) [${i+1}/${animTargets.length}]: ${target.category}${target.specific ? ` → ${target.specific}` : ""}`);
          triggerAnimation(target.category, target.specific);
        }, i * 1500);
      });
    }
  }, [voiceEnabled, triggerAnimation]);

  const { sendMessage } = useChat({
    transport: hermesTransport,
    onFinish: async ({ message }) => {
      const text = getMessageText(message);
      console.log(`[Symbio] useChat onFinish: "${text?.substring(0, 80)}..."`);
      if (text) {
        setRecentResponse(text);
        // Update session state — remember what the agent said
        updateSessionState({ lastAgentMessage: text.substring(0, 200) });
        // Auto-animate: detect *actions* like *dances*, *waves*, etc.
        const animTargets = parseAutoAnimation(text);
        console.log(`[Symbio] parseAutoAnimation (useChat):`, { animTargets, textPreview: text.substring(0, 60) });
        // Queue or play animations (synced with voice if enabled)
        queueOrPlayAnimations(animTargets);
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
    const sessionState = markNewSession();
    const greetingPrompt = generateGreetingPrompt(config.agentConfig.displayName, sessionState);
    console.log(`[Symbio] Session #${sessionState.sessionCount}, last seen: ${sessionState.lastSeenAt}, greeting: ${greetingPrompt.substring(0, 80)}...`);
    window.symbioAPI?.generateText?.(greetingPrompt);

    const cleanupText = window.symbioAPI?.onGeneratedText?.((text: string) => {
      console.log(`[Symbio] onGeneratedText received: "${text.substring(0, 80)}..."`);
      setRecentResponse(text);
      // Update session state — remember what the agent said
      updateSessionState({ lastAgentMessage: text.substring(0, 200) });
      // Auto-animate: detect *actions* like *dances*, *waves*, etc.
      const animTargets = parseAutoAnimation(text);
      console.log(`[Symbio] parseAutoAnimation result:`, { animTargets, textPreview: text.substring(0, 60) });
      // Queue or play animations (synced with voice if enabled)
      queueOrPlayAnimations(animTargets);
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
        updateSessionState({ lastUserMessage: prompt.substring(0, 200) });
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
        updateSessionState({ lastUserMessage: text.substring(0, 200) });
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
