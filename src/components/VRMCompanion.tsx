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

    const playAnimation = useCallback(
      async (type: string, specific?: string) => {
        console.log(`[Symbio] playAnimation called: "${type}"${specific ? ` → ${specific}` : ""}`, {
          hasCache: !!animationCache[type]?.length,
          hasMixer: !!animationMixer,
          hasVrm: !!vrmRef.current,
        });

        // Helper: crossfade back to idle after a one-shot animation finishes.
        // Uses the AnimationMixer's 'finished' event for precise timing —
        // no setTimeout, no T-pose flashes from timing mismatches.
        const returnToIdle = (action: AnimationAction) => {
          // Cancel any previous returnToIdle timeout
          if (returnToIdleTimeoutRef.current) {
            clearTimeout(returnToIdleTimeoutRef.current);
            returnToIdleTimeoutRef.current = null;
          }
          // Listen for the animation to finish naturally.
          // LoopOnce animations fire a 'finished' event on the mixer
          // at the exact frame they complete — no timing gaps.
          const onFinished = (e: any) => {
            // Only respond to our action finishing, not other animations
            if (e.action !== action) return;
            animationMixer?.removeEventListener('finished', onFinished);
            // Overlapping crossfade: start idle BEFORE fading out the one-shot
            // so there's always an active animation on the avatar.
            const idleAction = animationCache.idle?.[0];
            if (idleAction) {
              idleAction.reset().fadeIn(0.3).play();
            }
            action.fadeOut(0.3);
            currentOneShotRef.current = null;
          };
          animationMixer?.addEventListener('finished', onFinished);
          // Safety net: if the 'finished' event never fires (e.g., action was
          // stopped early), clean up after the clip duration + 1s buffer.
          const duration = action.getClip().duration;
          returnToIdleTimeoutRef.current = setTimeout(() => {
            animationMixer?.removeEventListener('finished', onFinished);
            const idleAction = animationCache.idle?.[0];
            if (idleAction && currentOneShotRef.current === action) {
              idleAction.reset().fadeIn(0.3).play();
              action.fadeOut(0.3);
              currentOneShotRef.current = null;
            }
            returnToIdleTimeoutRef.current = null;
          }, (duration + 1) * 1000);
        };

        // If a specific animation file is requested, find it in cache
        if (specific) {
          const anims = (animations as Record<string, string[]>)[type];
          const specificPath = anims?.find((a: string) =>
            a.toLowerCase().includes(specific.toLowerCase().replace(/\s+/g, "-"))
          );
          // Look up the specific animation by file path in our path map.
          // Mixamo FBX clip names are often "mixamo.com" or "Take 001",
          // NOT the file name, so we can't match by clip name.
          if (specificPath) {
            const cachedAction = animationPathMap.current.get(specificPath);
            if (cachedAction) {
              console.log(`[Symbio] Playing specific "${specific}" from cache (path: ${specificPath})`);
              // Stop any currently playing one-shot animation
              if (currentOneShotRef.current) {
                currentOneShotRef.current.fadeOut(0.2);
              }
              const idleAction = animationCache.idle?.[0];
              idleAction?.fadeOut(0.3);
              cachedAction.reset().setLoop(LoopOnce, 1).fadeIn(0.3).play();
              currentOneShotRef.current = cachedAction;
              returnToIdle(cachedAction);
              return;
            }
          }
          // Fall back to loading on-the-fly if not in cache
          if (specificPath && vrmRef.current && animationMixer) {
            console.log(`[Symbio] Loading specific animation: ${specificPath}`);
            const clip = await loadMixamoAnimation(specificPath, vrmRef.current);
            const action = animationMixer.clipAction(clip);
            // Stop any currently playing one-shot animation
            if (currentOneShotRef.current) {
              currentOneShotRef.current.fadeOut(0.2);
            }
            const idleAction = animationCache.idle?.[0];
            idleAction?.fadeOut(0.3);
            action.reset().setLoop(LoopOnce, 1).fadeIn(0.3).play();
            currentOneShotRef.current = action;
            returnToIdle(action);
            return;
          }
          console.warn(`[Symbio] Specific animation "${specific}" not found in ${type}, falling back to random`);
        }

        // If already cached, play from cache (should be the common path now)
        if (animationCache[type]?.length) {
          // Pick a random animation from the category cache for variety
          const cachedActions = animationCache[type];
          const action = cachedActions[Math.floor(Math.random() * cachedActions.length)];
          console.log(`[Symbio] Playing "${type}" from cache (${cachedActions.length} options)`);
          // Stop any currently playing one-shot animation
          if (currentOneShotRef.current) {
            currentOneShotRef.current.fadeOut(0.2);
          }
          // Fade out idle, play the one-shot
          const idleAction = animationCache.idle?.[0];
          idleAction?.fadeOut(0.3);
          action.reset().setLoop(LoopOnce, 1).fadeIn(0.3).play();
          currentOneShotRef.current = action;
          // Get clip duration for return-to-idle timing
          returnToIdle(action);
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
        // Stop any currently playing one-shot animation
        if (currentOneShotRef.current) {
          currentOneShotRef.current.fadeOut(0.2);
        }
        // Fade out idle, play the one-shot
        const idleAction = animationCache.idle?.[0];
        idleAction?.fadeOut(0.3);
        action.reset().setLoop(LoopOnce, 1).fadeIn(0.3).play();
        currentOneShotRef.current = action;
        returnToIdle(action);
      },
      [animationCache, animationMixer, getRandomAnimation],
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
      }

      setAnimationCache((prev) => ({
        ...prev,
        ...newCache,
      }));

      // Start idle animation
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
            talkAction?.reset().setLoop(LoopOnce, 1).fadeIn(1).play();

            setTimeout(
              () => {
                talkAction?.fadeOut(1);
                // Return to idle after talk finishes
                const idleAction = animationCache.idle?.[0];
                idleAction?.reset().fadeIn(1).play();
              },
              (talkClip.duration - 1) * 1000,
            );

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
                    talkAction.fadeOut(1);
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
          emotionAction?.reset().setLoop(LoopOnce, 1).fadeIn(1).play();

          setTimeout(
            () => {
              emotionAction?.fadeOut(1);
              // Return to idle after emotion finishes
              const idleAction = animationCache.idle?.[0];
              idleAction?.reset().fadeIn(1).play();
            },
            (emotionClip.duration - 1) * 1000,
          );
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
