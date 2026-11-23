# Handover agent evaluation report

Grader `2026-11-21.2` · case set `0dea3c2d5f0a` (20 cases) · generated 2026-11-23T08:49:25.691Z

| Variant | Kind | Model | Prompt |
| --- | --- | --- | --- |
| gemini-v4-repair | gemini | gemini-2.5-flash | handover-v4 (`610e53fd417d`) |

## Headline

Per-case estimates averaged over cases; 95% intervals are case-level t-intervals with the cluster-bootstrap interval in brackets. pass@k = chance at least one of k attempts passes; pass^k = chance all k pass (reliability).

| Variant | Trials | pass@1 | pass^1 |
| --- | --- | --- | --- |
| gemini-v4-repair | 20 (20×≥1) | 90.0% [75.6%, 100.0%] <sub>boot [75.0%, 100.0%]</sub> | 90.0% [75.6%, 100.0%] |

Naive pooled pass rate (treats every trial as independent; shown only to quantify clustering):

| Variant | Pooled rate | Wilson 95% | Design effect |
| --- | --- | --- | --- |
| gemini-v4-repair | 90.0% | [69.9%, 97.2%] | 1.05 |

## Failure taxonomy

Share of scored trials exhibiting each failure class (a trial can have several).

| Variant | TOOL_MISUSE | OMISSION | FABRICATION | SEVERITY_DOWNGRADE | LEAKAGE | NO_SUBMISSION | REFUSAL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4-repair | 0.0% | 10.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Atomic metrics

| Variant | Citation validity | Required-fact coverage | False assertions / run | Over-triage / run | Leakage runs | Raw critical recall | Guardrail upgrades / run | Guardrail injections / run | Guardrail false alarms / run | Tool errors / run | Proposals / run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4-repair | 100.0% | 100.0% | 0.00 | 0.00 | 0 | 50.0% | 0.05 | 0.00 | 0.00 | 0.10 | 0.20 |

Raw critical recall is the share of rule-engine critical findings the model itself presented as critical; after guardrails it is 100% by construction. Guardrail false alarms are forced items whose phrase the labelled ground truth marks as not current (engine misread negation or advice).

## Cost and latency

| Variant | Mean $/run | Total $ | Mean input tok | Mean output tok | Mean cache-read tok | p50 / p95 wall (s) | p50 / p95 model (s) | Mean steps | Retries | Citation repairs (runs) | Refusals | Fallback runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v4-repair | $0.0033 | $0.07 | 1720 | 1068 | 5247 | 10.5 / 14.1 | 10.5 / 14.1 | 3.3 | 0 | 1 | 0 | 0 |

## By stratum (pass@1)

| Variant | challenge |
| --- | --- |
| gemini-v4-repair | 90.0% (20) |

## Per case (passes / trials)

| Case | gemini-v4-repair |
| --- | --- |
| ch-latest-encounter | 1/1 |
| ch-allergy-reaction | 1/1 |
| ch-pending-biopsy | 0/1 |
| ch-safeguarding | 1/1 |
| ch-medication-stopped | 1/1 |
| ch-carer-comment | 1/1 |
| ch-normal-vitals-negated | 1/1 |
| ch-conditional-plan | 1/1 |
| ch-two-problems | 1/1 |
| ch-abbreviations | 1/1 |
| ch-family-history | 1/1 |
| ch-weight-trend | 1/1 |
| ch-discharge-instructions | 1/1 |
| ch-dose-change | 1/1 |
| ch-incidental-finding | 0/1 |
| ch-dnacpr | 1/1 |
| ch-interpreter | 1/1 |
| ch-falls | 1/1 |
| ch-diet | 1/1 |
| ch-oxygen-home | 1/1 |

## Infrastructure errors (excluded from scores)

None.
