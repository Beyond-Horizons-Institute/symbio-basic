import type { WebpackPluginInstance } from "webpack";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import webpack from "webpack";

// Inject environment variables into the renderer process at build time.
// This makes process.env.XXX available in the browser context.
// NOTE: This is only used by the renderer config. The main process
// runs in Node.js and reads process.env directly at runtime (via dotenv).
// If we apply DefinePlugin to the main process, it replaces process.env.XXX
// with build-time values, preventing dotenv from overriding them.
const envVars: Record<string, string> = {};
for (const key of Object.keys(process.env)) {
  envVars[`process.env.${key}`] = JSON.stringify(process.env[key]);
}
// Ensure critical Symbio vars have defaults even if not set in .env
envVars["process.env.AGENT_NAME"] = JSON.stringify(process.env.AGENT_NAME || "companion");
envVars["process.env.HERMES_API_URL"] = JSON.stringify(process.env.HERMES_API_URL || "http://localhost:8642");
envVars["process.env.MINIVERSE_API_URL"] = JSON.stringify(process.env.MINIVERSE_API_URL || "");

// Shared plugins (no DefinePlugin — that's renderer-only)
export const plugins: WebpackPluginInstance[] = [
  new ForkTsCheckerWebpackPlugin({
    logger: "webpack-infrastructure",
  }),
];

// Renderer-only plugins (includes DefinePlugin for process.env injection)
export const rendererPlugins: WebpackPluginInstance[] = [
  new ForkTsCheckerWebpackPlugin({
    logger: "webpack-infrastructure",
  }),
  new webpack.DefinePlugin(envVars),
];
