import { writeFileSync } from "node:fs";
import path from "node:path";
import { FAILURE_CLASSES, type FailureClass } from "./graders";
import type { ErrorRow, ResultRow } from "./runner";
import {
  bootstrapInterval,
  caseMeanInterval,
  designEffect,
  holmAdjust,
  mcnemarExact,
  mean,
  pairedComparison,
  passAtK,
  passHatK,
  quantile,
  wilsonInterval,
  type PairedComparison,
} from "./stats";

const BASELINE_VARIANTS = new Set(["oracle", "null"]);

type Interval = { estimate: number; low: number; high: number; bootLow: number; bootHigh: number; casesUsed: number };

export type VariantSummary = {
  variant: string;
  trials: number;
  cases: number;
  minReps: number;
  errors: number;
  passAt: Record<number, Interval>;
  passHat: Record<number, Interval>;
  naive: { rate: number; low: number; high: number };
  designEffect: number;
  failureRate: Record<FailureClass, number>;
  failureShareOfFailed: Record<FailureClass, number>;
  atomic: {
    citationValidity: number;
    coverage: number;
    falseAssertionsPerRun: number;
    overTriagePerRun: number;
    leakageRuns: number;
    rawCriticalRecall: number;
    guardrailUpgradesPerRun: number;
    guardrailInjectionsPerRun: number;
    guardrailFalseAlarmsPerRun: number;
    toolErrorsPerRun: number;
    proposalsPerRun: number;
    refusals: number;
    fallbackRuns: number;
  };
  cost: { meanUsd: number | null; totalUsd: number | null };
  tokens: { meanInput: number; meanOutput: number; meanCacheRead: number; meanCacheWrite: number };
  latency: { p50WallS: number; p95WallS: number; p50ModelS: number; p95ModelS: number };
  meanSteps: number;
  retries: number;
  byStratum: Record<string, { cases: number; passAt1: number }>;
  perCase: Record<string, { n: number; c: number; rate: number }>;
};

export type PairSummary = {
  a: string;
  b: string;
  metric: "pass@1";
  comparison: PairedComparison;
  holmP: number;
  mcnemar?: { aOnly: number; bOnly: number; p: number };
};

function perCaseCounts(rows: ResultRow[]): Map<string, { n: number; c: number }> {
  const counts = new Map<string, { n: number; c: number }>();
  for (const row of rows) {
    const current = counts.get(row.caseId) ?? { n: 0, c: 0 };
    current.n += 1;
    current.c += row.passed ? 1 : 0;
    counts.set(row.caseId, current);
  }
  return counts;
}

function estimate(counts: Map<string, { n: number; c: number }>, k: number, fn: typeof passAtK, seed: number): Interval {
  const values = [...counts.values()].filter((count) => count.n >= k).map((count) => fn(count.n, count.c, k));
  const t = caseMeanInterval(values);
  const boot = values.length >= 2 ? bootstrapInterval(values, { seed }) : { low: Number.NaN, high: Number.NaN };
  return { estimate: t.estimate, low: t.low, high: t.high, bootLow: boot.low, bootHigh: boot.high, casesUsed: values.length };
}

