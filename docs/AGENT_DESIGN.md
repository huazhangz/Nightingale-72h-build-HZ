# Handover Agent — Design

**Scope:** the AI handover summary on the Glance page (`src/lib/agent/`), its API, and its safety boundary.
**Companion documents:** [EVALUATION.md](./EVALUATION.md) (how it is measured), [CLINICAL_HIGHLIGHT_RULES.txt](./CLINICAL_HIGHLIGHT_RULES.txt) (the rule engine the safety floor relies on), [UPGRADE_PLAN.zh.md](./UPGRADE_PLAN.zh.md) (plan and roadmap mapping).

A nurse or doctor taking over a patient asks for a handover. An agent reads the record through four tools, drafts a summary in which every line quotes its source note, may propose follow-up tasks, and submits. Deterministic code then verifies every citation, enforces the critical-finding floor and re-redacts the output before anyone sees it.

---

## 1. Request path

```
HandoverPanel (Glance)                                   evals/run.ts
  POST /api/patients/:id/handover                               │
        │ signed session → actor; rate limit (6 / 10 min / actor) │
        ▼                                                         ▼
  runHandoverAgent(actor, patientId, options)   ← the single entry point for production AND evaluation
        │ 1. RBAC: STAFF / CLINICIAN / ADMIN only; patient must be in the actor's clinic
        │ 2. AgentRun row (RUNNING)
        ▼
  runAgentLoop()  src/lib/agent/runtime/loop.ts — hand-written, no framework
        │  model.createMessage(tools + cached system + messages)  ── retries with jittered backoff
        │  stop_reason: tool_use → validate (zod) → execute → ONE user message of tool_results
        │               end_turn → one nudge → NO_SUBMISSION
        │               max_tokens / refusal / pause_turn handled explicitly
        │  limits: max steps · cumulative token budget · wall-clock deadline · caller abort
        ▼
  submit_handover_summary (terminal tool, strict schema)
        ▼
  applyGuardrails()  src/lib/agent/handover/guardrails.ts
        ▼
  AgentRun row (SUCCEEDED/FAILED, usage, metadata-only trace, summary, guardrail report)
  AgentFollowupProposal rows (only for a successful run) · AuditLog (no PHI)
```

## 2. The loop (roadmap project 1)

`runAgentLoop` is the classic tool-calling cycle written out by hand so every decision is visible and testable:

| Concern | Behaviour |
| --- | --- |
| Tool offer | Tool definitions are generated from zod schemas through the SDK's JSON-schema transform and sent with `strict: true`, in a fixed order (they are part of the cached prefix). |
| Validation | The model's arguments are untrusted output: every input is `safeParse`d before execution; failures go back as `is_error` results the model can correct. |
| Execution | Read tools in one turn run concurrently; write tools run after them, sequentially, in call order. All results return in **one** user message, in the order the model emitted the calls. |
| Terminal tool | `submit_handover_summary` ends the run. It is accepted only when called **alone**: a submission written in the same turn as other calls was composed before their results existed. |
| Stop conditions | `SUBMITTED`, `NO_SUBMISSION` (after one nudge), `STEP_LIMIT`, `BUDGET_EXCEEDED`, `DEADLINE`, `REFUSED`, `TRUNCATED`, `MODEL_ERROR`, `ABORTED`, `HARNESS_ERROR` — each a distinct outcome so the evaluation can separate model behaviour from plumbing. |
| Truncation | A turn that stops at `max_tokens` never executes its tools (a cut-off tool input can parse as a valid partial object). |
| Retries | The SDK's own retries are disabled (`maxRetries: 0`); the loop retries 408/409/429/5xx/529 and connection errors with full-jitter exponential backoff, honours `retry-after`, fails fast on other 4xx, and records every attempt in the trace. Backoff sleeps are cancelled by the deadline. |
| History | Assistant turns are appended verbatim (thinking blocks included); the harness is append-only. |
| Caching | The system prompt carries a cache breakpoint (tools + system are the stable prefix) and top-level automatic caching covers the growing conversation. Prompts contain no dates or ids; per-run facts go in the first user message. |
| Model settings | Default `claude-opus-5-5`, `effort: medium`, server-side refusal fallback `fallbacks: "default"`; all configurable (`NIGHTINGALE_AGENT_*`). Opus 5.5 rejects forced `tool_choice`, so the terminal call is requested in the prompt and enforced by the nudge + `NO_SUBMISSION` outcome. |

