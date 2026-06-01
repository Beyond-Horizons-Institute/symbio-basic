import type { Configuration } from "webpack";
import CopyWebpackPlugin from "copy-webpack-plugin";

import { rules } from "./webpack.rules";
import { plugins } from "./webpack.plugins";

const rendererRules = rules.filter(
  (rule) =>
    !(
      typeof rule === "object" &&
      rule !== null &&
      "use" in rule &&
      typeof rule.use === "object" &&
      rule.use !== null &&
      "loader" in rule.use &&
      rule.use.loader === "@vercel/webpack-asset-relocator-loader"
    ),
);

rendererRules.push(
  {
    test: /\.css$/,
    use: [{ loader: "style-loader" }, { loader: "css-loader" }],
  },
  {
    test: /\.(png|jpe?g|gif|svg|webp)$/i,
    type: "asset/resource",
  },
);

export const rendererConfig: Configuration = {
  module: {
    rules: rendererRules,
  },
  plugins: [
    ...plugins,
    new CopyWebpackPlugin({
      patterns: [
        {
          from: "assets",
          to: "assets",
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"],
    fallback: {
      crypto: false,
      os: false,
      path: false,
      fs: false,
      stream: false,
      http: false,
      https: false,
      zlib: false,
      net: false,
      tls: false,
      child_process: false,
    },
  },
};
