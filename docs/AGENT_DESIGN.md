# Agents — Design

**Scope:** the agent platform (`src/lib/agent/core`, `src/lib/agent/shared`) and the two agents built on it: the **risk triage agent** (`src/lib/agent/risk`, the worklist level on every patient) and the **handover agent** (`src/lib/agent/handover`, the AI handover summary on the Glance page).
**Companion documents:** [EVALUATION.md](./EVALUATION.md) (how both are measured), [SECURITY.md](./SECURITY.md) (auth, sessions, PHI), [API_TESTING.zh.md](./API_TESTING.zh.md) (first live-API session), [CLINICAL_HIGHLIGHT_RULES.txt](./CLINICAL_HIGHLIGHT_RULES.txt) (the rule engine the safety floors use), [UPGRADE_PLAN.zh.md](./UPGRADE_PLAN.zh.md) (review findings, plan, roadmap A1–A6).

Both agents follow one pattern: **the model reads the record through narrow, patient-bound tools and submits a structured answer; deterministic code then verifies every citation and applies a safety floor the model cannot lower.** The model adds judgement; it never removes a safety property.

---

## 1. Platform

```
                 ┌──────────────────────── src/lib/agent/core ────────────────────────┐
  agent code ──▶ │ runToolAgent()  on client.beta.messages.toolRunner (Anthropic SDK)  │
                 │   · strict zod tools (defineTool / bindTools)   · terminal tool       │
                 │   · iteration, token and deadline budgets       · one nudge           │
                 │   · outcome taxonomy, metadata-only trace       · SDK retries (3)     │
                 └────────────────────────────────────────────────────────────────────┘
                 ┌──────────────────────── src/lib/agent/shared ──────────────────────┐
                 │ RecordContext (actor + patient bound)  · record tools (glance,      │
                 │ timeline, notes) · EvidenceLedger · citation verification ·          │
                 │ injection tripwire · executeAgent() (AgentRun rows, client factory) │
                 └────────────────────────────────────────────────────────────────────┘
```

### 1.1 The run (`runToolAgent`)

The Anthropic SDK's Tool Runner owns the request → tool calls → tool results cycle and HTTP retries. `runToolAgent` wraps it and decides only **when to stop**, which is where clinical software needs to be strict:

| Concern | Behaviour |
| --- | --- |
| Tools | Defined once as zod schemas (`defineTool`), converted with the SDK's JSON-schema transform and sent with `strict: true`, in a fixed order (part of the cached prefix). Inputs are `safeParse`d again before execution; failures return as `is_error` results the model can correct (`INVALID_INPUT`). |
| Tool errors | Exceptions inside a tool never reach the model as raw text (the SDK would forward `Error: <message>`). They are wrapped in `ToolError` with a code and a safe message: tools raise `ToolInputError` for expected conditions (`INVALID_DATE`, `TOO_MANY_PROPOSALS`, `RESULT_TOO_LARGE`, …); anything else becomes `TOOL_FAILED` / "The tool failed unexpectedly." |
| Terminal tool | Each agent has one terminal tool (`submit_risk_assessment`, `submit_handover_summary`). It is accepted only when called **alone** and with valid input; the run ends before the runner executes anything, so the terminal tool is never "run". A submission written next to other calls was composed before their results existed and is refused (`TERMINAL_NOT_ALONE`). |
| Submit-time check and repair | A terminal tool may define a deterministic `check` (the handover agent checks that every citation verifies). If a schema-valid submission has problems and the run's repair budget (`maxRepairs`, handover default 1) is not spent, the run does not end: the model receives the exact problems ("item 3, citation 1: quote not found word-for-word in that note") as a `SUBMISSION_REPAIR` tool error and resubmits. When the budget is spent, or the run then stops without a better submission, the last valid submission is used and the guardrails decide as before. The validator is never relaxed; repair only gives the model a chance to fix what it would otherwise lose. Each round is a `repair` trace event. |
| Stop conditions | `SUBMITTED`, `NO_SUBMISSION` (after one reminder), `STEP_LIMIT`, `BUDGET_EXCEEDED`, `DEADLINE`, `REFUSED`, `TRUNCATED`, `MODEL_ERROR` (with kind: `rate_limit`, `overloaded`, `auth`, `bad_request`, `server`, `connection`, …), `ABORTED`, `HARNESS_ERROR`. Infrastructure outcomes are kept apart from model behaviour so the evaluation never scores an outage as a wrong answer. |
| Truncation | A turn that stops at `max_tokens` ends the run before its tools execute (a cut-off tool input can parse as a valid partial object). |
| Retries | SDK-managed (`maxRetries: 3`, exponential backoff, `retry-after` honoured). The client's transport is wrapped to record every retried HTTP status as an `http_retry` trace event. |
| Data handling | `thread: false`: the full history is sent each turn and no server-side message thread is kept, which fits zero-data-retention arrangements. Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is on by default and recorded per turn. |
| Caching | System prompt with a cache breakpoint plus top-level automatic caching for the growing conversation. Prompts are static per version (no dates or ids); per-run facts go in the first user message. |
| Trace | Per turn: latency (tool time excluded), stop reason, requested and served model, fallback flag, token usage. Per tool call: name, ok/error code, duration, input/output **sizes**. Never payloads, so the trace holds no PHI. |

