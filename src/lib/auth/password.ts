import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt (memory-hard, built into Node). Stored format:
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 * Parameters travel with the hash, so they can be raised later without invalidating old hashes.
 */

const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 96 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

let dummyHash: Promise<string> | null = null;

/**
 * Verify a password. Unparseable or missing hashes (service accounts, invited users, unknown emails)
 * still cost one scrypt run against a dummy hash, so response time does not reveal which case applied.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = stored?.split("$") ?? [];
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    dummyHash ??= hashPassword("dummy-password-for-timing");
    const [, n, r, p, salt] = (await dummyHash).split("$");
    await scrypt(password, Buffer.from(salt!, "base64url"), Number(n), Number(r), Number(p));
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash!, "base64url");
  const actual = await scrypt(password, Buffer.from(salt!, "base64url"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const COMMON = new Set([
  "password123",
  "password1234",
  "qwerty12345",
  "1234567890",
  "letmein123",
  "welcome123",
  "nightingale1",
  "iloveyou123",
  "admin12345",
]);

export type PasswordIssue = "TOO_SHORT" | "TOO_LONG" | "NEEDS_LETTER" | "NEEDS_DIGIT" | "CONTAINS_EMAIL" | "TOO_COMMON";

/** Length-first policy (NIST SP 800-63B style) plus a letter and a digit, no email reuse, no common passwords. */
export function passwordIssues(password: string, context: { email?: string } = {}): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < 10) issues.push("TOO_SHORT");
  if (password.length > 128) issues.push("TOO_LONG");
  if (!/\p{L}/u.test(password)) issues.push("NEEDS_LETTER");
  if (!/\d/.test(password)) issues.push("NEEDS_DIGIT");
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) issues.push("CONTAINS_EMAIL");
  if (COMMON.has(password.toLowerCase())) issues.push("TOO_COMMON");
  return issues;
}
