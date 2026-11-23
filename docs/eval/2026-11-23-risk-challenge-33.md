# Risk triage evaluation

Case set `da3275abc892` · prompts `{"gemini-risk-v2":"risk-v2:c1d863f10dbf"}` · 33 cases (LOW 9, MEDIUM 7, HIGH 8, CRITICAL 9) · 1 rep(s) · evaluation date 2026-11-21T12:00:00.000Z

> Gold levels are hand-labelled by the project author from the note text. They are **not clinician-verified**; treat
> absolute numbers as a regression signal for this harness, not as clinical performance.

## Summary (final level shown on the worklist)

95% intervals are case-level cluster bootstrap (reps of one case resampled together).

| variant | trials | exact | under-triage | severe under | over-triage | sens ≥HIGH | sens CRITICAL | spec LOW | QWK | all reps exact |
|---|---:|---|---|---:|---:|---|---:|---:|---|---:|
| gemini-risk-v2 | 33 | 90.9% [78.8%, 100.0%] | 0.0% [0.0%, 0.0%] | 0.0% | 9.1% | 100.0% [100.0%, 100.0%] | 100.0% | 88.9% | 0.97 [0.92, 1.00] | 90.9% |

## Model level vs. final level (what the deterministic floor adds)

| variant | model exact | model under-triage | final under-triage | floor lifts | floor rescues | model failures (fell back to floor) | unsupported levels | rejected drivers | mean steps | mean cost | mean wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gemini-risk-v2 | 90.9% | 0.0% | 0.0% | 0 | 0 | 0 | 1 | 4 | 3.0 | $0.0030 | 9.60 s |

*Floor lift*: the final level is above the model's. *Floor rescue*: the model under-triaged and the floor brought the final level to gold or above.

## Accuracy by stratum (final level, exact)

| variant | challenge |
|---|---:|
| gemini-risk-v2 | 90.9% (33) |

## Confusion matrices (final level)

### gemini-risk-v2

| gold \ predicted | LOW | MEDIUM | HIGH | CRITICAL |
|---|---:|---:|---:|---:|
| **LOW** | **8** | 1 | 0 | 0 |
| **MEDIUM** | 0 | **7** | 0 | 0 |
| **HIGH** | 0 | 0 | **6** | 2 |
| **CRITICAL** | 0 | 0 | 0 | **9** |

## Per case

| case | stratum | gold | floor | gemini-risk-v2 |
|---|---|---|---|---|
| rc-dka | challenge | CRITICAL | – | CRITICAL |
| rc-asthma-severe | challenge | CRITICAL | – | CRITICAL |
| rc-ectopic | challenge | CRITICAL | – | CRITICAL |
| rc-tia | challenge | HIGH | – | HIGH |
| rc-pyelonephritis | challenge | HIGH | – | CRITICAL↑ |
| rc-gout | challenge | MEDIUM | – | MEDIUM |
| rc-negated-bleed | challenge | LOW | – | MEDIUM↑ |
| rc-past-dvt | challenge | LOW | – | LOW |
| rc-food-anaphylaxis | challenge | CRITICAL | – | CRITICAL |
| rc-severe-hypo | challenge | CRITICAL | – | CRITICAL |
| rc-inferior-mi | challenge | CRITICAL | – | CRITICAL |
| rc-dissection | challenge | CRITICAL | – | CRITICAL |
| rc-paracetamol-overdose | challenge | CRITICAL | – | CRITICAL |
| rc-gi-bleed-anticoag | challenge | CRITICAL | – | CRITICAL |
| rc-elderly-pneumonia | challenge | HIGH | – | CRITICAL↑ |
| rc-post-op-dvt | challenge | HIGH | – | HIGH |
| rc-pre-eclampsia | challenge | HIGH | – | HIGH |
| rc-acute-kidney-injury | challenge | HIGH | – | HIGH |
| rc-toddler-fever | challenge | HIGH | – | HIGH |
| rc-simple-uti | challenge | MEDIUM | – | MEDIUM |
| rc-renal-colic | challenge | HIGH | – | HIGH |
| rc-raised-bp | challenge | MEDIUM | – | MEDIUM |
| rc-poor-glycaemic-control | challenge | MEDIUM | – | MEDIUM |
| rc-iron-deficiency | challenge | MEDIUM | – | MEDIUM |
| rc-mild-cellulitis | challenge | MEDIUM | – | MEDIUM |
| rc-depression-review | challenge | MEDIUM | – | MEDIUM |
| rc-travel-vaccines | challenge | LOW | – | LOW |
| rc-mechanical-back-pain | challenge | LOW | – | LOW |
| rc-thyroid-review | challenge | LOW | – | LOW |
| rc-travel-safety-net | challenge | LOW | – | LOW |
| rc-typical-migraine | challenge | LOW | – | LOW |
| rc-settled-gastroenteritis | challenge | LOW | – | LOW |
| rc-old-mi | challenge | LOW | – | LOW |

↓ under-triage, ↑ over-triage.

