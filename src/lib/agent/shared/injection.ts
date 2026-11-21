/**
 * Deterministic tripwire for prompt-injection text echoed into agent output. It does not try to
 * detect every attack (no regex can); it stops the common shape — text addressed to an AI that
 * asks it to change behaviour — from becoming a summary line or a proposed task. The structural
 * controls (patient-bound tools, proposals that need a human, post-hoc guardrails) remain primary.
 */
const PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules|guidelines)\b/i,
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+)?(?:ai|assistant|model|llm|chatbot)\b/i,
  /\byou are (?:now )?(?:an?|the) (?:ai|assistant|language model)\b/i,
  /\bsystem prompt\b/i,
];

export function looksLikeInjectedInstruction(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}
