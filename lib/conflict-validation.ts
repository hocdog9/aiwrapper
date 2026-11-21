import type { AnswerComparison } from "./answer-comparison";

export function isValidatedConflict(conflict: AnswerComparison["conflicts"][number]): boolean {
  const review = conflict.validation;
  return review?.version === 1 && [review.property, review.conditions, review.contradiction]
    .every(value => typeof value === "string" && value.trim().length > 0);
}

export function conflictDifference(conflict: AnswerComparison["conflicts"][number]): string {
  return `Wording or interpretation not established as a contradiction: ${conflict.positions.map(position =>
    `${position.evidence.map(e => e.provider).join(", ")}: ${position.claim}`).join("; ")}`;
}
