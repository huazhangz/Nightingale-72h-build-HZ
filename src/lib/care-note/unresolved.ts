export function isUnresolvedActionText(text: string, label: string | null = null): boolean {
  const haystack = `${label ?? ""} ${text}`.toLowerCase();
  return /todo|follow[- ]?up|unresolved|open action|plan:|unresolved_action/.test(haystack);
}

export function bodyHasOpenPlan(body: string): boolean {
  return body.split("\n").some((line) => /^\s*plan:/i.test(line) || /^\s*todo:/i.test(line));
}

export function entryHasUnresolvedActions(input: {
  body: string;
  comments?: Array<{ body: string }>;
  highlights?: Array<{ excerpt: string; label: string | null }>;
}): boolean {
  if (bodyHasOpenPlan(input.body)) {
    return true;
  }
  for (const comment of input.comments ?? []) {
    if (isUnresolvedActionText(comment.body)) {
      return true;
    }
  }
  for (const highlight of input.highlights ?? []) {
    if (isUnresolvedActionText(highlight.excerpt, highlight.label)) {
      return true;
    }
  }
  return false;
}
