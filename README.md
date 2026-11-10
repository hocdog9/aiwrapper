This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Consensus Billing and Provider Credentials

Provider calls run through authenticated Next.js route handlers. New accounts use Managed mode and the server-only `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY` variables. Managed requests reserve one plan credit atomically, enforce per-user rate/concurrency limits, record provider usage, and refund the credit if fewer than the configured minimum providers succeed.

BYOK is opt-in. Keys are validated and encrypted with AES-256-GCM before being stored in Supabase. The browser receives only a masked suffix. Existing plaintext keys in `api_profiles.settings` are removed by the migration below; users must re-enter their BYOK keys afterwards. No automatic plaintext-to-ciphertext migration is performed.

### Setup

1. Copy `.env.example` to `.env.local` and configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. Set `SUPABASE_SERVICE_ROLE_KEY` server-side. Never use a `NEXT_PUBLIC_` prefix for it.
3. Generate a 32-byte encryption key with `openssl rand -base64 32` and set it as server-only `BYOK_ENCRYPTION_KEY`. Keep the same key across deployments; changing it makes stored BYOK credentials undecryptable.
4. Configure the managed provider secrets server-side if you intend to offer Managed mode. They are not returned to clients.
5. In the Supabase SQL Editor, run `supabase/schema.sql`, then `supabase/managed_billing_byok_migration.sql`. The latter initializes Free entitlements, removes existing plaintext profile keys, enforces unique profile names, and creates credit/rate-limit RPCs. Re-enter BYOK keys after running it.
6. Run `npm install`, `npm run check`, `npm test`, and `npm run build`.

### Stripe

Set `BILLING_SECRET_KEY`, `BILLING_BASIC_PRICE_ID`, `BILLING_PLUS_PRICE_ID`, `BILLING_WEBHOOK_SECRET`, and `APP_URL` in the deployment secret manager. Create recurring Basic and Plus prices in Stripe. Configure a webhook to `https://<your-app-host>/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`.

Stripe webhook events, not checkout redirects, update entitlements. Replace the placeholder plan allowances in `plan_catalog` through an intentional database migration when changing product policy. Free currently includes 10 requests/month; Basic 100 and Plus 500. Plan price IDs and USD prices are controlled by Stripe.

Managed model access is controlled by `plan_catalog.allowed_models`, shaped as provider-name keys mapping to model-ID arrays, for example `{"GPT":["gpt-4o-mini"],"Gemini":["gemini-3.8-flash"],"Claude":["claude-3-5-sonnet-20241022"]}`. An empty provider list falls back to that provider's configured server model. Configure model IDs intentionally for each plan; users cannot invoke an arbitrary provider model outside the plan allowlist. BYOK mode instead lists models available to the user's validated keys.

### Pricing and secrets

`MODEL_PRICING_JSON` is optional and accepts provider/model rates as integer USD micros per million input/output tokens, with an optional cached-input rate. Do not set guessed prices. Until intended current provider prices are entered, token usage is recorded but estimated cost remains unavailable. Cached-token costs are also unavailable unless a cached rate is explicitly configured.

All secrets in `.env.example` without a `NEXT_PUBLIC_` prefix are server-only. Do not commit `.env.local`. If a provider secret was ever committed, rotate it in that provider’s dashboard. `SUPABASE_SERVICE_ROLE_KEY` and `BYOK_ENCRYPTION_KEY` must only exist in server environment variables or the deployment secret manager.

### Current boundaries

- Authentication uses the existing Supabase account and verifies bearer tokens server-side.
- BYOK requires all three provider keys before the account can switch modes.
- Provider adapters normalize output, usage, latency, and request IDs; upstream error messages are sanitized before returning to the browser.
- Internal provider-cost rows are server-only; users see only their plan allowance.
- Billing checkout requires real Stripe products, price IDs, and webhook configuration before it can run.
- Encryption-key rotation, KMS integration, advanced admin cost dashboards, and automated pricing refresh are not included. Configure and rotate secrets operationally.
