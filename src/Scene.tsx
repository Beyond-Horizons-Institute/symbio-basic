import { VRM } from "@pixiv/three-vrm";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { useRef, useEffect } from "react";
import { Group, Mesh } from "three";

// ── Symbio: Zoom by moving the camera (keeps the WHOLE body framed) ──
// The + / − buttons change `zoom`. Instead of scaling the avatar (which made
// the head clip out the top of the frame), we move the camera closer/farther
// along its line to the target. Bigger zoom = camera closer = avatar bigger,
// but the framing stays correct so head-to-feet remain visible. Eased for a
// smooth glide. BASE_Z is the default full-body distance (matches the
// <Canvas camera> position below).
//
// IMPORTANT — do NOT fight OrbitControls here. An earlier version snapped
// `camera.position.x` back to 0 and re-ran `camera.lookAt(...)` on EVERY
// frame. That overrode OrbitControls' drag-to-rotate every frame, so the
// avatar looked "stuck facing you" — you could never turn it. Now this only
// nudges the camera's *distance* from the target (the zoom), preserving
// whatever azimuth/elevation OrbitControls has set. Rotation is free again.
const BASE_Z = 5.4;
const TARGET_Y = 0.85;
const CameraZoom = ({ zoom }: { zoom: number }) => {
  const { camera, controls } = useThree();
  useFrame(() => {
    // Orbit target (mid-body). Falls back to a fixed point if controls
    // aren't ready yet on the very first frames.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = (controls as any)?.target ?? { x: 0, y: TARGET_Y, z: 0 };
    // Current distance from the target, and the distance we WANT for this zoom.
    const dx = camera.position.x - target.x;
    const dy = camera.position.y - target.y;
    const dz = camera.position.z - target.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
    const desiredDist = BASE_Z / Math.max(0.0001, zoom);
    // Ease the distance toward the desired one WITHOUT changing direction,
    // so the current rotation (azimuth/elevation) is untouched.
    const newDist = dist + (desiredDist - dist) * 0.15;
    const scale = newDist / dist;
    camera.position.x = target.x + dx * scale;
    camera.position.y = target.y + dy * scale;
    camera.position.z = target.z + dz * scale;
    camera.updateProjectionMatrix();
  });
  return null;
};
import { animations } from "./constants/animations";
import VrmCompanion from "./components/VRMCompanion";
import { config } from "./config";

// ── Symbio: Turn the avatar to face away / sideways ──────────────────
// The ↻ button in the overlay cycles a target Y-rotation (in radians). We
// spin a wrapper <group> around the avatar (NOT the camera) toward that
// target, eased for a smooth turn. This is independent of OrbitControls, so
// the human can BOTH drag-rotate the camera AND click ↻ to spin the avatar.
const SpinRig = ({
  rotationY,
  children,
}: {
  rotationY: number;
  children: React.ReactNode;
}) => {
  const groupRef = useRef<Group>(null);
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    // Ease current rotation toward the target for a smooth turn.
    g.rotation.y += (rotationY - g.rotation.y) * 0.18;
  });
  return <group ref={groupRef}>{children}</group>;
};

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
  /** Target avatar Y-rotation in radians (0 = facing you). Eased in SpinRig. */
  rotationY?: number;
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
  rotationY = 0,
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

      {/* SpinRig turns the avatar to face away / sideways when the human
          clicks the ↻ button (rotationY). Camera drag-rotate still works too. */}
      <SpinRig rotationY={rotationY}>
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
      </SpinRig>
    </Canvas>
  );
};

export default Scene;
