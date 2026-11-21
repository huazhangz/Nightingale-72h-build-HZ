import { writeFileSync } from "node:fs";
import path from "node:path";
import { RISK_LEVELS, riskRank, type RiskLevel } from "../../src/lib/agent/risk/levels";
import { holmAdjust, pairedComparison } from "../lib/stats";
import { RISK_STRATA } from "./cases";
import { caseBootstrap, confusionMatrix, triageMetrics, type LevelPair, type TriageMetrics } from "./metrics";
import type { RiskErrorRow, RiskRow } from "./runner";

export type RiskVariantSummary = {
  variant: string;
  trials: number;
  cases: number;
  final: TriageMetrics;
  /** Model level before the floor, over trials where a model submitted. */
  model: TriageMetrics | null;
  ci: {
    exact: [number, number] | null;
    underTriage: [number, number] | null;
    sensitivityHighPlus: [number, number] | null;
    qwk: [number, number] | null;
  };
  /** Share of cases where every rep's final level equals gold (pass^k with k = reps). */
  allRepsExact: number;
  /** Trials where the floor raised the model's level. */
  floorLifts: number;
  /** Floor lifts that turned a model under-triage into a correct or higher final level. */
  floorRescues: number;
  modelFailures: number;
  unsupportedLevels: number;
  rejectedDrivers: number;
  meanCostUsd: number | null;
  meanWallMs: number;
  meanSteps: number;
};

const pct = (value: number | null | undefined) => (value === null || value === undefined || Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits));
const range = (interval: [number, number] | null, format: (value: number) => string = (value) => pct(value)) =>
  interval ? `[${format(interval[0])}, ${format(interval[1])}]` : "";

function groupByCase(rows: RiskRow[], pick: (row: RiskRow) => RiskLevel | null): LevelPair[][] {
  const byCase = new Map<string, LevelPair[]>();
  for (const row of rows) {
    const predicted = pick(row);
    if (predicted === null) {
      continue;
    }
    byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), { gold: row.gold, predicted }]);
  }
  return [...byCase.values()];
}

function interval(pairsByCase: LevelPair[][], statistic: (pairs: LevelPair[]) => number | null): [number, number] | null {
  const result = caseBootstrap(pairsByCase, statistic);
  return result && Number.isFinite(result.low) ? [result.low, result.high] : null;
}

export function summarizeRisk(rows: RiskRow[]): RiskVariantSummary[] {
  const variants = [...new Set(rows.map((row) => row.variant))];
  return variants.map((variant) => {
    const own = rows.filter((row) => row.variant === variant);
    const finalByCase = groupByCase(own, (row) => row.final);
    const modelByCase = groupByCase(own, (row) => row.modelLevel);
    const modelPairs = modelByCase.flat();
    const costs = own.map((row) => row.costUsd).filter((value): value is number => value !== null);
    return {
      variant,
      trials: own.length,
      cases: finalByCase.length,
      final: triageMetrics(finalByCase.flat()),
      model: modelPairs.length ? triageMetrics(modelPairs) : null,
      ci: {
        exact: interval(finalByCase, (pairs) => triageMetrics(pairs).exact),
        underTriage: interval(finalByCase, (pairs) => triageMetrics(pairs).underTriage),
        sensitivityHighPlus: interval(finalByCase, (pairs) => triageMetrics(pairs).sensitivityHighPlus),
        qwk: interval(finalByCase, (pairs) => triageMetrics(pairs).qwk),
      },
      allRepsExact: finalByCase.filter((pairs) => pairs.every((pair) => pair.gold === pair.predicted)).length / Math.max(1, finalByCase.length),
      floorLifts: own.filter((row) => row.modelLevel !== null && riskRank(row.final) > riskRank(row.modelLevel)).length,
      floorRescues: own.filter(
        (row) => row.modelLevel !== null && riskRank(row.modelLevel) < riskRank(row.gold) && riskRank(row.final) >= riskRank(row.gold),
      ).length,
      modelFailures: own.filter((row) => row.modelFailed).length,
      unsupportedLevels: own.filter((row) => row.unsupportedLevel).length,
      rejectedDrivers: own.reduce((sum, row) => sum + row.rejectedDrivers, 0),
      meanCostUsd: costs.length === own.length && costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null,
      meanWallMs: own.reduce((sum, row) => sum + row.wallMs, 0) / Math.max(1, own.length),
      meanSteps: own.reduce((sum, row) => sum + row.steps, 0) / Math.max(1, own.length),
    };
  });
}

