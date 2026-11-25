/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#0f172a",
    "accent": "#1d4ed8",
    "border": "#dbe2ea",
    "danger": "#b42318",
    "success": "#15803d",
    "surface": "#f8fafc",
    "textMuted": "#475569",
    "accentText": "#ffffff",
    "surfaceAlt": "#eef2f7",
    "borderStrong": "#b6c2d1"
  },
  "shape": {
    "radius": 6
  }
};
