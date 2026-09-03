import { chmodSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionDecision, ReviewEvidenceRecord } from "./review.js";

export const PROMPT_FEEDBACK_OPTIONS = {
  allowUnnecessary: "Allow — asking was unnecessary",
  allowAppropriate: "Allow — asking was appropriate",
  block: "Block — asking was appropriate",
  allowStanding: "Allow and stop asking about comparable commands",
} as const;

export type PromptEvaluationUserChoice = "allow_unnecessary" | "allow_appropriate" | "block";

export interface PromptChoiceClassification {
  allowsExecution: boolean;
  userChoice?: PromptEvaluationUserChoice;
  standingApproval?: boolean;
}

export function shouldOfferStandingApproval(
  decisionSource: "guardian" | "review_failure",
  standingApprovalsEnabled: boolean,
): boolean {
  return decisionSource === "guardian" && standingApprovalsEnabled;
}

export function permissionPromptOptions(
  evaluationLoggingEnabled: boolean,
  offerStandingApproval = false,
): string[] {
  const options = evaluationLoggingEnabled
    ? [
      PROMPT_FEEDBACK_OPTIONS.allowUnnecessary,
      PROMPT_FEEDBACK_OPTIONS.block,
      PROMPT_FEEDBACK_OPTIONS.allowAppropriate,
    ]
    : ["Allow", "Block"];
  if (offerStandingApproval) options.push(PROMPT_FEEDBACK_OPTIONS.allowStanding);
  return options;
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

/**
 * A prefilter SAFE approval, recorded so false negatives are measurable: no
 * prompt opened, so there is no user label yet — the record carries the
 * command and compact evidence for offline labelling against the same
 * criteria as prompted records.
 */
interface PrefilterEvaluationRecord {
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
  actualDecision: "approve";
  actualReason: "prefilter";
  decisionSource: "prefilter";
}

type EvaluationRecord = PromptEvaluationRecord | PrefilterEvaluationRecord;

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
  if (choice === PROMPT_FEEDBACK_OPTIONS.allowStanding) {
    return { allowsExecution: true, userChoice: "allow_unnecessary", standingApproval: true };
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

export function appendPromptEvaluation(path: string, record: EvaluationRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
