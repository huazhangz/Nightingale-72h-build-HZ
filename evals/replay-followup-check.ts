/**
 * Offline replay of the handover-v6 follow-up check against recorded live transcripts.
 *
 * For every saved live run (evals/results/<run>/transcripts/<variant>/<case>/rep-N.json) this
 * rebuilds what the agent had seen at its final submission (notes read, open actions, follow-ups
 * attempted) and asks: would followupProblems() have sent the submission back, and about which
 * sentence? No model is called. It measures, on real model behaviour:
 *
 *   - recall on the failure mode: runs that missed an expected follow-up and would have been asked;
 *   - false prompts: runs where proposing anything is a misuse ("none") and the check would ask.
 *
 * What it cannot measure is what the model does after being asked; that needs a live run
 * (preset gemini-v6).
 *
 *   npm run eval:replay-followups                      # every saved run
 *   npm run eval:replay-followups -- handover-challenge-50
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { followupProblems, type HandoverContext } from "../src/lib/agent/handover/tools";
import { EvidenceLedger } from "../src/lib/agent/shared/record-context";
import { selectCases } from "./cases";

const ALL_CASES = selectCases("all");

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Transcript = {
  case: string;
  variant: string;
  rep: number;
  expectations?: { followups: { expected: "none" | "some" | "any" } };
  messages: Array<{ role: string; content: string | Block[] }>;
  grade?: { checks?: Array<{ name: string; passed: boolean }> };
};

const RESULTS = path.resolve("evals/results");
// Handover variants only (gemini-v4, claude-v2, ...); risk-agent runs ("gemini-risk-v2") use other tools.
const LIVE_VARIANT = /^(gemini|claude)(-lite)?-v\d/;

function transcriptFiles(runs: string[]): string[] {
  const files: string[] = [];
  for (const run of runs) {
    const root = path.join(RESULTS, run, "transcripts");
    let variants: string[] = [];
    try {
      variants = readdirSync(root).filter((name) => LIVE_VARIANT.test(name));
    } catch {
      continue;
    }
    for (const variant of variants) {
      for (const caseId of readdirSync(path.join(root, variant))) {
        const dir = path.join(root, variant, caseId);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
          files.push(path.join(dir, file));
        }
      }
    }
  }
  return files;
}

function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** The agent's view at its final submission, rebuilt from the recorded tool calls and results. */
export function contextFromTranscript(transcript: Transcript): HandoverContext {
  const ledger = new EvidenceLedger();
  const calls = new Map<string, Block>();
  const openActions: string[] = [];
  const attempts: string[] = [];
  for (const message of transcript.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) {
        calls.set(block.id, block);
        if (block.name === "create_followup" && typeof block.input?.text === "string") attempts.push(block.input.text);
      }
      if (block.type !== "tool_result" || block.is_error || !block.tool_use_id) continue;
      const call = calls.get(block.tool_use_id);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(textOf(block.content)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (call?.name === "get_glance_cards") {
        for (const action of (parsed.unresolved_actions as Array<{ text?: string }> | undefined) ?? []) {
          if (action.text) openActions.push(action.text);
        }
      }
      if (call?.name === "get_notes") {
        for (const note of (parsed.notes as Array<{ note_id: string; title?: string; body?: string | null; evidence?: Array<{ text: string }> }> | undefined) ?? []) {
          const body = note.body ?? (note.evidence ? note.evidence.map((segment) => segment.text).join(" ") : null);
          ledger.recordRead({ noteId: note.note_id, title: note.title ?? "", encounterAt: "", authorRole: "", body, comments: [] } as never);
        }
      }
    }
  }
  return {
    ledger,
    proposals: [],
    followupAttempts: attempts,
    followupCheck: { openActions, asked: false },
  } as unknown as HandoverContext;
}

function main(): void {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const runs = requested.length > 0 ? requested : readdirSync(RESULTS).filter((name) => statSync(path.join(RESULTS, name)).isDirectory());
  const seen = new Set<string>();
  const tally = {
    some: { runs: 0, missed: 0, missedAsked: 0, hitAsked: 0 },
    none: { runs: 0, asked: 0 },
    any: { runs: 0, asked: 0 },
  };
  const examples: string[] = [];
  let unsubmitted = 0;
  for (const file of transcriptFiles(runs)) {
    const transcript = JSON.parse(readFileSync(file, "utf8")) as Transcript;
    // Regraded copies duplicate the original runs; count each (variant, case, rep, run) once by content.
    const key = `${transcript.variant}|${transcript.case}|${transcript.rep}|${JSON.stringify(transcript.messages).length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The check runs at submission: a run that never submitted (budget, malformed calls) never reaches it.
    const submitted = transcript.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use" && block.name === "submit_handover_summary"),
    );
    if (!submitted) {
      unsubmitted += 1;
      continue;
    }
    const problems = followupProblems(contextFromTranscript(transcript));
    const expected = transcript.expectations?.followups.expected ?? ALL_CASES.find((item) => item.id === transcript.case)?.expect.followups.expected;
    if (!expected) continue;
    if (expected === "some") {
      const missed = transcript.grade?.checks?.some((check) => check.name === "expected_followup" && !check.passed) ?? false;
      tally.some.runs += 1;
      if (missed) {
        tally.some.missed += 1;
        if (problems.length > 0) tally.some.missedAsked += 1;
      } else if (problems.length > 0) {
        tally.some.hitAsked += 1;
      }
      if (missed || problems.length > 0) examples.push(`${missed ? "MISSED" : "ASKED-ALTHOUGH-PROPOSED"} ${transcript.variant} ${transcript.case} rep${transcript.rep}: ${problems.length ? problems[0]!.slice(0, 150) : "(check silent)"}`);
    } else {
      tally[expected].runs += 1;
      if (problems.length > 0) {
        tally[expected].asked += 1;
        if (expected === "none") examples.push(`FALSE PROMPT ${transcript.variant} ${transcript.case} rep${transcript.rep}: ${problems[0]!.slice(0, 150)}`);
      }
    }
  }
  console.log(`Replayed ${seen.size - unsubmitted} submitted live transcripts from ${runs.length} result folders (${unsubmitted} runs without a submission skipped).`);
  console.log(`expected "some": ${tally.some.runs} runs, ${tally.some.missed} missed the follow-up; the v6 check would ask in ${tally.some.missedAsked}/${tally.some.missed} misses (and in ${tally.some.hitAsked} runs that already proposed one).`);
  console.log(`expected "none": ${tally.none.runs} runs; the check would ask in ${tally.none.asked} (false prompts).`);
  console.log(`expected "any":  ${tally.any.runs} runs; the check would ask in ${tally.any.asked}.`);
  for (const line of examples) console.log(`  ${line}`);
}

main();
