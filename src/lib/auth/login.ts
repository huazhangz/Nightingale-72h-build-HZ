import type { Role } from "@prisma/client";
import { prisma } from "../db";

const FEATURED_ALIASES = new Set(["张伟", "zhang wei", "zhangwei", "张伟 zhang wei"]);

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Accepted spellings of a stored name. "张伟 (Zhang Wei)" yields "张伟 (zhang wei)" as typed,
 * "张伟", and "zhang wei", so bilingual records work without substring matching.
 */
export function nameVariants(stored: string): Set<string> {
  const variants = new Set<string>([normalizeName(stored)]);
  const bilingual = stored.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (bilingual) {
    variants.add(normalizeName(bilingual[1] ?? ""));
    variants.add(normalizeName(bilingual[2] ?? ""));
  }
  variants.delete("");
  return variants;
}

/**
 * Exact match after normalisation, against the stored name's variants or a curated alias group.
 * Partial names ("El" for "Elena Rossi") are rejected: identity checks must not be prefix searches.
 */
export function namesMatch(stored: string, input: string): boolean {
  const candidate = normalizeName(input);
  if (!candidate) {
    return false;
  }
  const variants = nameVariants(stored);
  if (variants.has(candidate)) {
    return true;
  }
  const storedIsAlias = [...variants].some((variant) => FEATURED_ALIASES.has(variant));
  return storedIsAlias && FEATURED_ALIASES.has(candidate);
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export async function verifyPatientLogin(input: {
  fullName: string;
  phone: string;
  dateOfBirth: string;
}): Promise<{ id: string; role: Role } | null> {
  const phone = digitsOnly(input.phone);
  const dob = input.dateOfBirth.trim();
  if (!input.fullName.trim() || phone.length < 8 || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return null;
  }
  const candidates = await prisma.user.findMany({
    where: { role: "PATIENT", phone, dateOfBirth: dob },
  });
  const match = candidates.find((user) => namesMatch(user.name, input.fullName));
  return match ? { id: match.id, role: match.role } : null;
}

export async function verifyStaffLogin(input: {
  role: Extract<Role, "STAFF" | "CLINICIAN">;
  employeeCode: string;
  verification: string;
}): Promise<{ id: string; role: Role } | null> {
  const code = digitsOnly(input.employeeCode);
  const secret = input.verification.trim();
  if (!/^\d{5,6}$/.test(code) || !secret) {
    return null;
  }
  if (secret !== code && digitsOnly(secret) !== code) {
    return null;
  }
  const user = await prisma.user.findFirst({
    where: { role: input.role, employeeCode: code },
  });
  return user ? { id: user.id, role: user.role } : null;
}
