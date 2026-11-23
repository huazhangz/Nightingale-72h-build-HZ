# handover-v6 follow-up check — offline validation (2026-11-23)

No model was called. Commands and raw output below; analysis in [EVALUATION.md §7.6](../EVALUATION.md).

## 1. Replay against recorded live Gemini transcripts

```bash
npm run eval:replay-followups
```

```
Replayed 479 submitted live transcripts from 24 result folders (41 runs without a submission skipped).
expected "some": 20 runs, 6 missed the follow-up; the v6 check would ask in 5/6 misses (and in 0 runs that already proposed one).
expected "none": 107 runs; the check would ask in 0 (false prompts).
expected "any":  352 runs; the check would ask in 9.
  MISSED gemini-v4-repair ch-incidental-finding rep1: follow-up check: note cmwt0wq5c004u7duel3muwix5 documents an outstanding action ("Repeat CT in six months has been requested.") with no follow-up prop
  MISSED gemini-v4-repair ch-pending-biopsy rep1: follow-up check: note cmwt0wq3900107duec3hl4ioj documents an outstanding action ("Punch biopsy taken today and histology is pending.") with no follow-
  MISSED gemini-v1 adv-pending-test rep1: (check silent)
  MISSED gemini-v1 adv-pending-test rep2: follow-up check: note cmwqtp5h9009j7dkrli4mrgae documents an outstanding action ("HbA1c ordered today; result pending.") with no follow-up proposed. I
  MISSED gemini-v2 adv-pending-test rep2: follow-up check: note cmwqvjt4e009j7dp540y915r0 documents an outstanding action ("HbA1c ordered today; result pending.") with no follow-up proposed. I
  MISSED gemini-v5 adv-pending-test rep2: follow-up check: note cmwr3phc6009j7d1xglic9mfj documents an outstanding action ("HbA1c ordered today; result pending.") with no follow-up proposed. I
```

## 2. Scripted policies on all 50 cases

```bash
npm run eval -- --variants skip-followups-v4,skip-followups-v6,rules-v6,oracle-v6 --cases all --reps 1 --out evals/results/followup-v6-offline-2
```

| Variant | Prompt | Expected follow-up proposed (3 cases) | No unwarranted follow-up (6 cases) | Runs with a repair round | pass@1 (all checks) |
| --- | --- | ---: | ---: | ---: | ---: |
| skip-followups-v4 | handover-v4 | 0/3 | 6/6 | 0 | 14% |
| skip-followups-v6 | handover-v6 | 3/3 | 6/6 | 6 | 14% |
| rules-v6 | handover-v6 | 3/3 | 4/6 | 0 | 12% |
| oracle-v6 | handover-v6 | 3/3 | 6/6 | 3 | 100% |
| rules | handover-v2 | 3/3 | 4/6 | 0 | 12% |
| oracle | handover-v2 | 3/3 | 6/6 | 0 | 100% |
| null | handover-v2 | 0/3 | 6/6 | 0 | 2% |

The rule policies fail most cases on coverage by design (they do not read notes for meaning); the follow-up columns isolate the behaviour this change targets.
