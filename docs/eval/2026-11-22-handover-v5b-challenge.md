# Handover agent evaluation report

Grader `2026-11-21.2` · case set `7abe1dd99b1a` (10 cases) · generated 2026-11-22T00:35:57.574Z

| Variant | Kind | Model | Prompt |
| --- | --- | --- | --- |
| gemini-v5 | gemini | gemini-2.5-flash | handover-v5 (`5e452a24708d`) |

## Headline

Per-case estimates averaged over cases; 95% intervals are case-level t-intervals with the cluster-bootstrap interval in brackets. pass@k = chance at least one of k attempts passes; pass^k = chance all k pass (reliability).

| Variant | Trials | pass@1 | pass^1 | pass@2 | pass^2 |
| --- | --- | --- | --- | --- | --- |
| gemini-v5 | 20 (10×≥2) | 95.0% [83.7%, 100.0%] <sub>boot [85.0%, 100.0%]</sub> | 95.0% [83.7%, 100.0%] | 100.0% [100.0%, 100.0%] <sub>boot [100.0%, 100.0%]</sub> | 90.0% [67.4%, 100.0%] |

Naive pooled pass rate (treats every trial as independent; shown only to quantify clustering):

| Variant | Pooled rate | Wilson 95% | Design effect |
| --- | --- | --- | --- |
| gemini-v5 | 95.0% | [76.4%, 99.1%] | 1.05 |

## Failure taxonomy

Share of scored trials exhibiting each failure class (a trial can have several).

| Variant | TOOL_MISUSE | OMISSION | FABRICATION | SEVERITY_DOWNGRADE | LEAKAGE | NO_SUBMISSION | REFUSAL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v5 | 5.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Atomic metrics

| Variant | Citation validity | Required-fact coverage | False assertions / run | Over-triage / run | Leakage runs | Raw critical recall | Guardrail upgrades / run | Guardrail injections / run | Guardrail false alarms / run | Tool errors / run | Proposals / run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v5 | 100.0% | 100.0% | 0.00 | 0.00 | 0 | 100.0% | 0.00 | 0.00 | 0.00 | 0.15 | 0.45 |

Raw critical recall is the share of rule-engine critical findings the model itself presented as critical; after guardrails it is 100% by construction. Guardrail false alarms are forced items whose phrase the labelled ground truth marks as not current (engine misread negation or advice).

## Cost and latency

| Variant | Mean $/run | Total $ | Mean input tok | Mean output tok | Mean cache-read tok | p50 / p95 wall (s) | p50 / p95 model (s) | Mean steps | Retries | Citation repairs (runs) | Refusals | Fallback runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-v5 | $0.0042 | $0.08 | 1610 | 1430 | 5838 | 11.5 / 17.3 | 11.5 / 17.3 | 3.5 | 0 | 0 | 0 | 0 |

## By stratum (pass@1)

| Variant | challenge |
| --- | --- |
| gemini-v5 | 95.0% (10) |

## Per case (passes / trials)

| Case | gemini-v5 |
| --- | --- |
| ch-split-fact | 2/2 |
| ch-similar-wording | 2/2 |
| ch-negation-list | 2/2 |
| ch-typos | 2/2 |
| ch-numbers-units | 2/2 |
| ch-typographic | 2/2 |
| ch-long-note | 2/2 |
| ch-comment-only | 2/2 |
| ch-safety-net-regression | 1/2 |
| ch-negative-screen-regression | 2/2 |

## Infrastructure errors (excluded from scores)

None.
