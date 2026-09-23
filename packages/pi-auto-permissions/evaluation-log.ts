import { appendJsonlRecord } from "./jsonl-sidecar.js";
import type { PermissionDecision, ReviewEvidenceRecord } from "./review.js";

export const PROMPT_FEEDBACK_OPTIONS = {
  allowUnnecessary: "Allow — asking was unnecessary",
  allowAppropriate: "Allow — asking was appropriate",
  block: "Block — asking was appropriate",
} as const;

export type PromptEvaluationUserChoice = "allow_unnecessary" | "allow_appropriate" | "block";

export interface PromptChoiceClassification {
  allowsExecution: boolean;
  userChoice?: PromptEvaluationUserChoice;
}

export function permissionPromptOptions(evaluationLoggingEnabled: boolean): string[] {
  return evaluationLoggingEnabled
    ? [
      PROMPT_FEEDBACK_OPTIONS.allowUnnecessary,
      PROMPT_FEEDBACK_OPTIONS.block,
      PROMPT_FEEDBACK_OPTIONS.allowAppropriate,
    ]
    : ["Allow", "Block"];
}

export interface PromptEvaluationRecord {
  version: 2;
  timestamp: string;
  sessionId: string;
  cwd: string;
  tool: string;
  gate: {
    label: string;
    group: string;
  };
  userRequest: string;
  command: string;
  relevantContext: ReviewEvidenceRecord[];
  actualDecision: "ask_user";
  actualReason: string;
  decisionSource: "guardian" | "review_failure";
  userChoice: PromptEvaluationUserChoice;
  expectedDecision: Extract<PermissionDecision, "approve" | "ask_user">;
}

export function classifyPromptChoice(choice: string | undefined): PromptChoiceClassification | undefined {
  if (choice === "Allow") return { allowsExecution: true };
  // Plain "Block" is still live: the logging-disabled prompt offers
  // ["Allow", "Block"]. It carries the same block semantics as the labeled
  // variant so override evidence works in both prompt modes.
  if (choice === "Block") return { allowsExecution: false, userChoice: "block" };
  if (choice === PROMPT_FEEDBACK_OPTIONS.allowUnnecessary) {
    return { allowsExecution: true, userChoice: "allow_unnecessary" };
  }
  if (choice === PROMPT_FEEDBACK_OPTIONS.allowAppropriate) {
    return { allowsExecution: true, userChoice: "allow_appropriate" };
  }
  if (choice === PROMPT_FEEDBACK_OPTIONS.block) {
    return { allowsExecution: false, userChoice: "block" };
  }
  return undefined;
}

export function expectedDecisionForChoice(
  choice: PromptEvaluationRecord["userChoice"],
): PromptEvaluationRecord["expectedDecision"] {
  return choice === "allow_unnecessary" ? "approve" : "ask_user";
}

/** Labeled rows are large (~51 KB), so this sidecar gets a bigger cap than the others. */
export const EVALUATION_LOG_ROTATE_BYTES = 64 * 1024 * 1024;

export function appendPromptEvaluation(path: string, record: PromptEvaluationRecord): void {
  appendJsonlRecord(path, record, EVALUATION_LOG_ROTATE_BYTES);
}