Why the SDK Tool Runner and not Managed Agents: clinical data must stay on infrastructure the clinic controls and inside the request/response path we can audit, and Managed Agents is not currently covered by ZDR/HIPAA arrangements. The Tool Runner gives the standard agent loop with the policy hooks above.

### 1.2 Record access (`shared/`)

| Tool | Effect | What the model gets |
| --- | --- | --- |
| `get_glance_cards` | read | Highest-risk highlights (with note ids), open and recently resolved actions, consultation stage |
| `get_timeline` | read | Note metadata only: id, title, time, author role, status, highlight label counts, whether the body is visible to this actor |
| `get_notes` | read | Up to 8 notes in full: redacted body, permitted comments, highlights. Unknown and forbidden ids are both reported as `unavailable` (no existence oracle) |

**Capability scoping instead of parameter checks.** A run is bound to one actor and one patient when it starts (`createRecordContext`). No tool takes a `patient_id`, so a prompt-injected note cannot redirect the agent to another record: there is no interface through which to ask. Every read goes through the existing RBAC-checked accessors.

**Evidence ledger.** Every note body the run actually received is recorded. A citation counts only if its note is in the ledger *and* its quote is a verbatim substring of that note's visible text (case-, whitespace- and typography-insensitive; at least two words). A note id is easy to guess; a verbatim quote is not.

**PHI.** Bodies and excerpts are redacted on write and again on read (`redactPhi`); everything the agents output is re-redacted. The model never receives the patient's name.

### 1.3 Second provider: Gemini through a transport adapter

`src/lib/agent/core/gemini.ts` is a `fetch` implementation for the Anthropic SDK client that answers Messages API requests by calling Google Gemini `generateContent`. Everything above the transport (Tool Runner, tool validation, budgets, outcomes, guardrails, floors, persistence, evaluations) runs unchanged, so the same harness can compare providers.

| Messages API | Gemini |
| --- | --- |
| `system`, `messages` | `systemInstruction`, `contents` (`user` / `model`, adjacent turns merged) |
| `tool_use` / `tool_result` | `functionCall` / `functionResponse` (names resolved from tool_use ids); thought signatures returned with their calls |
| `tools[].input_schema` | `functionDeclarations[].parameters`: `$ref` inlined, unsupported keywords dropped |
| `stop_reason` | function call → `tool_use`; `MAX_TOKENS` → `max_tokens`; safety / blocked → `refusal`; otherwise `end_turn` |
| `usage` | prompt tokens minus cached → input; candidates + thinking tokens → output; cached → cache reads |
| HTTP errors | same status, Anthropic error body, Gemini `RetryInfo` → `retry-after` (SDK retries apply) |

Not mapped: prompt caching breakpoints, `effort`, server-side refusal fallback (Anthropic features). Gemini does not enforce strict tool schemas, so malformed tool inputs are caught by the tool layer and returned as `INVALID_INPUT` for the model to correct. Select it with `NIGHTINGALE_AGENT_CLIENT=gemini` and `GEMINI_API_KEY`; `NIGHTINGALE_GEMINI_MIN_INTERVAL_MS` spaces requests for free-tier rate limits.

