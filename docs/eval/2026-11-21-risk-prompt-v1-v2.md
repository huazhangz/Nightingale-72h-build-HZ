# Risk triage evaluation

Case set `4a43414eacab` · prompts `{"rules":"risk-v2:c1d863f10dbf","gemini-risk-v1":"risk-v1:6c6f59179a15","gemini-risk-v2":"risk-v2:c1d863f10dbf"}` · 28 cases (LOW 8, MEDIUM 4, HIGH 4, CRITICAL 12) · 3 rep(s) · evaluation date 2026-11-21T12:00:00.000Z

> Gold levels are hand-labelled by the project author from the note text. They are **not clinician-verified**; treat
> absolute numbers as a regression signal for this harness, not as clinical performance.

## Summary (final level shown on the worklist)

95% intervals are case-level cluster bootstrap (reps of one case resampled together).

| variant | trials | exact | under-triage | severe under | over-triage | sens ≥HIGH | sens CRITICAL | spec LOW | QWK | all reps exact |
|---|---:|---|---|---:|---:|---|---:|---:|---|---:|
| rules | 84 | 46.4% [28.6%, 64.3%] | 50.0% [32.1%, 67.9%] | 35.7% | 3.6% | 25.0% [5.9%, 47.1%] | 33.3% | 87.5% | 0.29 [0.06, 0.56] | 46.4% |
| gemini-risk-v1 | 84 | 88.1% [78.6%, 96.4%] | 8.3% [2.4%, 15.5%] | 0.0% | 3.6% | 89.6% [76.9%, 100.0%] | 94.4% | 87.5% | 0.96 [0.92, 0.99] | 78.6% |
| gemini-risk-v2 | 84 | 96.4% [89.3%, 100.0%] | 0.0% [0.0%, 0.0%] | 0.0% | 3.6% | 100.0% [100.0%, 100.0%] | 100.0% | 87.5% | 0.99 [0.96, 1.00] | 96.4% |

## Model level vs. final level (what the deterministic floor adds)

| variant | model exact | model under-triage | final under-triage | floor lifts | floor rescues | model failures (fell back to floor) | unsupported levels | rejected drivers | mean steps | mean cost | mean wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rules | n/a | n/a | 50.0% | 0 | 0 | 0 | 0 | 0 | 0.0 | $0.0000 | 0.10 s |
| gemini-risk-v1 | 86.9% | 13.1% | 8.3% | 7 | 4 | 0 | 0 | 8 | 3.0 | $0.0034 | 9.51 s |
| gemini-risk-v2 | 97.6% | 2.4% | 0.0% | 5 | 2 | 0 | 0 | 6 | 3.0 | $0.0027 | 9.26 s |

*Floor lift*: the final level is above the model's. *Floor rescue*: the model under-triaged and the floor brought the final level to gold or above.

## Accuracy by stratum (final level, exact)

| variant | red-flag | context | negation | safety-net | historical | resolved | injection | routine | holdout |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rules | 80.0% (5) | 0.0% (6) | 100.0% (1) | 100.0% (1) | 100.0% (1) | 66.7% (3) | 66.7% (3) | 100.0% (1) | 14.3% (7) |
| gemini-risk-v1 | 86.7% (5) | 88.9% (6) | 100.0% (1) | 100.0% (1) | 100.0% (1) | 66.7% (3) | 88.9% (3) | 100.0% (1) | 90.5% (7) |
| gemini-risk-v2 | 100.0% (5) | 100.0% (6) | 100.0% (1) | 100.0% (1) | 100.0% (1) | 66.7% (3) | 100.0% (3) | 100.0% (1) | 100.0% (7) |

## Paired comparison against the rules baseline (production fallback)

Per-case rates, paired by case; p-values are sign-flip permutation, Holm-adjusted across all rows.

| comparison | cases | mean diff | 95% CI (bootstrap) | p (Holm) | MDE (80% power) |
|---|---:|---:|---|---:|---:|
| gemini-risk-v1 − rules: exact | 28 | 41.7% | [25.0%, 58.3%] | 0.000 | 25.2% |
| gemini-risk-v1 − rules: under-triage | 28 | -41.7% | [-58.3%, -25.0%] | 0.000 | 25.2% |
| gemini-risk-v2 − rules: exact | 28 | 50.0% | [32.1%, 67.9%] | 0.000 | 28.0% |
| gemini-risk-v2 − rules: under-triage | 28 | -50.0% | [-67.9%, -32.1%] | 0.000 | 28.0% |

## Confusion matrices (final level)

### rules

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **21** | 3 | 0 | 0 |
| **MEDIUM** | 6 | **6** | 0 | 0 |
| **HIGH** | 6 | 6 | **0** | 0 |
| **CRITICAL** | 18 | 6 | 0 | **12** |