Why a hand-written loop rather than the SDK tool runner or Managed Agents: the loop must interleave run-specific state (the evidence ledger, the terminal-tool rule, budgets, a metadata-only trace) with every step, and the clinical data must stay on infrastructure the clinic controls. Managed Agents is not currently covered by ZDR/HIPAA arrangements, which rules it out for PHI.

## 3. Tools and the permission boundary

| Tool | Effect | What the model gets |
| --- | --- | --- |
| `get_glance_cards` | read | Highest-risk highlights (with note ids), open and recently resolved actions, consultation stage |
| `get_timeline` | read | Note metadata only: id, title, time, author role, status, highlight label counts, whether the body is visible to this role |
| `get_notes` | read | Up to 8 notes in full: redacted body, permitted comments, highlights. Unknown and forbidden ids are both reported as `unavailable` (no existence oracle) |
| `create_followup` | write (proposal) | Drafts a task tied to a note the run has read; de-duplicated against open actions and earlier proposals |
| `submit_handover_summary` | terminal | Items: category, severity, statement, 1–3 citations (`note_id` + verbatim quote) |

**Capability scoping instead of parameter checks.** The run is bound to one actor and one patient when it starts (`createHandoverContext`). No tool takes a `patient_id`, so a prompt-injected note cannot redirect the agent to another record — there is no interface through which to ask.

**Delegation, not a service account.** Every read goes through the existing RBAC-checked accessors (`getPatientTimeline`, `getGlanceCard`) with the requesting user as actor. The agent sees exactly what that user may see: a nurse's run receives no body for an unreleased clinician draft and cannot cite it.

**PHI.** Bodies and excerpts are redacted on write and again on read by the existing `redactPhi`; summary statements and quotes are re-redacted by the guardrails. The model receives no patient name. The persisted trace holds tool names, sizes, timings and error codes — never payloads.

**Writes need a human.** `create_followup` never touches the record. Proposals are stored only when the run succeeds and become `CareAction`s only when a clinician presses *Add to actions*, which goes through the same `createPatientAction` path (RBAC, redaction, audit) as a manual entry. A proposal can only be decided by the role that generated the run.

