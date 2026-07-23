import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import dotenv from "dotenv";

import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";

dotenv.config();

const config: ForgeConfig = {
  packagerConfig: {
    // We copy sqlite-vec's loadable extension as `native_modules/vec0.node`
    // (see CopyWebpackPlugin), so AutoUnpackNativesPlugin's `**/*.node`
    // pattern unpacks it from the asar automatically alongside
    // better_sqlite3.node. No custom unpack glob needed.
    asar: true,
    executableName: "symbio-basic",
  },
  // Native modules are processed by the asset-relocator loader (see
  // webpack.rules.ts) and unpacked from the asar by the
  // AutoUnpackNativesPlugin below. We still force a rebuild against Electron's
  // ABI so prebuilt binaries match the bundled Electron runtime.
  rebuildConfig: {
    force: true,
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({}),
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
        prerelease: true,
      },
    },
  ],
};

export default config;
