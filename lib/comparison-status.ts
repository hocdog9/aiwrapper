import type { AnswerComparison } from "./answer-comparison";

type ResultStatus = {
  responses: Array<{ provider: string }>;
  errors?: Array<{ provider: string }>;
  attemptedProviderCount?: number;
  comparison?: AnswerComparison;
  summary: string;
};

function conflictStatus(comparison?: AnswerComparison): string {
  if (!comparison) return "Comparison unavailable";
  const children = comparison.kind === "multi_question" ? comparison.questions?.map(q => q.comparison) ?? [] : [];
  const incomplete = Boolean(comparison.issues?.length) || children.some(c => conflictStatus(c).includes("incomplete")) ||
    (comparison.kind === "multi_question" && !children.length);
  const conflicts = comparison.conflicts.length > 0 || children.some(c => c.conflicts.length > 0);
  if (incomplete) return conflicts ? "Explicit conflicts found · Conflict check incomplete" : "Conflict check incomplete";
  return conflicts ? "Explicit conflicts found" : "No explicit conflicts found";
}

export function comparisonStatus(result: ResultStatus): string {
  const responded = new Set(result.responses.map(r => r.provider)).size;
  // Older saved results lack an attempted count. Only original-provider errors
  // belong in the denominator; synthesis retries are not additional models.
  const knownProviders = new Set(["GPT", "Gemini", "Claude"]);
  const inferred = new Set([
    ...result.responses.map(r => r.provider),
    ...(result.errors ?? []).filter(e => knownProviders.has(e.provider)).map(e => e.provider),
  ]).size;
  const attempted = Math.max(responded, result.attemptedProviderCount ?? inferred);
  const count = `${responded} of ${attempted} models responded`;
  if (responded === 1) return `${count} · Single-model answer; no comparison`;
  const choice = result.comparison?.kind === "multiple_choice" ? ` · ${result.summary}` : "";
  return `${count}${choice} · ${conflictStatus(result.comparison)}`;
}