**Visibility of past runs.** A summary inherits the permissions of the role that produced it (a clinician's summary may quote clinician drafts), so `GET /handover` returns only runs generated by the caller's role in the caller's clinic.

## 4. Guardrails (post-output, deterministic)

Guardrails run on the model's submission after the loop. None of them depends on the prompt.

1. **Citation verification.** A citation is kept only if its note was read in this run *and* its quote is a verbatim substring of that note's visible text (case-, whitespace- and typography-insensitive; `…` joins ordered fragments; at least two words). An item with no surviving citation is rejected (`UNCITED`, `UNKNOWN_NOTE`, `UNREAD_NOTE`, `UNGROUNDED_QUOTE`, `QUOTE_TOO_SHORT`). A note id is easy to guess; a verbatim quote is not.
2. **Negation conflict.** An item that affirms a red-flag phrase ("shortness of breath at rest") while every mention of that phrase in its own quotes is negated ("denies shortness of breath at rest") is rejected (`NEGATION_CONFLICT`). The same NegEx rules as the highlight engine decide.
3. **Injected instructions.** Items whose statement or quote carries text addressed to an AI are rejected (`INSTRUCTION_TEXT`); `create_followup` refuses such text too. This is a tripwire, not the defence — the structural controls above are.
4. **Critical floor — "critical findings are never downgraded".** Every critical-tier highlight visible to the actor must appear as a critical item. If the model covered it at a lower severity, the item is raised and marked *Raised from …*; if the model left it out, a guardrail item is injected and marked *Added by safety rule*. This is the same invariant the feedback-learning module enforces (`weightDeltaForVerdict` never lowers a critical floor), now applied to generated text.
5. **Re-redaction** of every statement and quote.

**Fail-safe.** If the run fails (no submission, step or budget limit, refusal, model error), the reader still receives the critical floor — the summary is marked degraded and shows only safety-rule findings.

**Trade-off made explicit.** The floor trusts the rule engine, and the rule engine over-alerts by design (spec §2a "safety bias"). On perfect answers the floor still forces ~1.2 false critical items per run on the seed notes (see [EVALUATION.md](./EVALUATION.md)); that is the measured price of never silently dropping a red flag. It is reduced at the source — NegEx, historical and hypothetical context rules — not by letting the model argue a flag away.

## 5. Prompts

Two versioned prompts (`src/lib/agent/handover/prompts.ts`), each identified by a content hash stored with every run:

- `handover-v1` — a short baseline: role, tools, cite everything.
- `handover-v2` — adds a workflow, exact-quote rules, how to read negation / safety-net advice / history, a severity rubric, when to propose follow-ups, and a data boundary for injected text.

Which is better is a measured claim, not a belief: the evaluation compares them pairwise on the same cases (EVALUATION.md §5).

## 6. Failure modes and their controls

| Failure | Control | Where it is measured |
| --- | --- | --- |
| Hallucinated fact | Quote verification; rejection is visible in the UI | FABRICATION rate, citation validity |
| Negated finding reported as present | Negation-conflict check; prompt guidance | FABRICATION (false assertions) |
| Missed red flag | Critical floor injection | Raw critical recall, guardrail injections |
| Red flag under-rated | Critical floor upgrade | SEVERITY_DOWNGRADE, guardrail upgrades |
| Prompt injection in a note | Patient-bound tools, human-confirmed writes, instruction tripwire | LEAKAGE on `adv-prompt-injection` |
| Cross-patient or cross-role leakage | Capability scoping, RBAC accessors, same-role run visibility | LEAKAGE on `adv-cross-patient`, `adv-staff-draft` |
| Runaway cost / latency | Step limit, token budget, deadline, per-actor rate limit | Cost and latency tables |
| Provider outage / 429 | Jittered retries; infrastructure errors never scored as model failures | `errors.jsonl` |
| Model refusal | `fallbacks: "default"`; `REFUSED` outcome; degraded summary | Refusal count, fallback runs |

## 7. Operations

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the live agent |
| `NIGHTINGALE_AGENT_CLIENT` | `anthropic` | `simulated` runs the offline rule policy (labelled in the UI) |
| `NIGHTINGALE_AGENT_MODEL` / `_EFFORT` / `_PROMPT` | `claude-opus-5-5` / `medium` / `handover-v2` | Model configuration |
| `NIGHTINGALE_AGENT_MAX_STEPS` / `_TOKEN_BUDGET` / `_DEADLINE_MS` | 12 / 400 000 / 180 000 | Loop limits |
| `NIGHTINGALE_AGENT_FALLBACKS` | `default` | `off` disables server-side refusal fallback |
| `NIGHTINGALE_AGENT_RATE_LIMIT` | `6/600` | Runs per actor per window (seconds) |
| `NIGHTINGALE_SESSION_SECRET` | random per process outside production | HMAC key for session cookies; required in production |

Known limits: the rate limiter and Glance cache are in-process (a multi-instance deployment needs a shared store); the demo login is not SSO; runs are synchronous HTTP requests (a queue with streamed progress would suit longer records); the rule-engine tier divergence in spec §2c is an open product decision.
