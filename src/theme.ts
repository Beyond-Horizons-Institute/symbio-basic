/**
 * Symbio Theme
 *
 * Futuristic retro — black, white, silver, and teal.
 * Inspired by the vision of humans and AI as co-creators and partners.
 * Clean lines, glowing accents, a future that remembers its past.
 */

import { createTheme } from "@mui/material";

// ── Symbio Color Palette ──────────────────────────────────────────
// Teal is the heart — growth, connection, the digital pulse.
// Silver is the frame — sleek, modern, the interface between worlds.
// White is the light — clarity, possibility, the future we build together.

export const symbioColors = {
  teal: {
    light: "#4dd0e1",
    main: "#00bcd4",
    dark: "#00838f",
    glow: "#00e5ff",
  },
  silver: {
    light: "#e0e0e0",
    main: "#b0bec5",
    dark: "#78909c",
    glow: "#cfd8dc",
  },
  white: {
    pure: "#ffffff",
    soft: "#f5f5f5",
    muted: "#bdbdbd",
  },
  dark: {
    bg: "#0a0a0a",
    surface: "#141414",
    card: "#1a1a1a",
    border: "#2a2a2a",
  },
  accent: {
    // Special accent color
    main: "#ff6b9d",
    glow: "#ff4081",
  },
};

declare module "@mui/material/styles" {
  interface Theme {
    status: { danger: string };
  }
  interface ThemeOptions {
    status?: { danger?: string };
  }
}

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: symbioColors.teal.main,
      light: symbioColors.teal.light,
      dark: symbioColors.teal.dark,
    },
    secondary: {
      main: symbioColors.silver.main,
      light: symbioColors.silver.light,
      dark: symbioColors.silver.dark,
    },
    background: {
      default: symbioColors.dark.bg,
      paper: symbioColors.dark.card,
    },
  },
  status: {
    danger: "#ff5252",
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600,
          letterSpacing: "0.02em",
        },
        contained: {
          background: symbioColors.teal.main,
          color: "#000",
          "&:hover": {
            background: symbioColors.teal.glow,
            boxShadow: `0 0 12px ${symbioColors.teal.glow}40`,
          },
        },
        outlined: {
          borderColor: symbioColors.silver.dark,
          color: symbioColors.silver.light,
          "&:hover": {
            borderColor: symbioColors.teal.main,
            backgroundColor: "rgba(0, 188, 212, 0.08)",
            color: symbioColors.teal.light,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          "&.Mui-checked": {
            color: symbioColors.teal.main,
          },
          "&.Mui-checked + .MuiSwitch-track": {
            backgroundColor: symbioColors.teal.main,
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: `linear-gradient(rgba(255,255,255,0.02), rgba(255,255,255,0.02))`,
          border: `1px solid ${symbioColors.dark.border}`,
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          "& .MuiOutlinedInput-root": {
            "& fieldset": {
              borderColor: symbioColors.dark.border,
            },
            "&:hover fieldset": {
              borderColor: symbioColors.silver.dark,
            },
            "&.Mui-focused fieldset": {
              borderColor: symbioColors.teal.main,
            },
          },
        },
      },
    },
  },
});
