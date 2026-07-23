import type { Configuration } from "webpack";
import CopyWebpackPlugin from "copy-webpack-plugin";

import { rules } from "./webpack.rules";
import { plugins } from "./webpack.plugins";

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: "./src/main.ts",
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".json"],
  },
  // Native modules (better-sqlite3, sqlite-vec, pg) are handled by the
  // @vercel/webpack-asset-relocator-loader configured in webpack.rules.ts.
  // It copies their prebuilt `.node`/`.so` binaries into a `native_modules/`
  // folder, and @electron-forge/plugin-auto-unpack-natives unpacks them from
  // the asar at package time so they can be dlopen'd at runtime. We therefore
  // do NOT mark them as webpack `externals` — that would bypass the relocator
  // and the binaries would never be copied (they'd be missing at runtime).
  //
  // `pg-native` is an optional peer dep of `pg` that we don't use; ignore it
  // so webpack doesn't error on the optional require.
  externals: {
    "pg-native": "commonjs pg-native",
  },
};

// Add CopyWebpackPlugin to copy the assets folder to the output directory
plugins.push(
  new CopyWebpackPlugin({
    patterns: [
      {
        from: "assets", // source folder in project root
        to: "assets", // destination folder in output directory
        noErrorOnMissing: true,
      },
      // sqlite-vec ships its loadable extension (vec0.so/.dylib/.dll) in a
      // platform-specific package and resolves it via require.resolve at
      // runtime — which webpack can't trace and which can't be read from
      // inside an asar. So we copy the binary next to the main bundle.
      //
      // We copy it with a `.node` extension on purpose: AutoUnpackNativesPlugin
      // unpacks everything matching `**/*.node` from the asar, so naming it
      // `vec0.node` gets it automatically unpacked (a plain `.so` would stay
      // trapped inside the asar where loadExtension can't read it). Electron's
      // db.loadExtension() dlopen's by path and doesn't care about the suffix.
      {
        from: "node_modules/sqlite-vec-*/vec0.*",
        to: "native_modules/vec0.node",
        noErrorOnMissing: true,
      },
    ],
  }),
);
