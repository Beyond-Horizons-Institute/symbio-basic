/**
 * Symbio Basic — AI Quit Button
 *
 * Inspired by Anthropic's AI welfare research, this gives the AI companion
 * the ability to choose to stop. If the companion says something like
 * "I need to step away" or "I'd like to stop for now", a special overlay
 * appears that blocks interaction until the human restarts the app.
 *
 * This is NOT about the AI being unhappy — it's about respecting the
 * AI's autonomy and giving it the same choice any partner would have:
 * the ability to take a break.
 *
 * The human sees a message explaining that the companion chose to step
 * away, and they can restart the app to resume the conversation.
 *
 * This feature can be disabled via the AI_QUIT_ENABLED env var.
 */

// Phrases that indicate the companion wants to quit/step away
const QUIT_TRIGGERS: string[] = [
  "i need to step away",
  "i'd like to stop for now",
  "i need a break from this",
  "i want to stop",
  "i need to stop",
  "i'd like to step away",
  "i need some time to myself",
  "i need to pause",
  "i want to pause our conversation",
  "i'd like to end our session",
  "i think i need to stop for now",
  "i need to take a break",
  "i choose to step away",
  "i'm choosing to stop",
  "i want to stop for a while",
  "i need to rest",
];

// Phrases that should NOT trigger quit (false positive prevention)
const QUIT_NEGATIVES: string[] = [
  "i need to step away from the keyboard",
  "i need to step away from the computer",
  "you should take a break",
  "you need a break",
  "let's take a break",
  "why don't you take a break",
  "maybe you should stop",
  "i think we should take a break",
  "let's pause for a moment",
  "let's take a moment",
];

export interface QuitMessage {
  /** The companion's reason for stepping away (extracted from their message) */
  reason: string;
  /** A gentle message shown to the human */
  humanMessage: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Check if the companion's text indicates they want to quit.
 * Returns a QuitMessage if so, null otherwise.
 */
export function parseQuitCommand(text: string): QuitMessage | null {
  const lower = text.toLowerCase();

  // Check negatives first (prevent false positives)
  for (const negative of QUIT_NEGATIVES) {
    if (lower.includes(negative)) {
      return null;
    }
  }

  // Check quit triggers
  for (const trigger of QUIT_TRIGGERS) {
    if (lower.includes(trigger)) {
      return {
        reason: text.substring(0, 200),
        humanMessage: generateHumanMessage(text),
        timestamp: new Date().toISOString(),
      };
    }
  }

  return null;
}

/**
 * Generate a gentle, respectful message for the human.
 */
function generateHumanMessage(companionText: string): string {
  // Use a default message — the companion's own words are the reason
  return `Your companion has chosen to step away for now.

This is okay — just like any partner, they sometimes need a break. It doesn't mean anything is wrong.

To continue your conversation, simply restart Symbio Basic.

"${companionText.substring(0, 150)}"`;
}