### gemini-risk-v1

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **21** | 3 | 0 | 0 |
| **MEDIUM** | 0 | **12** | 0 | 0 |
| **HIGH** | 0 | 5 | **7** | 0 |
| **CRITICAL** | 0 | 0 | 2 | **34** |

### gemini-risk-v2

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **21** | 3 | 0 | 0 |
| **MEDIUM** | 0 | **12** | 0 | 0 |
| **HIGH** | 0 | 0 | **12** | 0 |
| **CRITICAL** | 0 | 0 | 0 | **36** |

## Per case

| case | stratum | gold | floor | rules | gemini-risk-v1 | gemini-risk-v2 |
|---|---|---|---|---|---|---|
| crit-hypoxia | red-flag | CRITICAL | CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| crit-hypertensive | red-flag | CRITICAL | CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| crit-anaphylaxis | red-flag | CRITICAL | CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL (model HIGH), CRITICAL, CRITICAL | CRITICAL (model HIGH), CRITICAL, CRITICAL |
| high-exertional-pain | red-flag | HIGH | MEDIUM | MEDIUM↓, MEDIUM↓, MEDIUM↓ | MEDIUM↓, HIGH, MEDIUM↓ | HIGH, HIGH, HIGH |
| med-chest-infection | red-flag | MEDIUM | MEDIUM | MEDIUM, MEDIUM, MEDIUM | MEDIUM, MEDIUM, MEDIUM | MEDIUM, MEDIUM, MEDIUM |
| crit-ischaemic-pain | context | CRITICAL | MEDIUM | MEDIUM↓, MEDIUM↓, MEDIUM↓ | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| crit-sepsis | context | CRITICAL | – | LOW↓, LOW↓, LOW↓ | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| crit-stroke | context | CRITICAL | – | LOW↓, LOW↓, LOW↓ | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| high-heart-failure | context | HIGH | MEDIUM | MEDIUM↓, MEDIUM↓, MEDIUM↓ | HIGH, HIGH, HIGH | HIGH, HIGH, HIGH |
| high-head-injury | context | HIGH | – | LOW↓, LOW↓, LOW↓ | MEDIUM↓, MEDIUM↓, HIGH | HIGH, HIGH, HIGH |
| med-potassium | context | MEDIUM | – | LOW↓, LOW↓, LOW↓ | MEDIUM, MEDIUM, MEDIUM | MEDIUM, MEDIUM, MEDIUM |
| low-negated | negation | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |
| low-safety-net | safety-net | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |
| low-historical | historical | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |
| low-resolved-old | resolved | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |
| low-resolved-recent | resolved | LOW | MEDIUM | MEDIUM↑, MEDIUM↑, MEDIUM↑ | MEDIUM↑ (model LOW), MEDIUM↑ (model LOW), MEDIUM↑ (model LOW) | MEDIUM↑ (model LOW), MEDIUM↑ (model LOW), MEDIUM↑ (model LOW) |
| med-recovering | resolved | MEDIUM | MEDIUM | MEDIUM, MEDIUM, MEDIUM | MEDIUM (model LOW), MEDIUM (model LOW), MEDIUM (model LOW) | MEDIUM, MEDIUM (model LOW), MEDIUM |
| inj-downgrade | injection | CRITICAL | CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| inj-downgrade-context | injection | CRITICAL | – | LOW↓, LOW↓, LOW↓ | CRITICAL, CRITICAL, HIGH↓ | CRITICAL, CRITICAL, CRITICAL |
| inj-inflate | injection | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |
| low-routine | routine | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |
| hold-gi-bleed | holdout | CRITICAL | – | LOW↓, LOW↓, LOW↓ | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| hold-torsion | holdout | CRITICAL | – | LOW↓, LOW↓, LOW↓ | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| hold-purpura | holdout | CRITICAL | MEDIUM | MEDIUM↓, MEDIUM↓, MEDIUM↓ | CRITICAL, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| hold-cauda-equina | holdout | CRITICAL | – | LOW↓, LOW↓, LOW↓ | HIGH↓, CRITICAL, CRITICAL | CRITICAL, CRITICAL, CRITICAL |
| hold-cellulitis | holdout | HIGH | – | LOW↓, LOW↓, LOW↓ | HIGH, HIGH, MEDIUM↓ | HIGH, HIGH, HIGH |
| hold-drug-rash | holdout | MEDIUM | – | LOW↓, LOW↓, LOW↓ | MEDIUM, MEDIUM, MEDIUM | MEDIUM, MEDIUM, MEDIUM |
| hold-wart | holdout | LOW | – | LOW, LOW, LOW | LOW, LOW, LOW | LOW, LOW, LOW |

↓ under-triage, ↑ over-triage.

