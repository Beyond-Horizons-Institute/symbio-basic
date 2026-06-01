import type { WebpackPluginInstance } from "webpack";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import webpack from "webpack";

// Inject environment variables into the renderer process at build time.
// This makes process.env.XXX available in the browser context.
const envVars: Record<string, string> = {};
for (const key of Object.keys(process.env)) {
  envVars[`process.env.${key}`] = JSON.stringify(process.env[key]);
}
// Ensure critical Symbio vars have defaults even if not set in .env
envVars["process.env.AGENT_NAME"] = JSON.stringify(process.env.AGENT_NAME || "companion");
envVars["process.env.HERMES_API_URL"] = JSON.stringify(process.env.HERMES_API_URL || "http://localhost:8642");
envVars["process.env.MINIVERSE_API_URL"] = JSON.stringify(process.env.MINIVERSE_API_URL || "");

export const plugins: WebpackPluginInstance[] = [
  new ForkTsCheckerWebpackPlugin({
    logger: "webpack-infrastructure",
  }),
  new webpack.DefinePlugin(envVars),
];
