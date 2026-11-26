export type BillingInterval = "month" | "year";
export const PREMIUM_PRICES = {
  month: { amount: 690, label: "CA$6.90 / month" },
  year: { amount: 6900, label: "CA$69 / year" },
} as const;
export function premiumPriceId(interval: BillingInterval): string | undefined {
  return interval === "year" ? process.env.BILLING_PREMIUM_ANNUAL_PRICE_ID
    : process.env.BILLING_PREMIUM_MONTHLY_PRICE_ID || process.env.BILLING_PREMIUM_PRICE_ID;
}
export function validPremiumPrice(price: { active: boolean; currency: string; unit_amount: number | null; recurring: { interval: string; interval_count: number } | null }, interval: BillingInterval): boolean {
  return price.active && price.currency === "cad" && price.unit_amount === PREMIUM_PRICES[interval].amount &&
    price.recurring?.interval === interval && price.recurring.interval_count === 1;
}
