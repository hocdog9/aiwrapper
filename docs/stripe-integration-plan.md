# Stripe Billing integration: Merune

Status: preliminary review based on the installed Stripe best-practices skill and official documentation. This is **not** output from `stripe_implementation_planner`: the newly installed plugin's MCP tools are not exposed in the current session. Run that tool once connected before finalizing this plan.

## Product

Merune compares AI-provider responses. Free includes 10 requests; Premium includes 500 per month. Guests can use Free, but purchasing Premium requires a permanent Supabase account. Price and currency are pending the owner's decision. Use a Stripe sandbox for initial setup and validation.

Use Stripe Billing with hosted Checkout Sessions in subscription mode, one monthly recurring Premium Price, and Customer Portal for payment details and cancellation. Keep the internal request ledger in Supabase; this is a fixed monthly allowance, not Stripe metered usage. Refunds of internal request credits are unrelated to refunds of Stripe payments.

## Existing integration review

Already present:

- Authenticated checkout and portal routes; anonymous users cannot purchase.
- Server-configured Price ID and subscription metadata linking the Supabase user.
- Webhook signature verification against the raw request body.
- Event claiming and retry handling in Supabase.
- Entitlements updated by webhooks rather than the checkout redirect.

Improvements to implement and verify before live payments:

1. **Duplicate checkout protection:** checkout currently uses `Date.now()` in its idempotency key, so each retry can create a new session. Customer creation has no idempotency key. Persist/reuse an active checkout attempt per account and use stable operation keys. Test concurrent clicks and multiple open checkout tabs.
2. **Subscription reconciliation:** subscription snapshots are applied in arrival order. Retrieve authoritative subscription state and serialize entitlement changes to prevent stale events from restoring canceled subscriptions or overwriting newer state.
3. **Paid renewals:** add explicit `invoice.paid` reconciliation. Grant/reset paid allowances only for the intended paid period and active subscription. The current read-then-upsert can race with request charges or another webhook; move changes into a transactional RPC that locks the billing row.
4. **Validate prices:** derive Premium from the configured Stripe Price rather than relying solely on `metadata.planId`. Verify the subscription's customer and user mapping.
5. **Cancellation and payment recovery:** define end-of-period cancellation, delinquency, and Free reset behavior; test failed invoices followed by successful recovery. Avoid restoring a paid allowance from stale events.
6. **Configuration:** validate sandbox/live consistency, monthly recurring price, public HTTPS app URL, webhook API version compatibility, portal settings, and enabled payment methods.

## Setup after credentials are available

- Confirm the installed SDK/API version against current Stripe releases before changing dependencies or webhook API versions.
- Read `BILLING_SECRET_KEY` only from `.env.local` or deployment secrets; never print it or pass it in shell arguments.
- Inspect sandbox products and prices before creating duplicates.
- Create/reuse Merune Premium and its monthly Price after price and currency are specified.
- Save `BILLING_PREMIUM_PRICE_ID`, `BILLING_WEBHOOK_SECRET`, and `APP_URL` securely.
- Configure the customer portal and a snapshot webhook at `/api/billing/webhook`.
- Include checkout completion, subscription lifecycle events, `invoice.paid`, and `invoice.payment_failed` after their handlers are implemented.
- Keep sandbox and live credentials, prices, webhook secrets, and test entitlement data separate. Do not run test purchases against live customer billing records.

## Verification

Test first purchase, duplicate clicks, webhook redelivery, out-of-order events, renewal, failed payment and recovery, cancellation, unauthorized checkout, portal access, and monthly allowance resets while chat requests are in flight. Confirm malformed signatures are rejected and checkout redirects cannot grant Premium. Verify the app displays the actual price/currency before redirecting to payment.

## Missing inputs

- Stripe planner MCP connection.
- Sandbox secret key (local `BILLING_SECRET_KEY` is currently empty).
- Premium monthly price and currency.
- Deployment URL for `APP_URL` and the webhook endpoint.

## Sources

- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe subscription integration design](https://docs.stripe.com/billing/subscriptions/designing-integration)

## Sandbox configuration completed — November 14, 2026

Verified through Stripe's API:

- Premium: CA$9.99/month, Price `price_1UaGs2GZBGrNJ51pVSgdfonS`.
- Default portal `bpc_1UbmV2GZBGrNJ51pDvXC0Njh`: card updates and invoices enabled, cancellation at period end, subscription updates disabled.
- Enabled webhook `we_1UbmctGZBGrNJ51pFSXfozcC` at `https://aiwrapper-five.vercel.app/api/billing/webhook`, using the installed SDK's API version and the five currently implemented event types.
- Local `APP_URL` and `BILLING_WEBHOOK_SECRET` saved alongside the sandbox secret key and Price ID. Secrets are not recorded in this document.

Remaining deployment work: copy the four local billing/app variables into Vercel Production, redeploy, then complete a sandbox checkout while signed into the app and verify Premium entitlement and portal cancellation. Hosted webhook delivery and a full purchase have not yet been verified. This is sandbox setup only; the integration improvements above remain relevant before accepting real payments.
