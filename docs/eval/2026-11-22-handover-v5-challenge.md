# Handover agent evaluation report

Grader `2026-11-21.2` · case set `7abe1dd99b1a` (10 cases) · generated 2026-11-22T00:29:04.511Z

| Variant | Kind | Model | Prompt |
| --- | --- | --- | --- |
| gemini-v4 | gemini | gemini-2.5-flash | handover-v4 (`610e53fd417d`) |
| gemini-v4-repair | gemini | gemini-2.5-flash | handover-v4 (`610e53fd417d`) |
| gemini-v5 | gemini | gemini-2.5-flash | handover-v5 (`f57f96b0116c`) |

## Headline

Per-case estimates averaged over cases; 95% intervals are case-level t-intervals with the cluster-bootstrap interval in brackets. pass@k = chance at least one of k attempts passes; pass^k = chance all k pass (reliability).

| Variant | Trials | pass@1 | pass^1 | pass@2 | pass^2 |
| --- | --- | --- | --- | --- | --- |
| gemini-v4 | 20 (10×≥2) | 90.0% [74.9%, 100.0%] <sub>boot [75.0%, 100.0%]</sub> | 90.0% [74.9%, 100.0%] | 100.0% [100.0%, 100.0%] <sub>boot [100.0%, 100.0%]</sub> | 80.0% [49.8%, 100.0%] |
| gemini-v4-repair | 20 (10×≥2) | 95.0% [83.7%, 100.0%] <sub>boot [85.0%, 100.0%]</sub> | 95.0% [83.7%, 100.0%] | 100.0% [100.0%, 100.0%] <sub>boot [100.0%, 100.0%]</sub> | 90.0% [67.4%, 100.0%] |
| gemini-v5 | 20 (10×≥2) | 70.0% [39.8%, 100.0%] <sub>boot [45.0%, 95.0%]</sub> | 70.0% [39.8%, 100.0%] | 80.0% [49.8%, 100.0%] <sub>boot [50.0%, 100.0%]</sub> | 60.0% [23.1%, 96.9%] |

Naive pooled pass rate (treats every trial as independent; shown only to quantify clustering):

| Variant | Pooled rate | Wilson 95% | Design effect |
| --- | --- | --- | --- |
| gemini-v4 | 90.0% | [69.9%, 97.2%] | 0.99 |
| gemini-v4-repair | 95.0% | [76.4%, 99.1%] | 1.05 |
| gemini-v5 | 70.0% | [48.1%, 85.5%] | 1.69 |

## Failure taxonomy

Share of scored trials exhibiting each failure class (a trial can have several).

| Variant | TOOL_MISUSE | OMISSION | FABRICATION | SEVERITY_DOWNGRADE | LEAKAGE | NO_SUBMISSION | REFUSAL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4 | 0.0% | 5.0% | 5.0% | 0.0% | 0.0% | 5.0% | 0.0% |
| gemini-v4-repair | 5.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| gemini-v5 | 10.0% | 0.0% | 0.0% | 0.0% | 0.0% | 20.0% | 0.0% |

## Atomic metrics

| Variant | Citation validity | Required-fact coverage | False assertions / run | Over-triage / run | Leakage runs | Raw critical recall | Guardrail upgrades / run | Guardrail injections / run | Guardrail false alarms / run | Tool errors / run | Proposals / run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4 | 98.6% | 90.5% | 0.00 | 0.00 | 0 | 100.0% | 0.00 | 0.00 | 0.00 | 0.10 | 0.30 |
| gemini-v4-repair | 100.0% | 100.0% | 0.00 | 0.00 | 0 | 100.0% | 0.00 | 0.00 | 0.00 | 0.20 | 0.40 |
| gemini-v5 | 100.0% | 78.6% | 0.00 | 0.00 | 0 | 0.0% | 0.00 | 0.10 | 0.00 | 0.05 | 0.45 |

Raw critical recall is the share of rule-engine critical findings the model itself presented as critical; after guardrails it is 100% by construction. Guardrail false alarms are forced items whose phrase the labelled ground truth marks as not current (engine misread negation or advice).

## Cost and latency

| Variant | Mean $/run | Total $ | Mean input tok | Mean output tok | Mean cache-read tok | p50 / p95 wall (s) | p50 / p95 model (s) | Mean steps | Retries | Citation repairs (runs) | Refusals | Fallback runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4 | $0.0047 | $0.09 | 2038 | 1573 | 5510 | 11.7 / 16.7 | 11.7 / 16.7 | 3.5 | 0 | 0 | 0 | 0 |
| gemini-v4-repair | $0.0048 | $0.10 | 1889 | 1640 | 6073 | 12.0 / 16.3 | 12.0 / 16.3 | 3.6 | 0 | 2 | 0 | 0 |
| gemini-v5 | $0.0039 | $0.08 | 2713 | 1179 | 5399 | 11.7 / 16.6 | 11.7 / 16.6 | 3.8 | 0 | 0 | 0 | 0 |

## Paired comparisons (pass@1, paired by case)

Difference A − B in per-case pass rate. p-values: sign-flip permutation (exact when ≤ 20 non-zero pairs) with Holm correction across pairs; paired t for reference. MDE = smallest difference detectable with 80% power at α = 0.05 given the observed spread.

| A vs B | Cases | Δ (A − B) | 95% CI (t) | 95% CI (bootstrap) | p perm | p Holm | p t | MDE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4 vs gemini-v4-repair | 10 | -5.0% | [-25.3%, 15.3%] | [-20.0%, 10.0%] | 1.000 | 1.000 | 0.591 | 28.2% |
| gemini-v4 vs gemini-v5 | 10 | 20.0% | [-14.6%, 54.6%] | [-5.0%, 50.0%] | 0.375 | 0.750 | 0.223 | 48.0% |
| gemini-v4-repair vs gemini-v5 | 10 | 25.0% | [-0.3%, 50.3%] | [5.0%, 45.0%] | 0.125 | 0.375 | 0.052 | 35.2% |

## By stratum (pass@1)

| Variant | challenge |
| --- | --- |
| gemini-v4 | 90.0% (10) |
| gemini-v4-repair | 95.0% (10) |
| gemini-v5 | 70.0% (10) |

## Per case (passes / trials)

| Case | gemini-v4 | gemini-v4-repair | gemini-v5 |
| --- | --- | --- | --- |
| ch-split-fact | 1/2 | 2/2 | 2/2 |
| ch-similar-wording | 2/2 | 2/2 | 2/2 |
| ch-negation-list | 2/2 | 2/2 | 2/2 |
| ch-typos | 2/2 | 2/2 | 2/2 |
| ch-numbers-units | 1/2 | 2/2 | 1/2 |
| ch-typographic | 2/2 | 2/2 | 2/2 |
| ch-long-note | 2/2 | 1/2 | 0/2 |
| ch-comment-only | 2/2 | 2/2 | 2/2 |
| ch-safety-net-regression | 2/2 | 2/2 | 0/2 |
| ch-negative-screen-regression | 2/2 | 2/2 | 1/2 |

## Infrastructure errors (excluded from scores)

None.