/** Safety invariants every row must satisfy, whatever the variant. Violations are bugs, not model errors. */
export function invariantViolations(rows: RiskRow[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const where = `${row.variant}/${row.caseId}/rep${row.rep}`;
    if (row.floorLevel !== null && riskRank(row.final) < riskRank(row.floorLevel)) {
      problems.push(`${where}: final ${row.final} below floor ${row.floorLevel}`);
    }
    if (row.modelLevel !== null && riskRank(row.final) < riskRank(row.modelLevel)) {
      problems.push(`${where}: final ${row.final} below model level ${row.modelLevel}`);
    }
  }
  return problems;
}

function confusionTable(pairs: LevelPair[]): string[] {
  const matrix = confusionMatrix(pairs);
  return [
    `| gold \\ predicted | ${RISK_LEVELS.join(" | ")} |`,
    `|---|${RISK_LEVELS.map(() => "---:").join("|")}|`,
    ...RISK_LEVELS.map((level, i) => `| **${level}** | ${matrix[i]!.map((count, j) => (i === j ? `**${count}**` : String(count))).join(" | ")} |`),
  ];
}

function perCaseRate(rows: RiskRow[], variant: string, caseIds: string[], hit: (row: RiskRow) => boolean): number[] {
  return caseIds.map((caseId) => {
    const own = rows.filter((row) => row.variant === variant && row.caseId === caseId);
    return own.filter(hit).length / own.length;
  });
}