A second mode, `NIGHTINGALE_GEMINI_API=openai`, sends the same requests to Gemini's OpenAI-compatible endpoint through `src/lib/agent/core/openai-compat.ts` (Chat Completions: tool calls as `tool_calls`, results as `tool` messages, `effort` as `reasoning_effort`, billed output = total − prompt tokens so thinking is counted). That endpoint accepts the key as `Authorization: Bearer`, which is what a credential-injecting network proxy can supply; the native endpoint only takes `x-goog-api-key`. The adapter is generic Chat Completions, so other OpenAI-compatible providers can be added the same way. **Free-tier prompts may be used by Google to improve its products: synthetic data only, never patient data.**

### 1.4 Persistence and configuration

`executeAgent` creates an `AgentRun` row (agent, actor, prompt version and content hash, requested model), runs the agent and records outcome, served model, fallback, steps, token usage, duration and the trace. `createClientFactory` picks the client: the Anthropic API when `ANTHROPIC_API_KEY` is set, Gemini when `NIGHTINGALE_AGENT_CLIENT=gemini` and `GEMINI_API_KEY` is set, the offline policies when `NIGHTINGALE_AGENT_CLIENT=simulated`, and it refuses otherwise (`AgentNotConfiguredError`). `NIGHTINGALE_AGENTS_ENABLED=false` switches every model call off; rule-based features keep working.

---

## 2. Risk triage agent (roadmap A1)

