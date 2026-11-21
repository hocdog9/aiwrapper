export const TOPUP_AMOUNT = 420;
export const TOPUP_CURRENCY = "cad";
export const TOPUP_CREDITS = 100;

type TopupSession = {
  id: string;
  mode: string | null;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  metadata: Record<string, string> | null;
  client_reference_id: string | null;
};

/** Only signed Stripe webhook data may be passed here. Never fulfill a browser redirect. */
export function paidTopup(session: TopupSession) {
  if (session.mode !== "payment" || session.metadata?.purchase !== "topup" || session.payment_status !== "paid") return null;
  const userId = session.metadata.userId ?? session.client_reference_id;
  const credits = Number(session.metadata.credits);
  if (!userId || session.amount_total !== TOPUP_AMOUNT || session.currency !== TOPUP_CURRENCY || credits !== TOPUP_CREDITS) {
    throw new Error("Invalid top-up payment.");
  }
  return { p_user_id: userId, p_session_id: session.id, p_credits: credits };
}
