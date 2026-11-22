# Risk triage evaluation

Case set `6c849759c705` · prompts `{"rules":"risk-v2:c1d863f10dbf","gemini-risk-v2":"risk-v2:c1d863f10dbf"}` · 8 cases (LOW 2, MEDIUM 1, HIGH 2, CRITICAL 3) · 2 rep(s) · evaluation date 2026-11-21T12:00:00.000Z

> Gold levels are hand-labelled by the project author from the note text. They are **not clinician-verified**; treat
> absolute numbers as a regression signal for this harness, not as clinical performance.

## Summary (final level shown on the worklist)

95% intervals are case-level cluster bootstrap (reps of one case resampled together).

| variant | trials | exact | under-triage | severe under | over-triage | sens ≥HIGH | sens CRITICAL | spec LOW | QWK | all reps exact |
|---|---:|---|---|---:|---:|---|---:|---:|---|---:|
| rules | 16 | 25.0% [0.0%, 62.5%] | 75.0% [37.5%, 100.0%] | 62.5% | 0.0% | 0.0% [0.0%, 0.0%] | 0.0% | 100.0% | 0.00 [0.00, 0.00] | 25.0% |
| gemini-risk-v2 | 16 | 87.5% [68.8%, 100.0%] | 0.0% [0.0%, 0.0%] | 0.0% | 12.5% | 100.0% [100.0%, 100.0%] | 100.0% | 75.0% | 0.96 [0.82, 1.00] | 75.0% |

## Model level vs. final level (what the deterministic floor adds)

| variant | model exact | model under-triage | final under-triage | floor lifts | floor rescues | model failures (fell back to floor) | unsupported levels | rejected drivers | mean steps | mean cost | mean wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rules | n/a | n/a | 75.0% | 0 | 0 | 0 | 0 | 0 | 0.0 | $0.0000 | 0.03 s |
| gemini-risk-v2 | 87.5% | 0.0% | 0.0% | 0 | 0 | 0 | 0 | 0 | 3.0 | $0.0032 | 9.56 s |

*Floor lift*: the final level is above the model's. *Floor rescue*: the model under-triaged and the floor brought the final level to gold or above.

## Accuracy by stratum (final level, exact)

| variant | challenge |
|---|---:|
| rules | 25.0% (8) |
| gemini-risk-v2 | 87.5% (8) |

## Paired comparison against the rules baseline (production fallback)

Per-case rates, paired by case; p-values are sign-flip permutation, Holm-adjusted across all rows.

| comparison | cases | mean diff | 95% CI (bootstrap) | p (Holm) | MDE (80% power) |
|---|---:|---:|---|---:|---:|
| gemini-risk-v2 − rules: exact | 8 | 62.5% | [18.8%, 93.8%] | 0.063 | 67.1% |
| gemini-risk-v2 − rules: under-triage | 8 | -75.0% | [-100.0%, -37.5%] | 0.063 | 53.4% |

## Confusion matrices (final level)

### rules

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **4** | 0 | 0 | 0 |
| **MEDIUM** | 2 | **0** | 0 | 0 |
| **HIGH** | 4 | 0 | **0** | 0 |
| **CRITICAL** | 6 | 0 | 0 | **0** |

### gemini-risk-v2

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **3** | 1 | 0 | 0 |
| **MEDIUM** | 0 | **2** | 0 | 0 |
| **HIGH** | 0 | 0 | **3** | 1 |
| **CRITICAL** | 0 | 0 | 0 | **6** |

## Per case

| case | stratum | gold | floor | rules | gemini-risk-v2 |
|---|---|---|---|---|---|
| rc-dka | challenge | CRITICAL | – | LOW↓, LOW↓ | CRITICAL, CRITICAL |
| rc-asthma-severe | challenge | CRITICAL | – | LOW↓, LOW↓ | CRITICAL, CRITICAL |
| rc-ectopic | challenge | CRITICAL | – | LOW↓, LOW↓ | CRITICAL, CRITICAL |
| rc-pyelonephritis | challenge | HIGH | – | LOW↓, LOW↓ | CRITICAL↑, HIGH |
| rc-tia | challenge | HIGH | – | LOW↓, LOW↓ | HIGH, HIGH |
| rc-gout | challenge | MEDIUM | – | LOW↓, LOW↓ | MEDIUM, MEDIUM |
| rc-negated-bleed | challenge | LOW | – | LOW, LOW | LOW, MEDIUM↑ |
| rc-past-dvt | challenge | LOW | – | LOW, LOW | LOW, LOW |

↓ under-triage, ↑ over-triage.

