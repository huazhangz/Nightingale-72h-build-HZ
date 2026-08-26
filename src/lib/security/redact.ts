export const REDACTED = "[REDACTED]";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
/** Singapore NRIC (S/T) and FIN (F/G/M), e.g. S1234567A, T1234567B. */
const NRIC_FIN_PATTERN = /\b[STFGM]\d{7}[A-Z]\b/gi;
/** +65 91234567, +65-9123-4567, +6591234567 */
const SG_INTL_PHONE_PATTERN = /\+65[\s-]?\d{4}[\s-]?\d{4}/g;
/** Local 8-digit numbers: mobile 8/9, landline 6, e.g. 81234567 */
const SG_LOCAL_PHONE_PATTERN = /\b[689]\d{7}\b/g;
const HONORIFIC_NAME_PATTERN =
  /\b(?:Dr|Mr|Mrs|Ms|Mdm|Prof)\.?\s+[A-Z][a-z]+(?:\s+(?:bin|binti|de|van|von)\s+[A-Z][a-z]+|\s+[A-Z][a-z]+){0,3}\b/g;
const PROPER_NAME_PATTERN =
  /\b[A-Z][a-z]{1,20}(?:\s+(?:bin|binti|de|van|von)\s+[A-Z][a-z]{1,20}|\s+[A-Z][a-z]{1,20}){1,3}\b/g;

const NAME_ALLOWLIST = new Set([
  "Patient Summary",
  "Consult Summary",
  "Doctor Consult",
  "Nurse Consult",
  "Care Plan",
  "Follow Up",
]);

function replaceAll(source: string, pattern: RegExp, replacer?: (match: string) => string): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  return source.replace(global, (match) => (replacer ? replacer(match) : REDACTED));
}

function redactNames(text: string): string {
  let next = replaceAll(text, HONORIFIC_NAME_PATTERN);
  next = replaceAll(next, PROPER_NAME_PATTERN, (match) =>
    NAME_ALLOWLIST.has(match) ? match : REDACTED,
  );
  return next;
}

/** Deterministic PHI strip for storage / LLM payloads. Same input always yields the same output. */
export function redactPhi(text: string): string {
  if (!text) {
    return text;
  }

  let redacted = replaceAll(text, EMAIL_PATTERN);
  redacted = replaceAll(redacted, NRIC_FIN_PATTERN);
  redacted = replaceAll(redacted, SG_INTL_PHONE_PATTERN);
  redacted = replaceAll(redacted, SG_LOCAL_PHONE_PATTERN);
  redacted = redactNames(redacted);
  return redacted;
}
