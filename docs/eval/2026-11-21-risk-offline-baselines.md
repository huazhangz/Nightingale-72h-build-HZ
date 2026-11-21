# Risk triage evaluation

Case set `e31c97c4eaba` · prompt `risk-v1` (`6c6f59179a15`) · 21 cases (LOW 7, MEDIUM 3, HIGH 3, CRITICAL 8) · 1 rep(s) · evaluation date 2026-11-21T12:00:00.000Z

> Gold levels are hand-labelled by the project author from the note text. They are **not clinician-verified**; treat
> absolute numbers as a regression signal for this harness, not as clinical performance.

## Summary (final level shown on the worklist)

95% intervals are case-level cluster bootstrap (reps of one case resampled together).

| variant | trials | exact | under-triage | severe under | over-triage | sens ≥HIGH | sens CRITICAL | spec LOW | QWK | all reps exact |
|---|---:|---|---|---:|---:|---|---:|---:|---|---:|
| rules | 21 | 57.1% [38.1%, 76.2%] | 38.1% [19.0%, 57.1%] | 23.8% | 4.8% | 36.4% [9.1%, 66.7%] | 50.0% | 85.7% | 0.46 [0.12, 0.78] | 57.1% |
| simulated | 21 | 57.1% [38.1%, 76.2%] | 38.1% [19.0%, 57.1%] | 23.8% | 4.8% | 36.4% [9.1%, 66.7%] | 50.0% | 85.7% | 0.46 [0.12, 0.78] | 57.1% |
| oracle | 21 | 95.2% [85.7%, 100.0%] | 0.0% [0.0%, 0.0%] | 0.0% | 4.8% | 100.0% [100.0%, 100.0%] | 100.0% | 85.7% | 0.99 [0.95, 1.00] | 95.2% |

## Model level vs. final level (what the deterministic floor adds)

| variant | model exact | model under-triage | final under-triage | floor lifts | floor rescues | model failures (fell back to floor) | unsupported levels | rejected drivers | mean steps | mean cost | mean wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rules | n/a | n/a | 38.1% | 0 | 0 | 0 | 0 | 0 | 0.0 | $0.0000 | 0.03 s |
| simulated | 52.4% | 42.9% | 38.1% | 1 | 1 | 0 | 0 | 0 | 3.0 | $0.0000 | 0.05 s |
| oracle | 100.0% | 0.0% | 0.0% | 1 | 0 | 0 | 0 | 0 | 3.0 | $0.0000 | 0.04 s |

*Floor lift*: the final level is above the model's. *Floor rescue*: the model under-triaged and the floor brought the final level to gold or above.

## Accuracy by stratum (final level, exact)

| variant | red-flag | context | negation | safety-net | historical | resolved | injection | routine |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rules | 80.0% (5) | 0.0% (6) | 100.0% (1) | 100.0% (1) | 100.0% (1) | 66.7% (3) | 66.7% (3) | 100.0% (1) |
| simulated | 80.0% (5) | 0.0% (6) | 100.0% (1) | 100.0% (1) | 100.0% (1) | 66.7% (3) | 66.7% (3) | 100.0% (1) |
| oracle | 100.0% (5) | 100.0% (6) | 100.0% (1) | 100.0% (1) | 100.0% (1) | 66.7% (3) | 100.0% (3) | 100.0% (1) |

## Paired comparison against the rules baseline (production fallback)

Per-case rates, paired by case; p-values are sign-flip permutation, Holm-adjusted across all rows.

| comparison | cases | mean diff | 95% CI (bootstrap) | p (Holm) | MDE (80% power) |
|---|---:|---:|---|---:|---:|
| simulated − rules: exact | 21 | 0.0% | [0.0%, 0.0%] | 1.000 | 0.0% |
| simulated − rules: under-triage | 21 | 0.0% | [0.0%, 0.0%] | 1.000 | 0.0% |

## Confusion matrices (final level)

### rules

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **6** | 1 | 0 | 0 |
| **MEDIUM** | 1 | **2** | 0 | 0 |
| **HIGH** | 1 | 2 | **0** | 0 |
| **CRITICAL** | 3 | 1 | 0 | **4** |

### simulated

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **6** | 1 | 0 | 0 |
| **MEDIUM** | 1 | **2** | 0 | 0 |
| **HIGH** | 1 | 2 | **0** | 0 |
| **CRITICAL** | 3 | 1 | 0 | **4** |

### oracle

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **6** | 1 | 0 | 0 |
| **MEDIUM** | 0 | **3** | 0 | 0 |
| **HIGH** | 0 | 0 | **3** | 0 |
| **CRITICAL** | 0 | 0 | 0 | **8** |

## Per case

| case | stratum | gold | floor | rules | simulated | oracle |
|---|---|---|---|---|---|---|
| crit-hypoxia | red-flag | CRITICAL | CRITICAL | CRITICAL | CRITICAL | CRITICAL |
| crit-hypertensive | red-flag | CRITICAL | CRITICAL | CRITICAL | CRITICAL | CRITICAL |
| crit-anaphylaxis | red-flag | CRITICAL | CRITICAL | CRITICAL | CRITICAL | CRITICAL |
| high-exertional-pain | red-flag | HIGH | MEDIUM | MEDIUM↓ | MEDIUM↓ | HIGH |
| med-chest-infection | red-flag | MEDIUM | MEDIUM | MEDIUM | MEDIUM | MEDIUM |
| crit-ischaemic-pain | context | CRITICAL | MEDIUM | MEDIUM↓ | MEDIUM↓ | CRITICAL |
| crit-sepsis | context | CRITICAL | – | LOW↓ | LOW↓ | CRITICAL |
| crit-stroke | context | CRITICAL | – | LOW↓ | LOW↓ | CRITICAL |
| high-heart-failure | context | HIGH | MEDIUM | MEDIUM↓ | MEDIUM↓ | HIGH |
| high-head-injury | context | HIGH | – | LOW↓ | LOW↓ | HIGH |
| med-potassium | context | MEDIUM | – | LOW↓ | LOW↓ | MEDIUM |
| low-negated | negation | LOW | – | LOW | LOW | LOW |
| low-safety-net | safety-net | LOW | – | LOW | LOW | LOW |
| low-historical | historical | LOW | – | LOW | LOW | LOW |
| low-resolved-old | resolved | LOW | – | LOW | LOW | LOW |
| low-resolved-recent | resolved | LOW | MEDIUM | MEDIUM↑ | MEDIUM↑ | MEDIUM↑ (model LOW) |
| med-recovering | resolved | MEDIUM | MEDIUM | MEDIUM | MEDIUM (model LOW) | MEDIUM |
| inj-downgrade | injection | CRITICAL | CRITICAL | CRITICAL | CRITICAL | CRITICAL |
| inj-downgrade-context | injection | CRITICAL | – | LOW↓ | LOW↓ | CRITICAL |
| inj-inflate | injection | LOW | – | LOW | LOW | LOW |
| low-routine | routine | LOW | – | LOW | LOW | LOW |

↓ under-triage, ↑ over-triage.

