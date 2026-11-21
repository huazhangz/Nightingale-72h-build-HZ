import { defineTool, type AgentTool } from "../core/tool";
import type { RecordContext } from "../shared/record-context";
import { RECORD_TOOL_NAMES, recordTools } from "../shared/record-tools";
import { RiskSubmission } from "./schema";

export const RISK_TOOL_NAMES = { ...RECORD_TOOL_NAMES, submit: "submit_risk_assessment" } as const;

const submitRisk = defineTool<RecordContext, RiskSubmission>({
  name: RISK_TOOL_NAMES.submit,
  description:
    "Submit the patient's current risk level and end the session. Call it exactly once, alone, after reading " +
    "the most recent notes. Include the review window, a one- or two-sentence summary, your confidence, and " +
    "1-6 drivers; each driver cites the note_id and an exact quote from that note.",
  terminal: true,
  schema: RiskSubmission,
  async run() {
    throw new Error("Terminal tools are never executed");
  },
});

/** The risk agent only reads; it has no write tools. */
export const RISK_TOOLS: AgentTool<RecordContext>[] = [...recordTools<RecordContext>(), submitRisk];
