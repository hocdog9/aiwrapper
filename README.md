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

Use **Models** beside Send to select providers for the next message. Specific model versions remain in **Settings → Models**. Changing providers, versions, or profiles does not send a request or modify an existing answer. Choices persist with the current profile, including guest profiles. To intentionally repeat the latest question, use **Rerun with selected models** below its answer; the button shows the request cost before clicking. Model availability, quotas, and outages still depend on the provider account.

Built-in alternatives include GPT-4.1 Mini, Gemini 3.7 Flash and 3.5 Flash-Lite, and Claude Haiku 4.5 alongside the configured defaults. Review provider support when changing the catalog: [OpenAI](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Google](https://firebase.google.com/docs/ai-logic/models), [Anthropic](https://platform.claude.com/docs/en/models/haiku-4-5/overview). Configure explicit per-plan lists or server model-list variables to control which models your app funds. No SQL migration is needed for plans with empty model lists.

### Automatic model retries and credits

Run `supabase/model_retry_migration.sql` before deploying retry support. It adds server-only reservation/finalization functions and disables the older client-callable credit functions. All deployments using this database must use the updated app after applying it.

An incomplete response (including a partial provider or synthesis failure) is refunded. Explicitly choosing **Rerun with selected models** resends the same conversation input; the server verifies its fingerprint, owner, and incomplete parent before allowing a zero-credit retry. A parent attempt can only be retried once, atomically; if that retry also fails, its new attempt can be retried. Explicit reruns of successful answers use the normal allowance. Changing a model selection alone uses no allowance. New questions always use the normal allowance. Guest attempt, rate, and concurrency limits still apply.

The response is replaced in place and the allowance shown comes from the finalized server ledger. Old responses from before this migration lack retry fingerprints and are not retroactively eligible for free retries. Apply and exercise the migration in Supabase to verify database behavior; local unit tests do not run the hosted database.

### Answer agreement

New responses compare conclusions and reasoning semantically rather than scoring word overlap. Multiple-choice results lead with counted selections (for example, “3 of 3 models chose A”), with each responding provider's selection and supporting excerpt. Unclear selections are reported separately; failed providers are not counted as votes. Open-ended comparisons show specific conflicting claims and the providers taking each position. Complementary details and differences in explanation appear separately from conflicts.

The existing synthesis call now returns a structured comparison. The server validates provider attribution, vote coverage, and source excerpts (ignoring emphasis formatting and whitespace) before displaying it. This checks evidence provenance, not the truth of the claims or the correctness of the AI's interpretation. Agreement is not a confidence percentage. Invalid comparisons try the next responding provider while retaining a usable consolidated answer. If no structured answer can be read, a plain-language synthesis is attempted. Individual answers stay in expandable details; they are never pasted together as the main answer. If all synthesis attempts fail, an explicit unavailable message replaces the summary. Existing error/refund handling applies. Historical chats retain their answers but no longer display the old overlap-based scores. No database migration is required.

### File attachments

Use **Attach files**, drop files onto the composer, or paste images/files from the clipboard. Supported formats are Excel (XLSX/XLS), Word (DOCX), PowerPoint (PPTX), PDF, PNG, JPEG, WebP, GIF, and text files (TXT, Markdown, CSV, JSON, logs, XML, YAML, and common source-code formats). Image previews and text-file chips can be removed before sending. Up to four images/PDF pages totaling 3 MB after rendering and four text/Office documents are supported. PDFs up to 50 MB and 250 pages are supported. Short PDFs fitting the available four-page/image budget are rendered locally, including scans. Larger PDFs are stored as page-numbered text references and searched for relevant excerpts on each question. Textbooks with predominantly scanned/image-only pages require OCR first. Text references do not include diagrams or other visuals. Password-protected PDFs must be unlocked first. PDF.js worker, font, and decoder assets are generated locally by the predev/prebuild scripts. Text-file contents are included in the message and its saved chat history; the combined message and text-file contents must fit the 100,000-character message limit. Oversized text is rejected rather than truncated. Office files up to 10 MB are parsed locally in a worker. Worksheet names, values, document text, and slide order are preserved. Formulas are not recalculated. Embedded images/charts and full visual layouts are not extracted; export to PDF when these matter. Legacy DOC/PPT files must be saved as DOCX/PPTX. The same combined 100,000-character text budget applies to Office uploads, with an explicit error rather than silent truncation. Attachments are read in the browser and submitted with the chat, without a separate file-storage service.

PDF pages and image attachments remain available to follow-up questions in the same chat. Requests collect saved user attachments before trimming the recent text history, so pages remain available after the original upload scrolls out of context and after reloading a saved conversation. References include filenames/page labels where available. Rendered attachments still have a limit of four distinct pages/images totaling 3 MB across the chat; larger text-based PDFs use text references instead. This persistence applies to image/PDF attachments, not extracted Office/text documents beyond the rolling text window.

Textbook references retain up to 250 pages per PDF and 2 million extracted characters across a chat. Follow-ups search stored page text independently of the rolling message history, selecting up to 16 pages and 80,000 characters per request. Explicit references such as “PDF page 250” or “pages 20–25” are prioritized. Broad summaries use representative excerpts, not a full-book read; request chapter/page ranges for detailed work. Page numbers refer to PDF file positions, which may differ from printed numbering. The original PDF binary is not stored. If a textbook exceeds browser cache capacity, the app still attempts Supabase chat-history sync; check for sync errors before closing the chat.

### Project workspaces

Run `supabase/projects_migration.sql` in the Supabase SQL Editor after the chat-history migration, then deploy. The migration adds owner-protected projects, shared file storage, and optional project membership on chats. Personal chats remain separate. The sidebar offers **New project**, a workspace selector, **Upload shared files**, rename, file removal, and **Move current chat to**. New chats inherit the selected project. Composer uploads remain private to their chat; upload via the project panel to share a file across chats. Existing attachment and reference-text limits apply to the combined project/chat context.

Project files are synced to Supabase without consuming model requests. Only files—not sibling chat messages—are added to each question's context. Removing a shared file affects future requests but does not erase existing answers. Moving a chat preserves its own messages and uploads. Free retry validation still binds the exact submitted context: if project files changed since an incomplete attempt, its prior retry token may no longer match. Project schema policies require the same authenticated owner for chats and projects. Hosted migration/RLS behavior must be verified after applying the SQL; local tests cover context composition and isolation.

### One-time usage top-ups

Usage is still enforced server-side, but counters are hidden in the app. At the monthly limit, users can buy 100 extra requests for **CA$4.20 once**, without changing their subscription. The extra allowance expires at the end of the billing period. Guests must create/sign into an account before checkout.

Before deploying this feature, run `supabase/billing_topups_migration.sql` after `model_retry_migration.sql` in the Supabase SQL editor. Then deploy the app. Existing Stripe secret/webhook keys and `APP_URL` are reused; no new Stripe Price ID is needed (Checkout uses server-defined CAD price data). Card payments are fulfilled by the signed `checkout.session.completed` webhook; the handler also supports `checkout.session.async_payment_succeeded`. The database deduplicates by Checkout Session ID, so webhook retries cannot grant usage twice. Subscription updates do not overwrite top-ups.

Verify in Stripe sandbox: exhaust a test account, complete the CA$4.20 card checkout, wait for webhook delivery, then send a message. Replay the webhook and verify no second grant. Confirm the grant expires when the billing period ends. SQL execution and end-to-end payment verification require the configured Supabase/Stripe environment.
