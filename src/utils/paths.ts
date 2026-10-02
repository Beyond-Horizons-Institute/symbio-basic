import { app } from "electron";
import { join } from "path";

/**
 * Root of the shipped `assets/` folder (avatars, animations, vrms...).
 *
 * - Dev (`npm start`): <project root>/assets
 * - Packaged: <install dir>/resources/assets  (copied there ONCE via
 *   forge.config.ts `packagerConfig.extraResource`, outside the asar)
 */
export function getAssetsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "assets")
    : join(app.getAppPath(), "assets");
}

/** Folder that `symbio://` URLs resolve against (the parent of assets/). */
export function getSymbioProtocolRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}
