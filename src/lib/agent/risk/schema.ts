import { z } from "zod";
import type { VerifiedCitation } from "../shared/citations";
import type { FloorReason } from "./floor";
import { REVIEW_WINDOWS, RISK_LEVELS, type ReviewWindow, type RiskLevel } from "./levels";

export const CONFIDENCE = ["low", "medium", "high"] as const;

export const RiskDriverInput = z.object({
  factor: z.string().min(1).max(200).describe("One clinical factor in plain language"),
  direction: z.enum(["raises", "lowers"]).describe("Whether this factor raises or lowers current risk"),
  citations: z
    .array(
      z.object({
        note_id: z.string().min(1),
        quote: z.string().min(1).max(400).describe("Exact words copied from that note"),
      }),
    )
    .min(1)
    .max(3),
});

export const RiskSubmission = z.object({
  level: z.enum(RISK_LEVELS),
  review: z.enum(REVIEW_WINDOWS),
  summary: z.string().min(1).max(300).describe("One or two sentences explaining the level"),
  confidence: z.enum(CONFIDENCE),
  drivers: z.array(RiskDriverInput).min(1).max(6),
});

export type RiskSubmission = z.infer<typeof RiskSubmission>;

export type RiskDriver = {
  factor: string;
  direction: "raises" | "lowers";
  citations: VerifiedCitation[];
};

export type RiskGuardrailReport = {
  modelLevel: RiskLevel | null;
  floorLevel: RiskLevel | null;
  floorApplied: boolean;
  reviewTightened: boolean;
  rejectedDrivers: Array<{ factor: string; reason: string }>;
  unsupportedLevel: boolean;
  summaryRejected: boolean;
};

export type RiskResult = {
  method: "agent" | "rules";
  level: RiskLevel;
  review: ReviewWindow;
  summary: string;
  confidence: (typeof CONFIDENCE)[number] | null;
  drivers: RiskDriver[];
  floorReasons: FloorReason[];
  report: RiskGuardrailReport;
};
