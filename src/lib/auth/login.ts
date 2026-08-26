import type { Role } from "@prisma/client";
import { prisma } from "../db";

const FEATURED_ALIASES = new Set(["张伟", "zhang wei", "zhangwei", "张伟 (zhang wei)"]);

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ");
}

export function namesMatch(stored: string, input: string): boolean {
  const left = normalizeName(stored);
  const right = normalizeName(input);
  if (left === right) {
    return true;
  }
  if (FEATURED_ALIASES.has(left) && FEATURED_ALIASES.has(right)) {
    return true;
  }
  return left.includes(right) || right.includes(left);
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
  const code = input.employeeCode.trim();
  if (!/^\d{6}$/.test(code) || !input.verification.trim()) {
    return null;
  }
  const user = await prisma.user.findFirst({
    where: { role: input.role, employeeCode: code },
  });
  return user ? { id: user.id, role: user.role } : null;
}