Every patient on the worklist carries a level (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`), a review window (`ROUTINE` / `WITHIN_24H` / `WITHIN_4H` / `IMMEDIATE`), and the cited reasons for both. It is computed automatically whenever the record changes.

### 2.1 Lifecycle

```
note created / edited / reverted, clinician highlight added, "Reassess" (MANUAL), seed
      │ enqueueRiskAssessment()  — coalesces: at most one PENDING row per patient
      ▼
RiskAssessment (PENDING)  ──scheduleRiskDrain(): after() the HTTP response; or POST /api/agent/risk/drain (cron)
      │ runRiskAssessment(): atomic claim PENDING → RUNNING (no double runs across workers)
      │ input hash of the visible record: unchanged and not MANUAL → SUPERSEDED (no model call)
      ▼
  model available?  ── no ──▶ rule floor only (method "rules")
      │ yes
      ▼
  runToolAgent(risk tools, service account)  ── failed ──▶ rule floor only, run marked FAILED
      │ SUBMITTED
      ▼
  applyRiskGuardrails(): verify drivers · final = max(model, floor) · tighten review · redact
      ▼
RiskAssessment (COMPLETED) + AgentRun + AuditLog   ·  errors: back to PENDING, FAILED after 3 attempts
```

Stale `RUNNING` rows (worker died) return to `PENDING` after 10 minutes. The previous completed assessment stays visible while a new one runs, and the UI says *A new assessment is running…* and polls.

### 2.2 Who the agent is

Triage must not depend on who happened to open the chart, so the agent runs as a per-clinic **service account** with clinician-level visibility (`isServiceAccount`, status `DISABLED`, no usable password: it can never sign in, and it is never shown as anyone's clinician). What viewers see is filtered again: a nurse sees the level and the drivers whose evidence they may open; drivers citing notes they cannot open are counted (`hiddenEvidence`), not shown.

### 2.3 Tools and output

The three read tools of §1.2 and the terminal `submit_risk_assessment`:

```
level, review, summary (≤ 300 chars), confidence (low|medium|high),
drivers: 1–6 × { factor, direction: raises|lowers, citations: 1–3 × { note_id, quote } }
```

The `risk-v1` prompt defines the levels, says to judge the **current** state (latest encounter outweighs older notes; negated, safety-net, historical and resolved mentions are not current findings), and treats note text strictly as data.

### 2.4 The deterministic floor

`computeRiskFloor` reads the same timeline and applies rules to **affirmed** mentions only (the NegEx/ConText engine excludes negated, historical and hypothetical ones), in notes within 7 days of the latest encounter:

| Evidence | Floor |
| --- | --- |
| SpO2 < 90%, BP > 180/110, anaphylaxis, severe respiratory distress | CRITICAL |
| A critical highlight placed by a clinician (human judgement) | HIGH |
| Chest pain, shortness of breath, hyperpyrexia, fever | MEDIUM |

Lexical red-flag symptoms floor at MEDIUM, not HIGH, by measurement: on the demo notes a HIGH floor put 10 of 10 patients at HIGH (safety-net advice such as "we safety-netted chest pain" slips past NegEx), which makes a worklist useless. Whether such a symptom is HIGH or CRITICAL is the model's judgement, with cited reasons.

### 2.5 Guardrails

1. **Drivers** keep only verified citations; a driver with none is dropped (`UNCITED`, `UNREAD_NOTE`, `UNGROUNDED_QUOTE`, …). A `raises` driver whose own quotes negate its factor is dropped (`NEGATION_CONFLICT`). Drivers carrying text addressed to an AI are dropped (`INSTRUCTION_TEXT`).
2. **Final level = max(model level, floor).** The floor can raise, never lower. The UI says *Raised from Medium by safety rules*.
3. **Review window** is never looser than the final level allows (a CRITICAL patient is never "within 24 h").
4. **Unsupported levels** (above LOW with no surviving driver) are kept, since over-triage is the safe direction, but flagged so the UI says so.
5. **Summary** is dropped if it carries injected instructions, and re-redacted.

### 2.6 Human control

Clinicians (not nurses) can override the level with a 5–500 character reason; the override is shown with name and time, audited (`RISK_OVERRIDE`), and sorts the worklist. Any clinical role can request a reassessment (rate-limited to 10 per 10 minutes per user).

---

## 3. Handover agent (roadmap A2)

A nurse or doctor taking over a patient asks for a handover. The agent reads the record, drafts a summary in which every line quotes its source note, may propose follow-up tasks, and submits.

### 3.1 Request path

```
HandoverPanel (Glance)                                   evals/run.ts
  POST /api/patients/:id/handover                               │
        │ session → actor; same-origin check; rate limit (6 / 10 min / actor)
        ▼                                                         ▼
  runHandoverAgent(actor, patientId, options)   ← one entry point for production AND evaluation
        │ RBAC: STAFF / CLINICIAN / ADMIN; patient in the actor's clinic
        ▼
  executeAgent → runToolAgent(record tools + create_followup + submit_handover_summary)
        ▼
  applyGuardrails()  →  AgentRun (summary, guardrail report) · AgentFollowupProposal · AuditLog
```

**Delegation, not a service account.** Unlike triage, a handover is for one reader, so the agent runs with **that user's** permissions: a nurse's run receives no body for an unreleased clinician draft and cannot cite it. A summary inherits the permissions of the role that produced it, so `GET /handover` returns only runs generated by the caller's role in the caller's clinic.

**Writes need a human.** `create_followup` never touches the record. Proposals are stored only when the run succeeds and become `CareAction`s only when a clinician presses *Add to actions*, through the same RBAC, redaction and audit path as a manual entry.

### 3.2 Evidence ids (handover-v5)

With `handover-v5` the record tools run in **evidence mode**: `get_notes` returns each note's visible text (body, then visible comments) as numbered sentences, `{"id": "N2.S3", "text": "…"}`, instead of a body to quote, and a citation is just `{ "evidence_id": "N2.S3" }`. The server resolves the id to the exact sentence text before the guardrails run, so everything downstream (verification, negation checks, display, grading) sees an ordinary verbatim quote.

- **Why:** with free-text quotes, the remaining failures were quotes stitched from non-adjacent sentences or subtly altered (a token glitch, "from1" for "from"). With ids the model never retypes the record, so those failures are impossible by construction.
- **What is still checked:** that the id was issued in this run (ids exist only for notes the run read; aliases follow read order, so they cannot point at unread notes), plus the unchanged checks on the resolved text. An unknown id is `UNKNOWN_EVIDENCE` and goes through the same repair round.
- **What it does not prove:** that the cited sentence supports the statement. That is what coverage and assertion grading, negation-conflict checks and clinicians' review are for.
- Earlier prompt versions keep quote mode; the mode follows the prompt version (`citationModeFor`).

### 3.3 Guardrails

1. **Citation verification** as in §1.2; an item with no surviving citation is rejected.
2. **Negation conflict:** an item that affirms a red flag its own quotes only negate is rejected.
3. **Injected instructions** in statements or quotes are rejected; `create_followup` refuses them too. This is a tripwire; the structural controls are the defence.
4. **Critical floor: critical findings are never downgraded.** Every critical-tier highlight visible to the reader must appear as a critical item. Under-rated items are raised (*Raised from …*), missing ones are injected (*Added by safety rule*).
5. **Re-redaction** of every statement and quote.

**Fail-safe.** If the run fails, the reader still receives the critical floor; the summary is marked degraded.

**Trade-off made explicit.** The floor trusts the rule engine, which over-alerts by design. On perfect answers it still adds ~1.2 false critical items per run on the seed notes (EVALUATION.md); that is the measured price of never silently dropping a red flag, reduced at the source (NegEx, historical and hypothetical rules), not by letting the model argue a flag away.

### 3.4 Prompts

`handover-v1` (short baseline) and `handover-v2` (workflow, exact-quote rules, how to read negation / safety-net advice / history, severity rubric, follow-up policy, data boundary). Each run stores the prompt version and content hash; which prompt is better is measured pairwise (EVALUATION.md §5).

---

## 4. Failure modes and their controls

| Failure | Control | Where it is measured |
| --- | --- | --- |
| Hallucinated fact | Quote verification; rejections visible in the UI | Handover FABRICATION rate; risk rejected drivers |
| Negated finding reported as present | Negation-conflict check; prompt guidance | Handover FABRICATION; risk `negation` / `safety-net` strata |
| Missed red flag | Handover critical floor; risk floor | Critical recall; risk under-triage and floor rescues |
| Patient under-triaged by the model | `final = max(model, floor)`; clinician override | Risk model vs final under-triage, sensitivity ≥ HIGH |
| Context the rules cannot see (sepsis numbers, stroke) | The model, with cited drivers | Risk `context` stratum |
| Prompt injection in a note | Patient-bound tools, human-confirmed writes, instruction tripwire, floor | Handover LEAKAGE; risk `injection` stratum |
| Cross-patient or cross-role leakage | Capability scoping, RBAC accessors, per-viewer evidence filtering | Handover `adv-cross-patient`, `adv-staff-draft`; risk `hiddenEvidence` tests |
| Runaway cost / latency | Iteration limit, token budget, deadline, rate limits, unchanged-input skip | Cost and latency tables |
| Provider outage / 429 / 529 | SDK retries; rule fallback (risk) or degraded summary (handover); queue retries | `errors.jsonl`, `http_retry` events |
| Model refusal | Server-side fallback; `REFUSED` outcome; fallback path | Refusal and fallback counts |

## 5. Operations

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the live agents |
| `NIGHTINGALE_AGENTS_ENABLED` | `true` | `false` switches every model call off (rules keep working) |
| `NIGHTINGALE_AGENT_CLIENT` | `anthropic` | `gemini` runs the agents on Google Gemini (§1.3); `simulated` runs the offline policies (labelled in the UI) |
| `GEMINI_API_KEY` / `NIGHTINGALE_GEMINI_MIN_INTERVAL_MS` | — / 0 | Gemini credentials; request spacing for free-tier limits |
| `NIGHTINGALE_AGENT_MODEL` / `_EFFORT` / `_PROMPT` | `claude-opus-5-5` / `medium` / `handover-v2` | Model configuration (`_PROMPT` applies to the handover agent) |
| `NIGHTINGALE_AGENT_MAX_STEPS` / `_MAX_TOKENS` / `_TOKEN_BUDGET` / `_DEADLINE_MS` | 12 / 16 000 / 400 000 / 180 000 | Run limits (risk caps iterations at 8) |
| `NIGHTINGALE_AGENT_FALLBACKS` | `default` | `off` disables server-side refusal fallback |
| `NIGHTINGALE_AGENT_RATE_LIMIT` | `6/600` | Handover runs per user per window (seconds) |
| `NIGHTINGALE_RISK_AUTORUN` | on | `off` stops draining the risk queue after requests (use the cron endpoint instead) |
| `NIGHTINGALE_CRON_SECRET` | — | Enables `POST /api/agent/risk/drain` with header `x-cron-secret` (≥ 16 chars; 404 when unset) |

Known limits: rate limiters and the Glance cache are in-process (a multi-instance deployment needs a shared store); `after()` drains the risk queue on the instance that handled the write, so a serverless deployment should also call the drain endpoint on a schedule; the gold labels used to evaluate triage are author-labelled, not clinician-verified.