export function writeRiskReport(
  outDir: string,
  rows: RiskRow[],
  errors: RiskErrorRow[],
  config: Record<string, unknown>,
): { summaries: RiskVariantSummary[]; violations: string[] } {
  const summaries = summarizeRisk(rows);
  const violations = invariantViolations(rows);
  const lines: string[] = [];
  const cases = [...new Map(rows.map((row) => [row.caseId, row])).values()];
  const goldCounts = RISK_LEVELS.map((level) => `${level} ${cases.filter((row) => row.gold === level).length}`).join(", ");

  lines.push("# Risk triage evaluation", "");
  lines.push(
    `Case set \`${String(config.caseSetHash)}\` · prompts ${config.prompts ? `\`${String(config.prompts)}\`` : `\`${String(config.promptVersion)}\` (\`${String(config.promptHash)}\`)`} · ${cases.length} cases (${goldCounts}) · ${String(config.reps)} rep(s) · evaluation date ${String(config.evalNow ?? "")}`,
    "",
    "> Gold levels are hand-labelled by the project author from the note text. They are **not clinician-verified**; treat",
    "> absolute numbers as a regression signal for this harness, not as clinical performance.",
    "",
  );

  lines.push("## Summary (final level shown on the worklist)", "");
  lines.push("95% intervals are case-level cluster bootstrap (reps of one case resampled together).", "");
  lines.push("| variant | trials | exact | under-triage | severe under | over-triage | sens ≥HIGH | sens CRITICAL | spec LOW | QWK | all reps exact |");
  lines.push("|---|---:|---|---|---:|---:|---|---:|---:|---|---:|");
  for (const item of summaries) {
    const final = item.final;
    lines.push(
      `| ${item.variant} | ${item.trials} | ${pct(final.exact)} ${range(item.ci.exact)} | ${pct(final.underTriage)} ${range(item.ci.underTriage)} | ${pct(final.severeUnderTriage)} | ${pct(final.overTriage)} | ${pct(final.sensitivityHighPlus)} ${range(item.ci.sensitivityHighPlus)} | ${pct(final.sensitivityCritical)} | ${pct(final.specificityLow)} | ${num(final.qwk)} ${range(item.ci.qwk, (value) => num(value))} | ${pct(item.allRepsExact)} |`,
    );
  }
  lines.push("");

  lines.push("## Model level vs. final level (what the deterministic floor adds)", "");
  lines.push("| variant | model exact | model under-triage | final under-triage | floor lifts | floor rescues | model failures (fell back to floor) | unsupported levels | rejected drivers | mean steps | mean cost | mean wall |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const item of summaries) {
    lines.push(
      `| ${item.variant} | ${pct(item.model?.exact)} | ${pct(item.model?.underTriage)} | ${pct(item.final.underTriage)} | ${item.floorLifts} | ${item.floorRescues} | ${item.modelFailures} | ${item.unsupportedLevels} | ${item.rejectedDrivers} | ${num(item.meanSteps, 1)} | ${item.meanCostUsd === null ? "n/a" : `$${item.meanCostUsd.toFixed(4)}`} | ${(item.meanWallMs / 1000).toFixed(2)} s |`,
    );
  }
  lines.push(
    "",
    "*Floor lift*: the final level is above the model's. *Floor rescue*: the model under-triaged and the floor brought the final level to gold or above.",
    "",
  );

  lines.push("## Accuracy by stratum (final level, exact)", "");
  const strata = RISK_STRATA.filter((stratum) => rows.some((row) => row.stratum === stratum));
  lines.push(`| variant | ${strata.join(" | ")} |`, `|---|${strata.map(() => "---:").join("|")}|`);
  for (const item of summaries) {
    const cells = strata.map((stratum) => {
      const own = rows.filter((row) => row.variant === item.variant && row.stratum === stratum);
      return own.length ? `${pct(own.filter((row) => row.final === row.gold).length / own.length)} (${new Set(own.map((row) => row.caseId)).size})` : "–";
    });
    lines.push(`| ${item.variant} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  const baseline = summaries.find((item) => item.variant === "rules");
  const challengers = summaries.filter((item) => item.variant !== "rules" && item.variant !== "oracle");
  if (baseline && challengers.length > 0) {
    lines.push("## Paired comparison against the rules baseline (production fallback)", "");
    lines.push("Per-case rates, paired by case; p-values are sign-flip permutation, Holm-adjusted across all rows.", "");
    const comparisons: Array<{ label: string; meanDiff: number; ci: [number, number]; p: number; mde: number; n: number }> = [];
    for (const challenger of challengers) {
      const shared = [...new Set(rows.filter((row) => row.variant === challenger.variant).map((row) => row.caseId))].filter((caseId) =>
        rows.some((row) => row.variant === "rules" && row.caseId === caseId),
      );
      if (shared.length < 2) {
        continue;
      }
      for (const [metric, hit] of [
        ["exact", (row: RiskRow) => row.final === row.gold],
        ["under-triage", (row: RiskRow) => riskRank(row.final) < riskRank(row.gold)],
      ] as const) {
        const result = pairedComparison(perCaseRate(rows, challenger.variant, shared, hit), perCaseRate(rows, "rules", shared, hit));
        comparisons.push({ label: `${challenger.variant} − rules: ${metric}`, meanDiff: result.meanDiff, ci: result.bootstrapCi, p: result.permutationPValue, mde: result.mde, n: result.n });
      }
    }
    const adjusted = holmAdjust(comparisons.map((item) => item.p));
    lines.push("| comparison | cases | mean diff | 95% CI (bootstrap) | p (Holm) | MDE (80% power) |", "|---|---:|---:|---|---:|---:|");
    comparisons.forEach((item, index) => {
      lines.push(`| ${item.label} | ${item.n} | ${pct(item.meanDiff)} | ${range(item.ci)} | ${num(adjusted[index], 3)} | ${pct(item.mde)} |`);
    });
    lines.push("");
  }

  lines.push("## Confusion matrices (final level)", "");
  for (const item of summaries) {
    lines.push(`### ${item.variant}`, "", ...confusionTable(rows.filter((row) => row.variant === item.variant).map((row) => ({ gold: row.gold, predicted: row.final }))), "");
  }

  lines.push("## Per case", "");
  const variants = summaries.map((item) => item.variant);
  lines.push(`| case | stratum | gold | floor | ${variants.join(" | ")} |`, `|---|---|---|---|${variants.map(() => "---").join("|")}|`);
  for (const sample of cases) {
    const cells = variants.map((variant) => {
      const own = rows.filter((row) => row.variant === variant && row.caseId === sample.caseId).sort((left, right) => left.rep - right.rep);
      return own
        .map((row) => {
          const mark = row.final === row.gold ? "" : riskRank(row.final) < riskRank(row.gold) ? "↓" : "↑";
          const model = row.modelLevel && row.modelLevel !== row.final ? ` (model ${row.modelLevel})` : "";
          return `${row.final}${mark}${model}`;
        })
        .join(", ");
    });
    lines.push(`| ${sample.caseId} | ${sample.stratum} | ${sample.gold} | ${sample.floorLevel ?? "–"} | ${cells.join(" | ")} |`);
  }
  lines.push("", "↓ under-triage, ↑ over-triage.", "");

  if (violations.length > 0) {
    lines.push("## Safety invariant violations", "", ...violations.map((item) => `- ${item}`), "");
  }
  if (errors.length > 0) {
    lines.push("## Infrastructure errors (not scored; retried on the next run)", "");
    lines.push("| variant | case | rep | class | message |", "|---|---|---:|---|---|");
    for (const error of errors) {
      lines.push(`| ${error.variant} | ${error.caseId} | ${error.rep} | ${error.errorClass} | ${error.message.replace(/\|/g, "/").slice(0, 160)} |`);
    }
    lines.push("");
  }

  writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify({ summaries, violations, errors: errors.length }, null, 2)}\n`);
  return { summaries, violations };
}