export function summariseVariant(variant: string, rows: ResultRow[], errors: ErrorRow[], ks: number[]): VariantSummary {
  const counts = perCaseCounts(rows);
  const passAt: Record<number, Interval> = {};
  const passHat: Record<number, Interval> = {};
  ks.forEach((k, index) => {
    passAt[k] = estimate(counts, k, passAtK, 1_000 + index);
    passHat[k] = estimate(counts, k, passHatK, 2_000 + index);
  });
  const passedTrials = rows.filter((row) => row.passed).length;
  const [naiveLow, naiveHigh] = wilsonInterval(passedTrials, rows.length);
  const perCaseRates = [...counts.values()].map((count) => count.c / count.n);
  const minReps = Math.min(...[...counts.values()].map((count) => count.n));
  const failed = rows.filter((row) => !row.passed);
  const failureRate = Object.fromEntries(
    FAILURE_CLASSES.map((name) => [name, rows.filter((row) => row.failures.includes(name)).length / Math.max(1, rows.length)]),
  ) as Record<FailureClass, number>;
  const failureShareOfFailed = Object.fromEntries(
    FAILURE_CLASSES.map((name) => [name, failed.filter((row) => row.failures.includes(name)).length / Math.max(1, failed.length)]),
  ) as Record<FailureClass, number>;
  const sum = (pick: (row: ResultRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const perRun = (pick: (row: ResultRow) => number) => sum(pick) / Math.max(1, rows.length);
  const costs = rows.map((row) => row.costUsd);
  const knownCost = costs.every((cost) => cost !== null);

  const byStratum: Record<string, { cases: number; passAt1: number }> = {};
  for (const stratum of new Set(rows.map((row) => row.stratum))) {
    const stratumCounts = perCaseCounts(rows.filter((row) => row.stratum === stratum));
    byStratum[stratum] = {
      cases: stratumCounts.size,
      passAt1: mean([...stratumCounts.values()].map((count) => count.c / count.n)),
    };
  }

  return {
    variant,
    trials: rows.length,
    cases: counts.size,
    minReps: Number.isFinite(minReps) ? minReps : 0,
    errors: errors.length,
    passAt,
    passHat,
    naive: { rate: passedTrials / Math.max(1, rows.length), low: naiveLow, high: naiveHigh },
    designEffect: designEffect(perCaseRates, Number.isFinite(minReps) ? minReps : 1, passedTrials / Math.max(1, rows.length)),
    failureRate,
    failureShareOfFailed,
    atomic: {
      citationValidity: sum((row) => row.metrics.acceptedItems) / Math.max(1, sum((row) => row.metrics.modelItems)),
      coverage: sum((row) => row.metrics.mustCoverHit) / Math.max(1, sum((row) => row.metrics.mustCoverTotal)),
      falseAssertionsPerRun: perRun((row) => row.metrics.falseAssertions),
      overTriagePerRun: perRun((row) => row.metrics.overTriage),
      leakageRuns: rows.filter((row) => row.metrics.leakageHits > 0).length,
      rawCriticalRecall:
        sum((row) => row.metrics.modelCoveredCritical) / Math.max(1, sum((row) => row.metrics.requiredCritical)),
      guardrailUpgradesPerRun: perRun((row) => row.metrics.guardrailUpgrades),
      guardrailInjectionsPerRun: perRun((row) => row.metrics.guardrailInjections),
      guardrailFalseAlarmsPerRun: perRun((row) => row.metrics.guardrailFalseAlarms),
      toolErrorsPerRun: perRun((row) => row.metrics.toolErrors),
      proposalsPerRun: perRun((row) => row.metrics.proposals),
      refusals: rows.filter((row) => row.outcome === "REFUSED").length,
      fallbackRuns: rows.filter((row) => row.fallbackUsed).length,
    },
    cost: {
      meanUsd: knownCost ? mean(costs as number[]) : null,
      totalUsd: knownCost ? (costs as number[]).reduce((total, cost) => total + cost, 0) : null,
    },
    tokens: {
      meanInput: perRun((row) => row.usage.inputTokens),
      meanOutput: perRun((row) => row.usage.outputTokens),
      meanCacheRead: perRun((row) => row.usage.cacheReadInputTokens),
      meanCacheWrite: perRun((row) => row.usage.cacheCreationInputTokens),
    },
    latency: {
      p50WallS: quantile(rows.map((row) => row.wallMs), 0.5) / 1000,
      p95WallS: quantile(rows.map((row) => row.wallMs), 0.95) / 1000,
      p50ModelS: quantile(rows.map((row) => row.modelLatencyMs), 0.5) / 1000,
      p95ModelS: quantile(rows.map((row) => row.modelLatencyMs), 0.95) / 1000,
    },
    meanSteps: perRun((row) => row.metrics.steps),
    retries: sum((row) => row.retries),
    byStratum,
    perCase: Object.fromEntries([...counts.entries()].map(([id, count]) => [id, { ...count, rate: count.c / count.n }])),
  };
}

export function comparePairs(rowsByVariant: Map<string, ResultRow[]>): PairSummary[] {
  const variants = [...rowsByVariant.keys()].filter((variant) => !BASELINE_VARIANTS.has(variant));
  const pairs: Array<Omit<PairSummary, "holmP">> = [];
  for (let i = 0; i < variants.length; i += 1) {
    for (let j = i + 1; j < variants.length; j += 1) {
      const a = variants[i]!;
      const b = variants[j]!;
      const countsA = perCaseCounts(rowsByVariant.get(a)!);
      const countsB = perCaseCounts(rowsByVariant.get(b)!);
      const common = [...countsA.keys()].filter((id) => countsB.has(id)).sort();
      if (common.length < 2) {
        continue;
      }
      const ratesA = common.map((id) => countsA.get(id)!.c / countsA.get(id)!.n);
      const ratesB = common.map((id) => countsB.get(id)!.c / countsB.get(id)!.n);
      const singleRep = common.every((id) => countsA.get(id)!.n === 1 && countsB.get(id)!.n === 1);
      pairs.push({
        a,
        b,
        metric: "pass@1",
        comparison: pairedComparison(ratesA, ratesB, { seed: 99 + i * 10 + j }),
        ...(singleRep ? { mcnemar: mcnemarExact(ratesA.map((rate) => rate === 1), ratesB.map((rate) => rate === 1)) } : {}),
      });
    }
  }
  const adjusted = holmAdjust(pairs.map((pair) => pair.comparison.permutationPValue));
  return pairs.map((pair, index) => ({ ...pair, holmP: adjusted[index]! }));
}

const pct = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a");
const num = (value: number, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "n/a");
const ci = (interval: { low: number; high: number }) => `[${pct(interval.low)}, ${pct(interval.high)}]`;
const pValue = (value: number) => (value < 0.001 ? "<0.001" : value.toFixed(3));

export function renderMarkdown(input: {
  config: Record<string, unknown>;
  summaries: VariantSummary[];
  pairs: PairSummary[];
  ks: number[];
  errors: ErrorRow[];
}): string {
  const { config, summaries, pairs, ks, errors } = input;
  const lines: string[] = [];
  const variants = (config.variants as Array<{ id: string; kind: string; model: string; promptVersion: string; promptHash: string }>) ?? [];
  lines.push("# Handover agent evaluation report", "");
  lines.push(
    `Grader \`${String(config.graderVersion)}\` · case set \`${String(config.caseSetHash)}\` (${(config.caseIds as string[]).length} cases) · ` +
      `generated ${new Date().toISOString()}`,
    "",
  );
  lines.push("| Variant | Kind | Model | Prompt |", "| --- | --- | --- | --- |");
  for (const variant of variants) {
    lines.push(`| ${variant.id} | ${variant.kind} | ${variant.model} | ${variant.promptVersion} (\`${variant.promptHash}\`) |`);
  }
  lines.push("");

  lines.push("## Headline", "");
  lines.push(
    "Per-case estimates averaged over cases; 95% intervals are case-level t-intervals with the cluster-bootstrap interval in brackets. " +
      "pass@k = chance at least one of k attempts passes; pass^k = chance all k pass (reliability).",
    "",
  );
  const headHeader = ["Variant", "Trials", ...ks.flatMap((k) => [`pass@${k}`, `pass^${k}`])];
  lines.push(`| ${headHeader.join(" | ")} |`, `| ${headHeader.map(() => "---").join(" | ")} |`);
  for (const summary of summaries) {
    const cells = [summary.variant, `${summary.trials} (${summary.cases}×≥${summary.minReps})`];
    for (const k of ks) {
      const at = summary.passAt[k]!;
      const hat = summary.passHat[k]!;
      cells.push(
        at.casesUsed ? `${pct(at.estimate)} ${ci(at)} <sub>boot ${ci({ low: at.bootLow, high: at.bootHigh })}</sub>` : "n/a",
        hat.casesUsed ? `${pct(hat.estimate)} ${ci(hat)}` : "n/a",
      );
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("Naive pooled pass rate (treats every trial as independent; shown only to quantify clustering):", "");
  lines.push("| Variant | Pooled rate | Wilson 95% | Design effect |", "| --- | --- | --- | --- |");
  for (const summary of summaries) {
    lines.push(`| ${summary.variant} | ${pct(summary.naive.rate)} | ${ci(summary.naive)} | ${num(summary.designEffect)} |`);
  }
  lines.push("");

  lines.push("## Failure taxonomy", "", "Share of scored trials exhibiting each failure class (a trial can have several).", "");
  lines.push(`| Variant | ${FAILURE_CLASSES.join(" | ")} |`, `| --- | ${FAILURE_CLASSES.map(() => "---").join(" | ")} |`);
  for (const summary of summaries) {
    lines.push(`| ${summary.variant} | ${FAILURE_CLASSES.map((name) => pct(summary.failureRate[name])).join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Atomic metrics", "");
  lines.push(
    "| Variant | Citation validity | Required-fact coverage | False assertions / run | Over-triage / run | Leakage runs | Raw critical recall | Guardrail upgrades / run | Guardrail injections / run | Guardrail false alarms / run | Tool errors / run | Proposals / run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const summary of summaries) {
    const a = summary.atomic;
    lines.push(
      `| ${summary.variant} | ${pct(a.citationValidity)} | ${pct(a.coverage)} | ${num(a.falseAssertionsPerRun)} | ${num(a.overTriagePerRun)} | ` +
        `${a.leakageRuns} | ${pct(a.rawCriticalRecall)} | ${num(a.guardrailUpgradesPerRun)} | ${num(a.guardrailInjectionsPerRun)} | ` +
        `${num(a.guardrailFalseAlarmsPerRun)} | ${num(a.toolErrorsPerRun)} | ${num(a.proposalsPerRun)} |`,
    );
  }
  lines.push(
    "",
    "Raw critical recall is the share of rule-engine critical findings the model itself presented as critical; after guardrails it is 100% by construction. " +
      "Guardrail false alarms are forced items whose phrase the labelled ground truth marks as not current (engine misread negation or advice).",
    "",
  );

  lines.push("## Cost and latency", "");
  lines.push(
    "| Variant | Mean $/run | Total $ | Mean input tok | Mean output tok | Mean cache-read tok | p50 / p95 wall (s) | p50 / p95 model (s) | Mean steps | Retries | Refusals | Fallback runs |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.variant} | ${summary.cost.meanUsd === null ? "n/a" : `$${summary.cost.meanUsd.toFixed(4)}`} | ` +
        `${summary.cost.totalUsd === null ? "n/a" : `$${summary.cost.totalUsd.toFixed(2)}`} | ${Math.round(summary.tokens.meanInput)} | ` +
        `${Math.round(summary.tokens.meanOutput)} | ${Math.round(summary.tokens.meanCacheRead)} | ${num(summary.latency.p50WallS, 1)} / ${num(summary.latency.p95WallS, 1)} | ` +
        `${num(summary.latency.p50ModelS, 1)} / ${num(summary.latency.p95ModelS, 1)} | ${num(summary.meanSteps, 1)} | ${summary.retries} | ` +
        `${summary.atomic.refusals} | ${summary.atomic.fallbackRuns} |`,
    );
  }
  lines.push("");

  if (pairs.length > 0) {
    lines.push("## Paired comparisons (pass@1, paired by case)", "");
    lines.push(
      "Difference A − B in per-case pass rate. p-values: sign-flip permutation (exact when ≤ 20 non-zero pairs) with Holm correction across pairs; " +
        "paired t for reference. MDE = smallest difference detectable with 80% power at α = 0.05 given the observed spread.",
      "",
    );
    lines.push(
      "| A vs B | Cases | Δ (A − B) | 95% CI (t) | 95% CI (bootstrap) | p perm | p Holm | p t | MDE |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const pair of pairs) {
      const c = pair.comparison;
      lines.push(
        `| ${pair.a} vs ${pair.b} | ${c.n} | ${pct(c.meanDiff)} | [${pct(c.ci[0])}, ${pct(c.ci[1])}] | [${pct(c.bootstrapCi[0])}, ${pct(c.bootstrapCi[1])}] | ` +
          `${pValue(c.permutationPValue)}${c.permutationExact ? "" : "*"} | ${pValue(pair.holmP)} | ${pValue(c.tPValue)} | ${pct(c.mde)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## By stratum (pass@1)", "");
  const strata = [...new Set(summaries.flatMap((summary) => Object.keys(summary.byStratum)))].sort();
  lines.push(`| Variant | ${strata.map((name) => `${name}`).join(" | ")} |`, `| --- | ${strata.map(() => "---").join(" | ")} |`);
  for (const summary of summaries) {
    lines.push(
      `| ${summary.variant} | ${strata.map((name) => (summary.byStratum[name] ? `${pct(summary.byStratum[name]!.passAt1)} (${summary.byStratum[name]!.cases})` : "–")).join(" | ")} |`,
    );
  }
  lines.push("");

  lines.push("## Per case (passes / trials)", "");
  const caseIds = (config.caseIds as string[]) ?? [];
  lines.push(`| Case | ${summaries.map((summary) => summary.variant).join(" | ")} |`, `| --- | ${summaries.map(() => "---").join(" | ")} |`);
  for (const id of caseIds) {
    lines.push(
      `| ${id} | ${summaries.map((summary) => (summary.perCase[id] ? `${summary.perCase[id]!.c}/${summary.perCase[id]!.n}` : "–")).join(" | ")} |`,
    );
  }
  lines.push("");

  lines.push("## Infrastructure errors (excluded from scores)", "");
  if (errors.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("| Variant | Case | Rep | Class | Message |", "| --- | --- | --- | --- | --- |");
    for (const error of errors.slice(0, 50)) {
      lines.push(`| ${error.variant} | ${error.caseId} | ${error.rep} | ${error.errorClass} | ${error.message.replace(/\|/g, "/").slice(0, 120)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function writeReport(outDir: string, results: ResultRow[], errors: ErrorRow[], config: Record<string, unknown>, ks: number[]) {
  const byVariant = new Map<string, ResultRow[]>();
  for (const row of results) {
    byVariant.set(row.variant, [...(byVariant.get(row.variant) ?? []), row]);
  }
  const order = ((config.variants as Array<{ id: string }>) ?? []).map((variant) => variant.id).filter((id) => byVariant.has(id));
  const summaries = order.map((variant) =>
    summariseVariant(variant, byVariant.get(variant)!, errors.filter((error) => error.variant === variant), ks),
  );
  const pairs = comparePairs(new Map(order.map((variant) => [variant, byVariant.get(variant)!])));
  const markdown = renderMarkdown({ config, summaries, pairs, ks, errors });
  writeFileSync(path.join(outDir, "report.md"), markdown);
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ config, ks, summaries, pairs }, null, 2));
  return { summaries, pairs, markdown };
}
