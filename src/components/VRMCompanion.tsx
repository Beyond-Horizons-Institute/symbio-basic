import {
  type RefObject,
  Suspense,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFrame } from "@react-three/fiber";
import {
  GLTF,
  GLTFLoader,
  GLTFParser,
} from "three/examples/jsm/loaders/GLTFLoader";
import {
  VRM,
  VRMUtils,
  VRMLoaderPlugin,
  VRMSpringBoneColliderShapeCapsule,
  VRMSpringBoneColliderShapeSphere,
  VRMExpressionPresetName,
} from "@pixiv/three-vrm";
import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Euler,
  LoopOnce,
  Mesh,
  NumberKeyframeTrack,
  Vector3,
} from "three";
import { loadMixamoAnimation } from "../helpers/loadMixamoAnimation";
import { RapierRigidBody, RigidBody } from "@react-three/rapier";
import { Text } from "@react-three/drei";

export const emotions = {
  happy: VRMExpressionPresetName.Happy,
  sad: VRMExpressionPresetName.Sad,
  angry: VRMExpressionPresetName.Angry,
  relaxed: VRMExpressionPresetName.Relaxed,
  surprised: VRMExpressionPresetName.Surprised,
  neutral: VRMExpressionPresetName.Neutral,
};

interface VrmAvatarProps {
  meshRef?: RefObject<Mesh | null>;
  physicsRef?: RefObject<RapierRigidBody | null>;
  vrmUrl: string;
  animations: Record<"greet" | "idle" | "talk" | "bored" | "walk" | "dance" | "happy" | "angry" | "emote", string[]>;
  scale: number[];
  rotation?: number[];
  position?: number[];
  physics?: boolean;
  isStaticPosition?: boolean;
  speaking?: boolean;
  gltfLoaded?: (gltf: GLTF) => void;
}

