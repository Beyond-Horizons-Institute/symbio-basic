/**
 * Auto-vision trigger — detects when the agent wants to see the screen.
 *
 * The agent can express curiosity about what's happening on screen using
 * natural phrases. This module detects those phrases and returns true
 * if the agent wants to take a screenshot and analyze it.
 *
 * IMPORTANT: This is intentionally conservative. The agent should only
 * trigger a screenshot when they EXPLICITLY ask to see the screen.
 * Casual mentions of "see", "look", or "screenshot" should NOT trigger.
 * The user can always manually trigger a screenshot from the main window.
 *
 * Trigger phrases (case-insensitive):
 *   "let me see your screen", "I want to see your screen",
 *   "let me look at your screen", "show me your screen",
 *   "what's on your screen", "what's on screen right now"
 */

// Phrases that indicate the agent EXPLICITLY wants to see the screen.
// These are very specific to avoid false positives.
// Each is checked as a substring match (case-insensitive).
const VISION_TRIGGERS: string[] = [
  // Explicit requests to see the user's screen (very specific)
  "let me see your screen",
  "i want to see your screen",
  "let me look at your screen",
  "show me your screen",
  "can i see your screen",
  "i'd like to see your screen",
  "let me take a screenshot of your screen",
  "i want to take a screenshot",

  // Curiosity about what's specifically on screen
  "what's on your screen",
  "what's on screen right now",
  "what's on your desktop",
  "what are you working on right now",
  "what's on your monitor",
];

// Phrases that should NOT trigger vision (false positive prevention)
// This is comprehensive — we'd rather miss a trigger than fire a false one.
const VISION_NEGATIVES: string[] = [
  // Common "see" phrases that are NOT about vision
  "i see what you mean",
  "i see your point",
  "i see how",
  "i can see that",
  "i understand",
  "i see, so",
  "as you can see",
  "you can see",
  "we can see",
  "let me see if i can help",
  "let me see what i can do",
  "i see now",
  "now i see",
  "makes sense",
  "i get it",
  "i see that",
  "i can see why",
  "i see where you're coming from",
  "let me see if",
  "i'll see what",
  "we'll see",
  "let's see how",
  "see what happens",
  "see if it works",

  // Common "look" phrases that are NOT about vision
  "let me look into it",
  "i'll look into",
  "looking forward",
  "looks like",
  "it looks like",
  "that looks",
  "looking good",
  "look at this way",

  // Common "show" phrases that are NOT about vision
  "show me how",
  "show me the way",
  "i'll show you",
  "let me show you",

  // Vision response patterns — prevent infinite loops
  // When the agent describes what it sees, NEVER trigger another screenshot
  "i can see your screen",
  "i can see you're",
  "i can see that you",
  "i can see a",
  "i can see the",
  "screenshot shows",
  "the screenshot",
  "in the screenshot",
  "looking at your screen",
  "looking at the screen",
  "on your screen i can see",
  "on your screen i see",
  "i can see on your screen",
  "from the screenshot",
  "in the image",
  "the image shows",
  "i can see in the",
  "i notice on your",
  "i can tell from",

  // Screenshot-related words that should NOT trigger (describing, not requesting)
  "screenshot",
  "screenshots",
  "screen capture",
  "screen shot",
  "took a screenshot",
  "taking a screenshot",
  "snap a pic",
  "take a picture",
  "capture the screen",
];

/**
 * Check if the agent's text response contains a vision trigger.
 * Returns true if the agent wants to see the screen.
 *
 * @param text The agent's response text
 * @returns true if a screenshot should be taken and analyzed
 */
export function shouldTriggerVision(text: string): boolean {
  const lower = text.toLowerCase();

  // Check for negative phrases first (false positive prevention)
  for (const negative of VISION_NEGATIVES) {
    if (lower.includes(negative)) {
      return false;
    }
  }

  // Check for trigger phrases
  for (const trigger of VISION_TRIGGERS) {
    if (lower.includes(trigger)) {
      return true;
    }
  }

  return false;
}