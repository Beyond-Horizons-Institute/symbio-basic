import { VRM } from "@pixiv/three-vrm";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { useRef, useEffect } from "react";
import { Mesh } from "three";

// ── Symbio: Zoom by moving the camera (keeps the WHOLE body framed) ──
// The + / − buttons change `zoom`. Instead of scaling the avatar (which made
// the head clip out the top of the frame), we move the camera closer/farther
// along its line to the target. Bigger zoom = camera closer = avatar bigger,
// but the framing stays correct so head-to-feet remain visible. Eased for a
// smooth glide. BASE_Z is the default full-body distance (matches the
// <Canvas camera> position below).
const BASE_Z = 5.4;
const TARGET_Y = 0.85;
const CameraZoom = ({ zoom }: { zoom: number }) => {
  const { camera } = useThree();
  useFrame(() => {
    const desiredZ = BASE_Z / Math.max(0.0001, zoom);
    camera.position.z += (desiredZ - camera.position.z) * 0.15;
    camera.position.x += (0 - camera.position.x) * 0.15;
    camera.position.y += (TARGET_Y - camera.position.y) * 0.15;
    camera.lookAt(0, TARGET_Y, 0);
    camera.updateProjectionMatrix();
  });
  return null;
};
import { animations } from "./constants/animations";
import VrmCompanion from "./components/VRMCompanion";
import { config } from "./config";

interface SceneProps {
  virtualText: string;
  voiceUrl: string;
  vrmUrl?: string;
  animation?: { name: string; specific?: string; trigger: number };
  speaking?: boolean;
  onSpeakStart?: () => void;
  onSpeakEnd?: () => void;
  /** Camera zoom multiplier: 1 = default, <1 = avatar bigger, >1 = smaller. */
  zoom?: number;
}

const Scene = ({
  virtualText,
  voiceUrl,
  vrmUrl: vrmUrlProp,
  animation,
  speaking,
  onSpeakStart,
  onSpeakEnd,
  zoom = 1,
}: SceneProps) => {
  const vrmRef = useRef<VRM>(null);
  const vrmMeshRef = useRef<Mesh>(null);

  useEffect(() => {
    if (virtualText) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vrmRef as any)?.current?.setText?.(virtualText);
    }
  }, [virtualText]);

  useEffect(() => {
    const speak = async () => {
      if (voiceUrl) {
        onSpeakStart?.();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (vrmRef as any)?.current?.talk?.(voiceUrl);
        onSpeakEnd?.();
      }
    };
    speak();
  }, [voiceUrl, onSpeakStart, onSpeakEnd]);

  // Use the prop if provided, otherwise fall back to config
  const vrmUrl = vrmUrlProp || config.agentConfig.vrmPath;

  // Drive lip sync when speaking state changes
  useEffect(() => {
    const vrm = (vrmRef as any)?.current;
    if (!vrm) return;
    if (speaking) {
      vrm.startSpeaking?.();
    } else {
      vrm.stopSpeaking?.();
    }
  }, [speaking]);

  // Play animation when the prop changes (trigger counter ensures re-triggers)
  useEffect(() => {
    if (animation?.name) {
      console.log(`[Symbio] Scene: playing animation "${animation.name}"${animation.specific ? ` → ${animation.specific}` : ""} (trigger #${animation.trigger})`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vrmRef as any)?.current?.playAnimation?.(animation.name, animation.specific);
    }
  }, [animation?.name, animation?.specific, animation?.trigger]);

  return (
    <Canvas
      gl={{ alpha: true }}
      // ── Symbio: frame the WHOLE avatar on first open ──
      // A standing VRM is ~1.4–1.5 units tall (origin at the feet). We aim
      // the camera at roughly mid-body (y≈0.85) and pull it back far enough
      // that the FULL body — head to feet — fits in the tall (500x800)
      // overlay with a little margin, so opening no longer shows "just feet".
      camera={{ position: [0, 0.85, 5.4], fov: 30 }}
      style={{
        zIndex: 1,
        height: "100vh",
        width: "100%",
        background: "transparent",
      }}
    >
      {/* Drive camera distance from the zoom prop (keeps whole body framed) */}
      <CameraZoom zoom={zoom} />
      <OrbitControls
        makeDefault
        // Aim at the avatar's mid-body so it's vertically centered.
        target={[0, 0.85, 0]}
        // The + / − buttons own the zoom (via CameraZoom), so disable
        // scroll-wheel zoom here to avoid the two fighting over distance.
        // Users can still ROTATE the avatar by dragging.
        enableZoom={false}
        enablePan={false}
        enableDamping
      />
      <ambientLight />
      <pointLight position={[1, 2, 1]} intensity={2.5} castShadow />
      <pointLight position={[-1, 2, 1]} intensity={2.5} castShadow />

      <VrmCompanion
        ref={vrmRef}
        meshRef={vrmMeshRef}
        vrmUrl={vrmUrl}
        animations={animations}
        // Avatar stays at natural scale; the + / − buttons zoom the CAMERA
        // (see CameraZoom above) so the whole body stays framed while it
        // appears bigger/smaller.
        scale={[1, 1, 1]}
        // ── Symbio: keep the avatar's FEET in frame ──
        // Was [0, -1, 0], which dropped the body a full unit below the
        // camera target and cut the feet off the bottom. A VRM's origin sits
        // at the feet, so y=0 places them on the ground plane, in view.
        position={[0, 0, 0]}
        // Face the human on load. VRM avatars were coming up rotated 180°
        // (backwards) because of this initial Y rotation; 0 faces the camera.
        rotation={[0, 0, 0]}
        isStaticPosition
        speaking={speaking}
      />
    </Canvas>
  );
};

export default Scene;
