/**
 * Auto-animate parser — detects action markers in companion text responses
 * and returns matching animation targets.
 *
 * Two levels of specificity:
 *   Category: *dances* → { category: "dance" } → random dance animation
 *   Specific: *taps chin* → { category: "bored", specific: "thinking-taps-chin" } → exact animation
 *
 * The companion's personality can include these action markers in responses,
 * and the avatar will automatically play the matching animation.
 */

export interface AnimationTarget {
  /** Animation category (dance, greet, happy, angry, bored, walk, emote, idle) */
  category: string;
  /** Optional specific animation file (without path/extension) to play instead of random */
  specific?: string;
}

// Maps action phrases to animation targets.
// "specific" means play that exact file; omitting it means random from category.
const ACTION_MAP: Record<string, AnimationTarget> = {
  // ── Dance ──────────────────────────────────────────────────────
  dance: { category: "dance" },
  dancing: { category: "dance" },
  dances: { category: "dance" },
  "does a little dance": { category: "dance" },
  rumba: { category: "dance", specific: "rumba-dance" },
  "does the rumba": { category: "dance", specific: "rumba-dance" },
  "does YMCA": { category: "dance", specific: "ymca" },
  YMCA: { category: "dance", specific: "ymca" },
  "robot dance": { category: "dance", specific: "robot-hip-hop" },
  grooves: { category: "dance" },
  boogie: { category: "dance" },
  shimmy: { category: "dance" },

  // ── Greet ──────────────────────────────────────────────────────
  wave: { category: "greet" },
  waves: { category: "greet" },
  waving: { category: "greet" },
  greet: { category: "greet" },
  greets: { category: "greet" },

  // ── Bored / Thinking ───────────────────────────────────────────
  yawn: { category: "bored", specific: "yawn" },
  yawns: { category: "bored", specific: "yawn" },
  yawning: { category: "bored", specific: "yawn" },
  sighs: { category: "bored" },
  sigh: { category: "bored" },
  stretches: { category: "bored" },
  stretch: { category: "bored" },
  bored: { category: "bored" },
  tired: { category: "bored" },
  sleepy: { category: "bored" },
  thinks: { category: "bored", specific: "thinking-taps-chin" },
  thinking: { category: "bored", specific: "thinking-taps-chin" },
  "taps chin": { category: "bored", specific: "thinking-taps-chin" },
  "pondering": { category: "bored", specific: "thinking-taps-chin" },
  disappointed: { category: "bored", specific: "disappointed" },
  "shakes head": { category: "bored", specific: "no" },

  // ── Walk ───────────────────────────────────────────────────────
  walk: { category: "walk" },
  walks: { category: "walk" },
  walking: { category: "walk" },
  stroll: { category: "walk" },
  strolls: { category: "walk" },
  wandering: { category: "walk" },
  "paces around": { category: "walk" },
  struts: { category: "walk", specific: "strut-walking" },
  "struts around": { category: "walk", specific: "strut-walking" },

  // ── Talk (handled by voice system, included for completeness) ──
  whispers: { category: "talk" },
  mumbles: { category: "talk" },
  mutters: { category: "talk" },

  // ── Happy ──────────────────────────────────────────────────────
  happy: { category: "happy" },
  excited: { category: "happy", specific: "excited" },
  celebrates: { category: "happy" },
  celebrate: { category: "happy" },
  joyful: { category: "happy", specific: "joyful-jump" },
  jumps: { category: "happy", specific: "joyful-jump" },
  "jumps for joy": { category: "happy", specific: "joyful-jump" },
  laughs: { category: "happy", specific: "laughing" },
  laughing: { category: "happy", specific: "laughing" },
  chuckles: { category: "happy", specific: "laughing" },
  chuckle: { category: "happy", specific: "laughing" },
  giggles: { category: "happy", specific: "laughing" },
  snickers: { category: "happy", specific: "laughing" },
  snorts: { category: "happy", specific: "laughing" },
  "blows a kiss": { category: "happy", specific: "blow-a-kiss" },
  "blow a kiss": { category: "happy", specific: "blow-a-kiss" },

  // ── Angry ──────────────────────────────────────────────────────
  angry: { category: "angry" },
  anger: { category: "angry" },
  mad: { category: "angry" },
  furious: { category: "angry" },
  rage: { category: "angry" },
  points: { category: "angry", specific: "angry-point" },
  "points angrily": { category: "angry", specific: "angry-point" },
  glares: { category: "angry" },
  shouts: { category: "angry" },
  yells: { category: "angry" },
  roars: { category: "angry" },

  // ── Emote ──────────────────────────────────────────────────────
  backflip: { category: "emote", specific: "backflip" },
  backflips: { category: "emote", specific: "backflip" },
  plots: { category: "emote", specific: "plotting" },
  plotting: { category: "emote", specific: "plotting" },
  scheming: { category: "emote", specific: "plotting" },
  shrug: { category: "emote" },
  shrugs: { category: "emote" },
  facepalm: { category: "emote" },
  "dramatic pose": { category: "emote", specific: "dramatic-pose" },
  "poses dramatically": { category: "emote", specific: "dramatic-pose" },
  "strikes a pose": { category: "emote", specific: "dramatic-pose" },
  "strikes a dramatic pose": { category: "emote", specific: "dramatic-pose" },
  dismisses: { category: "emote", specific: "dismissing-gesture" },
  "dismissing gesture": { category: "emote", specific: "dismissing-gesture" },
  "waves dismissively": { category: "emote", specific: "dismissing-gesture" },
};

// Match text between asterisks: *dances*, *waves happily*, etc.
const ACTION_REGEX = /\*([^*]+)\*/g;

/**
 * Parse companion response text for action markers and return
 * ALL matching animation targets in order, or empty array if no match.
 *
 * Only matches EXACT action phrases from the ACTION_MAP.
 * This prevents false triggers like *I think we should dance* matching "dance"
 * when the AI didn't intend it as an action.
 *
 * Examples:
 *   "Hey! *waves* How are you?" → [{ category: "greet" }]
 *   "*taps chin* Interesting..." → [{ category: "bored", specific: "thinking-taps-chin" }]
 *   "*waves* Hey! *dances*" → [{ category: "greet" }, { category: "dance" }]
 *   "Just thinking..." → [] (no action markers)
 *   "*I think we should dance*" → [] (not an exact action phrase)
 */
export function parseAutoAnimation(text: string): AnimationTarget[] {
  const matches = text.matchAll(ACTION_REGEX);
  const results: AnimationTarget[] = [];
  const seen = new Set<string>(); // deduplicate same action

  for (const match of matches) {
    const action = match[1].toLowerCase().trim();

    // Only match EXACT action phrases — no substring matching.
    // This prevents false triggers like "I think we should dance"
    // matching "dance" when the AI didn't intend it as an action.
    if (ACTION_MAP[action]) {
      const key = `${ACTION_MAP[action].category}:${ACTION_MAP[action].specific ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(ACTION_MAP[action]);
      }
    }
    // If the exact phrase isn't in the map, skip it.
    // The AI should use specific action markers like *dances* or *waves*.
  }

  return results;
}