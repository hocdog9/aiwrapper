type Provider = "GPT" | "Gemini" | "Claude";
// Economy defaults among the app's supported choices; explicit user selections remain available.
export const ECONOMY_MODELS: Record<Provider, string> = {
  GPT: "gpt-4o-mini",
  Gemini: "gemini-3.5-flash-lite",
  Claude: "claude-haiku-4-5",
};
export function defaultModelChoices(allowed: Partial<Record<Provider, string[]>>) {
  return Object.fromEntries((Object.keys(ECONOMY_MODELS) as Provider[]).map(provider => {
    const choices = allowed[provider] ?? [];
    return [provider, choices.includes(ECONOMY_MODELS[provider]) ? ECONOMY_MODELS[provider] : choices[0] ?? ECONOMY_MODELS[provider]];
  })) as Record<Provider, string>;
}