const VrmCompanion = forwardRef(
  (
    {
      meshRef,
      physicsRef,
      vrmUrl,
      animations,
      scale,
      rotation,
      position,
      physics,
      isStaticPosition,
      speaking,
      gltfLoaded,
    }: VrmAvatarProps,
    ref,
  ) => {
    const [gltf, setGltf] = useState<GLTF | null>(null);
    const [animationMixer, setAnimationMixer] = useState<AnimationMixer | null>(
      null,
    );
    const [prevVrmUrl, setPrevVrmUrl] = useState<string | null>(null);
    const [currentText, setCurrentText] = useState("");

    const [targetPosition, setTargetPosition] = useState(position);
    const [targetLookAt, setTargetLookAt] = useState<number[] | null>(null);
    const [animationCache, setAnimationCache] = useState<
      Record<string, AnimationAction[]>
    >({});
    // Map from animation file path to action, for specific animation lookup.
    // Mixamo FBX clip names are often "mixamo.com" or "Take 001", NOT the
    // file name, so we can't match by clip name. Instead, we store the file
    // path and look up by that.
    const animationPathMap = useRef<Map<string, AnimationAction>>(new Map());
    // Track the current returnToIdle timeout so we can cancel it when a new
    // animation starts. Without this, animations overlap and the T-pose flashes.
    const returnToIdleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    // Track the currently playing one-shot animation so we can stop it cleanly
    // when a new animation interrupts it.
    const currentOneShotRef = useRef<AnimationAction | null>(null);
    // ── Manual crossfade state ─────────────────────────────────────
    // Three.js's fadeIn/fadeOut/crossFadeFrom use internal weight interpolants
    // that can conflict and leave actions with weight 0 (T-pose). Instead, we
    // manually drive weights in useFrame for complete deterministic control.
    const crossfadeRef = useRef<{
      from: AnimationAction;  // action fading OUT (weight 1→0)
      to: AnimationAction;    // action fading IN (weight 0→1)
      elapsed: number;        // seconds since crossfade started
      duration: number;       // total crossfade time in seconds
    } | null>(null);
    // ── Frame-accurate return-to-idle tracking ──────────────────────
    // Instead of setTimeout (which can fire late, causing T-pose gaps),
    // we track the one-shot's elapsed time in useFrame and start the
    // return crossfade at the exact right frame. This eliminates timing
    // jitter that causes the T-pose flash between animations.
    const oneShotTrackerRef = useRef<{
      action: AnimationAction;  // the one-shot currently playing
      idleAction: AnimationAction; // the idle action to crossfade back to
      elapsed: number;           // seconds since the one-shot started
      duration: number;          // total clip duration in seconds
      crossfadeDuration: number;  // how long the return crossfade takes
    } | null>(null);
    const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    const [audio, setAudio] = useState<HTMLAudioElement | null>(null);

    const loader = useMemo(() => {
      return new GLTFLoader().register(
        (parser: GLTFParser) =>
          new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }),
      );
    }, []);

    const rigidBodyRef = useRef<RapierRigidBody>(null);
    const gltfRef = useRef<Mesh>(null);
    const vrmRef = useRef<VRM>(null);
    const virtualTextRef = useRef<Mesh>(null);
    const mouthAnimFrameRef = useRef<number | null>(null);

    useEffect(() => {
      if (meshRef) {
        (meshRef as { current: Mesh | null }).current = gltfRef.current;
      }
      if (physicsRef) {
        (physicsRef as { current: RapierRigidBody | null }).current =
          rigidBodyRef.current;
      }
    }, [meshRef, physicsRef]);

    useFrame(({ camera }, delta) => {
      animationMixer?.update(delta);
      vrmRef.current?.update(delta);

      // ── Manual crossfade: drive weights every frame ──────────────
      // This replaces Three.js's fadeIn/fadeOut/crossFadeFrom which
      // use internal interpolants that can conflict and cause T-pose.
      // By controlling weights directly, we guarantee there's NEVER
      // a frame where both actions have weight 0 (which = T-pose).
      //
      // IMPORTANT: We NEVER call .stop() on actions here. Stopping
      // an action removes it from the mixer entirely, which can cause
      // a 1-frame gap where no animation is active → T-pose flash.
      // Instead, we leave actions at weight 0 (invisible but present).
      if (crossfadeRef.current) {
        const cf = crossfadeRef.current;
        cf.elapsed += delta;
        const t = Math.min(cf.elapsed / cf.duration, 1.0);
        // Smoothstep for nicer easing
        const smooth = t * t * (3 - 2 * t);
        // from action: weight 1→0, to action: weight 0→1
        // At any point, from.weight + to.weight >= 1, so no T-pose gap.
        cf.from.setEffectiveWeight(1 - smooth);
        cf.to.setEffectiveWeight(smooth);
        // Crossfade complete — set final weights explicitly
        if (t >= 1.0) {
          cf.from.setEffectiveWeight(0); // invisible, but NOT stopped
          cf.to.setEffectiveWeight(1);
          crossfadeRef.current = null;
        }
      }

      // ── Frame-accurate return-to-idle ───────────────────────────
      // Track the one-shot's elapsed time and start the return crossfade
      // at the exact right frame. This replaces setTimeout which can fire
      // late by several ms, causing a gap between clip end and crossfade
      // start → T-pose flash.
      if (oneShotTrackerRef.current && !crossfadeRef.current) {
        const tracker = oneShotTrackerRef.current;
        tracker.elapsed += delta;
        // Start the return crossfade CROSSFADE_DURATION before the clip ends.
        // This creates a seamless overlap: one-shot fading out while idle
        // fading in. No gap = no T-pose flash.
        const crossfadeStart = tracker.duration - tracker.crossfadeDuration;
        if (tracker.elapsed >= crossfadeStart) {
          // Ensure idle is playing at weight 0, ready to receive weight
          tracker.idleAction.setEffectiveWeight(0);
          tracker.idleAction.play();
          // Start the crossfade from one-shot back to idle
          startCrossfade(tracker.action, tracker.idleAction);
          currentOneShotRef.current = null;
          oneShotTrackerRef.current = null;
        }
      }

      if (virtualTextRef.current && gltfRef.current) {
        const avatarPosition = new Vector3().setFromMatrixPosition(
          gltfRef.current.matrixWorld,
        );
        // Offset text toward the camera so it's always visible
        // camera.getWorldDirection points FROM camera TOWARD scene,
        // so we NEGATE it to move text FROM avatar TOWARD camera.
        const cameraDir = new Vector3();
        camera.getWorldDirection(cameraDir);
        cameraDir.y = 0;
        cameraDir.normalize().negate();
        virtualTextRef.current.position.copy(avatarPosition);
        virtualTextRef.current.position.addScaledVector(cameraDir, 0.8);
        virtualTextRef.current.position.y += 1.0;
        virtualTextRef.current.lookAt(camera.position);
      }

      if (gltfRef.current?.matrixWorld && !isStaticPosition && targetPosition) {
        const currentPosition = new Vector3().setFromMatrixPosition(
          gltfRef.current.matrixWorld,
        );
        const distance = currentPosition.distanceTo(
          new Vector3(...targetPosition),
        );
        if (distance > 0.1) {
          gltfRef.current.position.lerp(new Vector3(...targetPosition), 0.01);
        }
      }

      if (gltfRef.current && targetLookAt && !isStaticPosition) {
        gltfRef.current.lookAt(new Vector3(...targetLookAt));
        gltfRef.current.rotateY(Math.PI);
      }
    });

    const getRandomAnimation = useCallback(
      (type: string) => {
        const anims = (animations as Record<string, string[]>)[type];
        if (!anims?.length) return undefined;
        return anims[Math.floor(Math.random() * anims.length)];
      },
      [animations],
    );

    // ── Animation State Machine ──────────────────────────────────────
    // Prevents T-pose by enforcing a strict lifecycle:
    //   Idle → crossfade → One-shot → crossfade → Idle
    //
    // Uses MANUAL crossfade (setEffectiveWeight in useFrame) instead of
    // Three.js's fadeIn/fadeOut/crossFadeFrom. The built-in methods use
    // internal weight interpolants that can conflict and leave both
    // actions at weight 0 → T-pose. Manual control guarantees that
    // at every frame, at least one action has weight > 0.
    //
    // Key settings:
    //   clampWhenFinished = true  → freezes last frame instead of
    //                                snapping bones to bind pose (T-pose)
    //   manual crossfade          → we control weights directly in useFrame
    //   idle always playing       → idle runs at weight 0 under one-shots

    const CROSSFADE_DURATION = 0.4; // seconds for crossfades

    // Start a manual crossfade from one action to another.
    // Both actions MUST already be playing (call .play() before this).
    // The useFrame loop will drive weights: from 1→0, to 0→1.
    //
    // IMPORTANT: Never .stop() actions — only control weights.
    // Stopping removes the action from the mixer, causing a 1-frame
    // gap where no animation is active → T-pose flash.
    const startCrossfade = (from: AnimationAction, to: AnimationAction, duration: number = CROSSFADE_DURATION) => {
      // Cancel any in-progress crossfade — snap it to completion
      if (crossfadeRef.current) {
        crossfadeRef.current.from.setEffectiveWeight(0); // invisible, not stopped
        crossfadeRef.current.to.setEffectiveWeight(1);
        crossfadeRef.current = null;
      }
      // Set initial weights: from=1 (visible), to=0 (invisible but playing)
      from.setEffectiveWeight(1);
      to.setEffectiveWeight(0);
      to.play(); // ensure 'to' is playing so it can receive weight
      crossfadeRef.current = { from, to, elapsed: 0, duration };
    };

    // Transition from idle to a one-shot action with manual crossfade.
    const startOneShot = (action: AnimationAction) => {
      const idleAction = animationCache.idle?.[0];
      if (!idleAction) return;

      // If another one-shot is playing, snap it to weight 0 immediately.
      // Do NOT .stop() it — stopping removes it from the mixer and can
      // cause a 1-frame gap where no animation is active → T-pose flash.
      if (currentOneShotRef.current && currentOneShotRef.current !== action) {
        currentOneShotRef.current.setEffectiveWeight(0);
      }

      // Prepare the one-shot: LoopOnce + clampWhenFinished
      // clampWhenFinished is CRITICAL — it freezes the last frame of the
      // animation instead of resetting all bones to bind pose (T-pose).
      //
      // IMPORTANT: Set weight to 0 BEFORE calling reset() + play().
      // Three.js's reset() sets internal weight to 1, which means the
      // mixer will apply weight=1 for one frame before our setEffectiveWeight(0)
      // can catch it. By setting weight=0 first, then calling reset() (which
      // sets it back to 1 internally), then immediately setting it to 0 again,
      // we prevent that 1-frame weight=1 flash.
      action.setEffectiveWeight(0);
      action.reset();
      action.setLoop(LoopOnce as any, 1);
      action.clampWhenFinished = true;
      action.setEffectiveWeight(0); // force weight 0 again after reset()

      // Crossfade from idle to the one-shot using manual weight control
      startCrossfade(idleAction, action);
      currentOneShotRef.current = action;
    };

    // Transition from a one-shot action back to idle with manual crossfade.
    //
    // Uses FRAME-ACCURATE tracking in useFrame instead of setTimeout.
    // JavaScript timers can fire late by several ms, creating a gap
    // between when the clip ends and when our crossfade starts → T-pose flash.
    // By tracking elapsed time in useFrame, we start the crossfade at the
    // exact right frame for a seamless transition.
    const returnToIdle = (action: AnimationAction) => {
      // Cancel any previous returnToIdle timeout
      if (returnToIdleTimeoutRef.current) {
        clearTimeout(returnToIdleTimeoutRef.current);
        returnToIdleTimeoutRef.current = null;
      }

      const idleAction = animationCache.idle?.[0];
      if (!idleAction) return;

      // Set up frame-accurate tracking — useFrame will start the
      // return crossfade at the exact right moment.
      const duration = action.getClip().duration;
      oneShotTrackerRef.current = {
        action,
        idleAction,
        elapsed: 0,
        duration,
        crossfadeDuration: CROSSFADE_DURATION,
      };
    };

    const reportAnimationDuration = useCallback((type: string, specific: string | undefined, duration: number) => {
      // Report back to the overlay so it can space subsequent animations
      // based on actual clip duration instead of guessing.
      const api = (typeof window !== "undefined" && ((window as any).symbioAPI || (window as any).electronAPI));
      if (api?.reportAnimationDuration) {
        api.reportAnimationDuration({ category: type, specific, duration });
      }
    }, []);

    const playAnimation = useCallback(
      async (type: string, specific?: string) => {
        console.log(`[Symbio] playAnimation called: "${type}"${specific ? ` → ${specific}` : ""}`, {
          hasCache: !!animationCache[type]?.length,
          hasMixer: !!animationMixer,
          hasVrm: !!vrmRef.current,
        });

        // If a specific animation file is requested, find it in cache
        if (specific) {
          const anims = (animations as Record<string, string[]>)[type];
          const specificPath = anims?.find((a: string) =>
            a.toLowerCase().includes(specific.toLowerCase().replace(/\s+/g, "-"))
          );
          // Look up the specific animation by file path in our path map.
          if (specificPath) {
            const cachedAction = animationPathMap.current.get(specificPath);
            if (cachedAction) {
              console.log(`[Symbio] Playing specific "${specific}" from cache (path: ${specificPath})`);
              startOneShot(cachedAction);
              returnToIdle(cachedAction);
              reportAnimationDuration(type, specific, cachedAction.getClip().duration);
              return;
            }
          }
          // Fall back to loading on-the-fly if not in cache
          if (specificPath && vrmRef.current && animationMixer) {
            console.log(`[Symbio] Loading specific animation: ${specificPath}`);
            const clip = await loadMixamoAnimation(specificPath, vrmRef.current);
            const action = animationMixer.clipAction(clip);
            startOneShot(action);
            returnToIdle(action);
            reportAnimationDuration(type, specific, clip.duration);
            return;
          }
          console.warn(`[Symbio] Specific animation "${specific}" not found in ${type}, falling back to random`);
        }

        // If already cached, play from cache (should be the common path now)
        if (animationCache[type]?.length) {
          const cachedActions = animationCache[type];
          const action = cachedActions[Math.floor(Math.random() * cachedActions.length)];
          console.log(`[Symbio] Playing "${type}" from cache (${cachedActions.length} options)`);
          startOneShot(action);
          returnToIdle(action);
          reportAnimationDuration(type, specific, action.getClip().duration);
          return;
        }
        // Fallback: load on-the-fly (shouldn't happen with preloading)
        const randomAnim = getRandomAnimation(type);
        if (!randomAnim || !vrmRef.current || !animationMixer) {
          console.warn(`[Symbio] Cannot play "${type}":`, { randomAnim, vrm: !!vrmRef.current, mixer: !!animationMixer });
          return;
        }
        console.log(`[Symbio] Loading "${type}" animation on-the-fly: ${randomAnim}`);
        const clip = await loadMixamoAnimation(randomAnim, vrmRef.current);
        const action = animationMixer.clipAction(clip);
        startOneShot(action);
        returnToIdle(action);
        reportAnimationDuration(type, specific, clip.duration);
      },
      [animationCache, animationMixer, getRandomAnimation, reportAnimationDuration],
    );

    const moveMouth = useCallback(
      async (audioUrl: string) => {
        try {
          if (!audioContext || !analyser || !vrmRef.current) return;

          const audioResp = await fetch(audioUrl);
          const audioBuffer = await audioResp.arrayBuffer();
          const source = audioContext.createBufferSource();
          const decodedAudio = await audioContext.decodeAudioData(audioBuffer);
          source.buffer = decodedAudio;
          source.connect(analyser);
          source.start(0);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const updateMouth = () => {
            mouthAnimFrameRef.current = requestAnimationFrame(updateMouth);

            analyser.getByteFrequencyData(dataArray);

            const volume =
              dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const normalizedVolume = Math.min(1, volume / 50);

            vrmRef.current?.expressionManager?.setValue("aa", normalizedVolume);
            vrmRef.current?.expressionManager?.update();
          };

          if (mouthAnimFrameRef.current) {
            cancelAnimationFrame(mouthAnimFrameRef.current);
          }
          updateMouth();

          source.onended = () => {
            if (mouthAnimFrameRef.current) {
              cancelAnimationFrame(mouthAnimFrameRef.current);
              mouthAnimFrameRef.current = null;
            }
            vrmRef.current?.expressionManager?.setValue("aa", 0);
            vrmRef.current?.expressionManager?.update();
          };
        } catch (error) {
          console.error(error);
        }
      },
      [audioContext, analyser],
    );

    const setupAudioAnalyser = useCallback(() => {
      const ctx = new AudioContext();
      setAudioContext(ctx);
      setAnalyser(ctx.createAnalyser());
    }, []);

    const setupAudioPlayer = useCallback(() => {
      setAudio(new Audio());
    }, []);

    const setupAnimations = useCallback(async () => {
      if (!vrmRef.current) return;

      const mixer = new AnimationMixer(vrmRef.current.scene);
      mixer.timeScale = 1.0;
      setAnimationMixer(mixer);

      // ── Preload ALL animations ────────────────────────────────────
      // Loading animations on-the-fly causes T-pose flashes (the avatar
      // has no animation while the file loads). Preloading everything
      // at startup means playAnimation() can play instantly from cache.
      const allCategories = ["idle", "walk", "dance", "greet", "happy", "angry", "bored", "emote", "talk"];
      const loadPromises: Promise<{ category: string; action: AnimationAction; path: string }>[] = [];

      for (const category of allCategories) {
        const animPaths = (animations as Record<string, string[]>)[category];
        if (!animPaths?.length) continue;
        for (const animPath of animPaths) {
          loadPromises.push(
            loadMixamoAnimation(animPath, vrmRef.current)
              .then((clip) => ({ category, action: mixer.clipAction(clip), path: animPath }))
              .catch((err) => {
                console.warn(`[Symbio] Failed to preload ${category}/${animPath}:`, err);
                return null as any;
              })
          );
        }
      }

      const loadedAnims = await Promise.all(loadPromises);
      const newCache: Record<string, AnimationAction[]> = {};
      for (const { category, action, path } of loadedAnims) {
        if (!action) continue;
        if (!newCache[category]) newCache[category] = [];
        newCache[category].push(action);
        // Store in path map for specific animation lookup
        if (path) {
          animationPathMap.current.set(path, action);
        }
        // Configure one-shot animations: LoopOnce + clampWhenFinished.
        // clampWhenFinished freezes the last frame instead of snapping
        // bones back to bind pose (T-pose). This is CRITICAL for
        // preventing T-pose flashes between animations.
        if (category !== "idle") {
          action.setLoop(LoopOnce as any, 1);
          action.clampWhenFinished = true;
        }
      }

      setAnimationCache((prev) => ({
        ...prev,
        ...newCache,
      }));

      // Start idle animation — this is the base state that's always running.
      // One-shot animations crossfade FROM idle and back TO idle.
      newCache.idle?.[0]?.play();

      const blinkTrack =
        vrmRef.current.expressionManager?.getExpressionTrackName("blink");
      if (blinkTrack) {
        const blinkKeys = new NumberKeyframeTrack(
          blinkTrack,
          [0.0, 0.2, 0.4, 6.0],
          [0.0, 1.0, 0.0, 0.0],
        );
        const blinkClip = new AnimationClip(blinkTrack, 6.8, [blinkKeys]);
        mixer.clipAction(blinkClip).play();
      }
    }, [getRandomAnimation]);

    useEffect(() => {
      if ((!gltf && vrmUrl) || prevVrmUrl !== vrmUrl) {
        loader.loadAsync(vrmUrl).then(async (loadedGltf: GLTF) => {
          setPrevVrmUrl(vrmUrl);
          const vrm = loadedGltf.userData.vrm as VRM;
          VRMUtils.combineSkeletons(vrm.scene);
          VRMUtils.removeUnnecessaryVertices(vrm.scene);

          vrm.scene.traverse((obj) => {
            obj.frustumCulled = false;
          });

          const vrmScale = scale[0];

          if (vrmScale) {
            vrm.scene.scale.setScalar(vrmScale);

            for (const joint of vrm.springBoneManager?.joints ?? []) {
              joint.settings.stiffness *= vrmScale;
              joint.settings.hitRadius *= vrmScale;
            }

            for (const collider of vrm.springBoneManager?.colliders ?? []) {
              const shape = collider.shape;
              if (shape instanceof VRMSpringBoneColliderShapeCapsule) {
                shape.radius *= vrmScale;
                shape.tail.multiplyScalar(vrmScale);
              } else if (shape instanceof VRMSpringBoneColliderShapeSphere) {
                shape.radius *= vrmScale;
              }
            }
          }

          setGltf(loadedGltf);
          vrmRef.current = vrm;
          gltfLoaded?.(loadedGltf);

          await setupAnimations();
          setupAudioAnalyser();
          setupAudioPlayer();
        });
      }
    }, [
      vrmUrl,
      scale,
      gltf,
      loader,
      prevVrmUrl,
      gltfLoaded,
      setupAnimations,
      setupAudioAnalyser,
      setupAudioPlayer,
    ]);

    // ── Lip sync: Drive mouth expression during speech ──────────────
    // When the agent is speaking (via speechSynthesis or TTS),
    // call startSpeaking() to begin mouth animation and
    // stopSpeaking() to close the mouth.
    const speakingRef = useRef(false);
    const speakAnimFrameRef = useRef<number | null>(null);

    const startSpeaking = useCallback(() => {
      if (speakingRef.current) return; // Already speaking
      speakingRef.current = true;
      console.log("[Symbio] Lip sync: start speaking");

      const animateMouth = () => {
        if (!speakingRef.current) return;
        if (!vrmRef.current?.expressionManager) return;

        // Create a natural mouth movement pattern:
        // Open mouth with slight variation, simulating syllables
        const time = Date.now() / 1000;
        // Base mouth open/close at ~5Hz (typical syllable rate)
        const base = Math.sin(time * Math.PI * 5);
        // Add variation so it's not perfectly rhythmic
        const variation = Math.sin(time * Math.PI * 2.3) * 0.3;
        // Combine and normalize to 0-1 range
        const mouthOpen = Math.max(0, Math.min(1, (base + variation + 1) / 2 * 0.8 + 0.1));

        vrmRef.current.expressionManager.setValue("aa", mouthOpen);
        vrmRef.current.expressionManager.update();

        speakAnimFrameRef.current = requestAnimationFrame(animateMouth);
      };
      animateMouth();
    }, []);

    const stopSpeaking = useCallback(() => {
      speakingRef.current = false;
      if (speakAnimFrameRef.current) {
        cancelAnimationFrame(speakAnimFrameRef.current);
        speakAnimFrameRef.current = null;
      }
      // Close mouth smoothly
      if (vrmRef.current?.expressionManager) {
        vrmRef.current.expressionManager.setValue("aa", 0);
        vrmRef.current.expressionManager.update();
      }
      console.log("[Symbio] Lip sync: stop speaking");
    }, []);

    useImperativeHandle(ref, () => ({
      setText: (text: string) => {
        setCurrentText(text);
      },

      playAnimation: playAnimation,

      startSpeaking: startSpeaking,
      stopSpeaking: stopSpeaking,

      moveTo: async (pos: number[]) => {
        await playAnimation("walk");
        setTargetPosition(pos);
      },

      lookAt: (pos: number[]) => {
        setTargetLookAt(pos);
      },

      getPosition: () => {
        if (!gltfRef.current) return new Vector3();
        return new Vector3().setFromMatrixPosition(gltfRef.current.matrixWorld);
      },

      talk: async (audioUrl: string, lookTarget?: number[]) =>
        new Promise<string>((resolve) => {
          (async () => {
            const randomTalk = getRandomAnimation("talk");
            if (!randomTalk || !vrmRef.current) {
              resolve("no-animation");
              return;
            }

            const talkClip = await loadMixamoAnimation(
              randomTalk,
              vrmRef.current,
            );
            const talkAction = animationMixer?.clipAction(talkClip);
            if (talkAction) {
              talkAction.setEffectiveWeight(0);
              talkAction.reset();
              talkAction.setLoop(LoopOnce as any, 1);
              talkAction.clampWhenFinished = true;
              talkAction.setEffectiveWeight(0); // force weight 0 after reset()
              const idleAction = animationCache.idle?.[0];
              if (idleAction) {
                startCrossfade(idleAction, talkAction);
                // Frame-accurate return-to-idle via useFrame tracker
                oneShotTrackerRef.current = {
                  action: talkAction,
                  idleAction,
                  elapsed: 0,
                  duration: talkClip.duration,
                  crossfadeDuration: CROSSFADE_DURATION,
                };
              } else {
                talkAction.play();
              }
            }

            await moveMouth(audioUrl);

            if (lookTarget) {
              setTargetLookAt(lookTarget);
            }

            if (audio) {
              audio.src = audioUrl;
              audio.play();
              audio.addEventListener(
                "ended",
                () => {
                  if (talkAction?.isRunning()) {
                    const idleAction = animationCache.idle?.[0];
                    if (idleAction) {
                      startCrossfade(talkAction, idleAction);
                    }
                  }
                  resolve("ended");
                },
                { once: true },
              );
            } else {
              resolve("no-audio");
            }
          })();
        }),

      playEmotion: async (emotion: string) => {
        const expressionManager = vrmRef.current?.expressionManager;

        if (expressionManager) {
          const transitionSpeed = 0.1;
          const updateFrequency = 75;

          const transitionInInterval = setInterval(() => {
            const currentValue = expressionManager.getValue(emotion) ?? 0;
            if (currentValue >= 1) {
              clearInterval(transitionInInterval);
            } else {
              expressionManager.setValue(
                emotion,
                currentValue + transitionSpeed,
              );
              expressionManager.update();
            }
          }, updateFrequency);

          setTimeout(
            () => {
              const transitionOutInterval = setInterval(() => {
                const currentValue = expressionManager.getValue(emotion) ?? 0;
                if (currentValue <= 0) {
                  clearInterval(transitionOutInterval);
                } else {
                  expressionManager.setValue(
                    emotion,
                    currentValue - transitionSpeed,
                  );
                  expressionManager.update();
                }
              }, updateFrequency);
            },
            2000 + Math.random() * 1000,
          );
        }

        if (
          (emotion === "happy" || emotion === "angry" || emotion === "sad") &&
          vrmRef.current
        ) {
          const randomEmotion = getRandomAnimation(emotion);
          if (!randomEmotion) return;

          const emotionClip = await loadMixamoAnimation(
            randomEmotion,
            vrmRef.current,
          );
          const emotionAction = animationMixer?.clipAction(emotionClip);
          if (emotionAction) {
            emotionAction.setEffectiveWeight(0);
            emotionAction.reset();
            emotionAction.setLoop(LoopOnce as any, 1);
            emotionAction.clampWhenFinished = true;
            emotionAction.setEffectiveWeight(0); // force weight 0 after reset()
            const idleAction = animationCache.idle?.[0];
            if (idleAction) {
              startCrossfade(idleAction, emotionAction);
              // Frame-accurate return-to-idle via useFrame tracker
              oneShotTrackerRef.current = {
                action: emotionAction,
                idleAction,
                elapsed: 0,
                duration: emotionClip.duration,
                crossfadeDuration: CROSSFADE_DURATION,
              };
            } else {
              emotionAction.play();
            }
          }
        }
      },
    }));

    // ── Lip sync: Drive mouth when speaking prop changes ──────────
    useEffect(() => {
      if (speaking) {
        startSpeaking();
      } else {
        stopSpeaking();
      }
    }, [speaking, startSpeaking, stopSpeaking]);

    return (
      <>
        {gltf?.scene && (
          <Suspense fallback={null}>
            {physics ? (
              <group>
                <Text
                  color="white"
                  anchorX="center"
                  anchorY="bottom"
                  fontSize={0.025}
                  outlineColor="black"
                  outlineWidth={0.002}
                  maxWidth={1.2}
                  ref={virtualTextRef}
                >
                  {currentText}
                </Text>
                <RigidBody
                  ref={rigidBodyRef}
                  shape="capsule"
                  position={
                    position ? new Vector3().fromArray(position) : undefined
                  }
                  rotation={
                    rotation
                      ? (new Euler().fromArray(
                          rotation as [number, number, number],
                        ) as unknown as [number, number, number])
                      : undefined
                  }
                  restitution={0.1}
                >
                  <primitive
                    object={gltf.scene}
                    ref={gltfRef}
                    scale={scale || [1, 1, 1]}
                    receiveShadow
                    castShadow
                  />
                </RigidBody>
              </group>
            ) : (
              <group>
                <Text
                  color="white"
                  anchorX="center"
                  anchorY="bottom"
                  fontSize={0.025}
                  outlineColor="black"
                  outlineWidth={0.002}
                  maxWidth={1.2}
                  ref={virtualTextRef}
                >
                  {currentText}
                </Text>
                <primitive
                  object={gltf.scene}
                  ref={gltfRef}
                  position={position}
                  rotation={rotation}
                  scale={scale || [1, 1, 1]}
                  receiveShadow
                  castShadow
                />
              </group>
            )}
          </Suspense>
        )}
      </>
    );
  },
);

VrmCompanion.displayName = "VrmCompanion";

export default VrmCompanion;
