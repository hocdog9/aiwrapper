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

Users sign up and start chatting with app-provided model access. Free includes 10 requests per month; Premium includes 500. Each successful request costs one request, including synthesis. At least two providers must respond; failed requests are refunded. Users never configure API keys or billing modes.

1. Copy `.env.example` to `.env.local`. Configure the public Supabase URL and publishable key, and server-only `SUPABASE_SERVICE_ROLE_KEY`.
2. Set server-only `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY`, and configure available model IDs. Default selections use GPT and Gemini. Keys are never sent to the browser.
3. Run `supabase/schema.sql`, `supabase/managed_billing_byok_migration.sql`, then `supabase/free_premium_migration.sql` in the Supabase SQL Editor. If the first two were already applied, only run the third. The earlier migration is historical; the final migration disables BYOK and adds Premium.
4. Run `npm install`, `npm run check`, `npm test`, and `npm run build`.
5. Set the same environment variables in Vercel before deploying. SQL migrations are applied separately from deployment.

### Premium subscriptions

Create a recurring Premium price in Stripe. Set `BILLING_PREMIUM_PRICE_ID`, `BILLING_SECRET_KEY`, `BILLING_WEBHOOK_SECRET`, and `APP_URL`. Configure the Stripe customer portal and a webhook to `/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`.

Stripe checkout displays the configured price before payment. Webhooks grant Premium access; a checkout redirect alone does not. Paid allowances reset through subscription events, while Free allowances reset on the next request after the period ends. Cancellation returns the account to Free. Premium upgrades are unavailable until Stripe is configured; Free chat works independently.

### Models and usage

`plan_catalog.allowed_models` maps provider names (`GPT`, `Gemini`, `Claude`) to model-ID arrays. Empty arrays fall back to the configured server models. Users choose one model per provider and at least two providers. Optional `MODEL_PRICING_JSON` configures token cost estimates; without rates, usage is recorded but cost is unavailable.

Keep `.env.local` and server credentials out of Git. The historical encrypted-key helpers and tables are unused by the application; `BYOK_ENCRYPTION_KEY` is no longer required.
