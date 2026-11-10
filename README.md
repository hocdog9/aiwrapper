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

## Free and Premium setup

Visitors start chatting without signup using a persistent Supabase anonymous session stored in their browser. An email account is only required for Premium or cross-device access. Free includes 10 requests per month; Premium includes 500. Each successful request costs one request, including synthesis. One successful provider response is enough. Single-provider answers are shown directly without a consensus score or synthesis call; requests are refunded if any provider or synthesis call fails. A retry of the same incomplete question also costs no credit. Users never configure API keys or billing modes.

1. Copy `.env.example` to `.env.local`. Configure the public Supabase URL and publishable key, and server-only `SUPABASE_SERVICE_ROLE_KEY`.
2. Set server-only `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY`, and configure available model IDs. Default selections use GPT and Gemini. Keys are never sent to the browser.
3. Run `supabase/schema.sql`, `supabase/managed_billing_byok_migration.sql`, then `supabase/free_premium_migration.sql` in the Supabase SQL Editor. If the first two were already applied, only run the third. The earlier migration is historical; the final migration disables BYOK and adds Premium.
4. Run `npm install`, `npm run check`, `npm test`, and `npm run build`.
5. Set the same environment variables in Vercel before deploying. SQL migrations are applied separately from deployment.

### Premium subscriptions

Create a recurring Premium price in Stripe. Set `BILLING_PREMIUM_PRICE_ID`, `BILLING_SECRET_KEY`, `BILLING_WEBHOOK_SECRET`, and `APP_URL`. Configure the Stripe customer portal and a webhook to `/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`.

Stripe checkout displays the configured price before payment. Webhooks grant Premium access; a checkout redirect alone does not. Paid allowances reset through subscription events, while Free allowances reset on the next request after the period ends. Cancellation returns the account to Free. Premium upgrades are unavailable until Stripe is configured; Free chat works independently.

### Models and usage

`plan_catalog.allowed_models` maps provider names (`GPT`, `Gemini`, `Claude`) to model-ID arrays. Empty arrays fall back to comma-separated `OPENAI_ALLOWED_MODELS`, `GEMINI_ALLOWED_MODELS`, and `ANTHROPIC_ALLOWED_MODELS` when configured; otherwise they use the server default plus built-in alternatives. Explicit non-empty plan lists take priority. The same allowlist is enforced when sending requests. Users choose one model per provider and one or more providers. `MIN_SUCCESSFUL_PROVIDERS` is no longer used. Optional `MODEL_PRICING_JSON` configures token cost estimates; without rates, usage is recorded but cost is unavailable.

Keep `.env.local` and server credentials out of Git. The historical encrypted-key helpers and tables are unused by the application; `BYOK_ENCRYPTION_KEY` is no longer required.

### Guest access (no signup)

1. In Supabase Authentication settings, enable **Anonymous Sign-Ins**. Supabase creates an internal anonymous identity without asking the visitor for email or password. [Supabase guide](https://supabase.com/docs/guides/auth/auth-anonymous).
2. Run `supabase/guest_access_migration.sql` after `free_premium_migration.sql`.
3. Generate `GUEST_LIMIT_SECRET` with `openssl rand -hex 32` and set the same value locally and in Vercel. Keep it server-only and stable; changing it resets network identities.
4. Deploy. Free visitors can type and send directly. Browser storage preserves their session and database-enforced 10-request allowance. Clearing browser data loses access to guest chats.

Additional guest limits are atomic in Postgres: 5 attempts per network per minute, 30 per network per UTC calendar month, and 100 total guest attempts per UTC day for this proof of concept. These protective limits count attempts, including failed or repeated requests; the normal plan allowance still refunds failures. Adjust the constants in `guest_access_migration.sql` deliberately as traffic grows. Shared Wi-Fi can hit a shared limit. IPv6 addresses are grouped by /64. Network identifiers are HMAC hashes; raw IP addresses are not stored in the limiter.

Production network identification trusts Vercel's `x-vercel-forwarded-for` header. Local development uses one shared localhost bucket. Other production hosts fail closed until a trusted proxy integration is implemented. Missing limiter configuration or database errors also fail closed for guests. Signed-in permanent accounts retain their normal plan limits.

This reduces casual cookie/storage resets, not determined abuse across networks or accounts. Supabase's anonymous signup rate limits still apply. For a public launch, enable CAPTCHA/Turnstile for anonymous sign-ins and integrate the challenge token before calling `signInAnonymously`; the current UI does not implement that challenge. Guest identities also consume Auth storage and need a retention/cleanup policy. These controls do not establish one allowance per real person.

### Choosing another model

Open **Settings → Models**, select a model under an enabled provider. The last question is retried automatically with the new settings, replacing its previous answer. Provider failures include a **Change models** shortcut. Choices persist with the current profile, including guest profiles. Model selection is manual; retrying after selection is automatic. Model availability, quotas, and outages still depend on the provider account.

Built-in alternatives include GPT-4.1 Mini, Gemini 3.7 Flash and 3.5 Flash-Lite, and Claude Haiku 4.5 alongside the configured defaults. Review provider support when changing the catalog: [OpenAI](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Google](https://firebase.google.com/docs/ai-logic/models), [Anthropic](https://platform.claude.com/docs/en/models/haiku-4-5/overview). Configure explicit per-plan lists or server model-list variables to control which models your app funds. No SQL migration is needed for plans with empty model lists.

### Automatic model retries and credits

Run `supabase/model_retry_migration.sql` before deploying the automatic-retry version. It adds server-only reservation/finalization functions and disables the older client-callable credit functions. All deployments using this database must use the updated app after applying it.

An incomplete response (including a partial provider or synthesis failure) is refunded. Changing an enabled model automatically resends the same conversation input; the server verifies its fingerprint, owner, and incomplete parent before allowing a zero-credit retry. A parent attempt can only be retried once, atomically; if that retry also fails, its new attempt can be retried. Successful answers retried by changing models use the normal allowance. New questions always use the normal allowance. Guest attempt, rate, and concurrency limits still apply.

The response is replaced in place and the allowance shown comes from the finalized server ledger. Old responses from before this migration lack retry fingerprints and are not retroactively eligible for free retries. Apply and exercise the migration in Supabase to verify database behavior; local unit tests do not run the hosted database.
