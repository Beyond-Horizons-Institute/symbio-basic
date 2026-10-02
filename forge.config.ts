import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerAppImage } from "@reforged/maker-appimage";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import dotenv from "dotenv";
import { join } from "path";

import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";

dotenv.config();

// Base path for platform icons (extension is added per-platform by the tools).
//   Windows  -> assets/icons/icon.ico
//   macOS    -> assets/icons/icon.icns
//   Linux    -> assets/icons/icon.png
const ICON_BASE = join(__dirname, "assets", "icons", "icon");

const config: ForgeConfig = {
  // Optional local override (e.g. FORGE_OUT_DIR=out2) if `out/` is locked.
  ...(process.env.FORGE_OUT_DIR ? { outDir: process.env.FORGE_OUT_DIR } : {}),
  packagerConfig: {
    // We copy sqlite-vec's loadable extension as `native_modules/vec0.node`
    // (see CopyWebpackPlugin), so AutoUnpackNativesPlugin's `**/*.node`
    // pattern unpacks it from the asar automatically alongside
    // better_sqlite3.node. No custom unpack glob needed.
    asar: true,
    executableName: "symbio-basic",
    // electron-packager auto-appends the right extension per platform.
    icon: ICON_BASE,
    // Ship the big assets folder (avatars ~670 MB) ONCE, outside the asar, at
    // <resources>/assets. Main-process code reads it via getAssetsRoot().
    // Previously webpack copied assets into BOTH .webpack/main and
    // .webpack/renderer (2x size, >1 GB), which broke the Squirrel Setup.exe
    // (it silently produced a 650 KB stub) and the app couldn't find them.
    // AGENT.md / SKILL.md are read at runtime by symbioDocs.ts.
    extraResource: ["assets", "AGENT.md", "SKILL.md"],
  },
  // Native modules are processed by the asset-relocator loader (see
  // webpack.rules.ts) and unpacked from the asar by the
  // AutoUnpackNativesPlugin below. We still force a rebuild against Electron's
  // ABI so prebuilt binaries match the bundled Electron runtime.
  rebuildConfig: {
    force: true,
  },
  makers: [
    // Windows — Setup.exe installer (also enables auto-update).
    new MakerSquirrel({
      setupIcon: `${ICON_BASE}.ico`,
      // The taskbar/window icon used inside the installed app.
      iconUrl: "https://raw.githubusercontent.com/Beyond-Horizons-Institute/symbio-basic/main/assets/icons/icon.ico",
    }),
    // macOS — .zip (fallback) + .dmg (the expected Mac experience).
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ icon: `${ICON_BASE}.icns` }, ["darwin"]),
    // Linux — .deb (Debian/Ubuntu), .rpm (Fedora/RHEL), and AppImage
    // (universal, truly "download and double-click", no install).
    new MakerDeb({
      options: {
        icon: `${ICON_BASE}.png`,
        categories: ["Utility", "Education"],
      },
    }),
    new MakerRpm({
      options: {
        icon: `${ICON_BASE}.png`,
        categories: ["Utility", "Education"],
      },
    }),
    new MakerAppImage({
      options: {
        icon: `${ICON_BASE}.png`,
        categories: ["Utility", "Education"],
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: "./src/index.html",
            js: "./src/renderer.tsx",
            name: "main_window",
            preload: {
              js: "./src/preload.ts",
            },
          },
          {
            html: "./src/overlay/index.html",
            js: "./src/overlay/renderer.tsx",
            name: "overlay_window",
            preload: {
              js: "./src/preload.ts",
            },
          },
        ],
      },
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "Beyond-Horizons-Institute",
          name: "symbio-basic",
        },
        // The CI workflow (.github/workflows/publish.yml) creates the draft
        // release first, so this publisher only ATTACHES the built installers
        // to it. We keep it a draft (not a prerelease) so that, once you click
        // "Publish" on GitHub, it becomes the clean "Latest release".
        draft: true,
        prerelease: false,
        // Always overwrite an existing asset of the same name. Without this,
        // re-running a build for a tag that already has assets would SKIP the
        // upload and leave STALE binaries attached. force:true guarantees the
        // release always holds the freshest build.
        force: true,
      },
    },
  ],
};

export default config;
