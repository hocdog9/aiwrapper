import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env');
const Stripe = require('stripe');
loadEnvConfig(process.cwd());
const key = process.env.BILLING_SECRET_KEY;
if (!key?.startsWith('sk_test_') && !key?.startsWith('rk_test_')) throw new Error('Sandbox key required; no live changes allowed.');
const stripe = new Stripe(key);
const appUrl = 'https://aiwrapper-five.vercel.app';
function save(name, value) {
  let contents = readFileSync('.env.local', 'utf8');
  const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=.*$`, 'm');
  contents = pattern.test(contents) ? contents.replace(pattern, `${name}=${value}`) : `${contents.trimEnd()}\n${name}=${value}\n`;
  writeFileSync('.env.local', contents, { mode: 0o600 });
}
try {
  const price = await stripe.prices.retrieve(process.env.BILLING_PREMIUM_PRICE_ID);
  if (price.livemode || price.currency !== 'cad' || price.unit_amount !== 999 || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || !price.active) throw new Error('Unexpected Premium price configuration.');
  save('APP_URL', appUrl);
  const configurations = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
  const portalSettings = {
    default_return_url: appUrl,
    business_profile: { headline: 'Manage your Consensus subscription' },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },
    },
  };
  const portal = configurations.data[0]
    ? await stripe.billingPortal.configurations.update(configurations.data[0].id, portalSettings)
    : await stripe.billingPortal.configurations.create(portalSettings);
  const url = `${appUrl}/api/billing/webhook`;
  const events = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'];
  let endpoint;
  for await (const item of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (item.url === url) { endpoint = item; break; }
  }
  let secretSaved = false;
  if (endpoint) {
    endpoint = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: events, disabled: false });
  } else {
    endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: events, api_version: Stripe.API_VERSION, description: 'Consensus sandbox subscription updates' }, { idempotencyKey: 'consensus-sandbox-webhook-aiwrapper-five-v1' });
    if (endpoint.secret) { save('BILLING_WEBHOOK_SECRET', endpoint.secret); secretSaved = true; }
  }
  const verifiedPortal = await stripe.billingPortal.configurations.retrieve(portal.id);
  console.log(JSON.stringify({ mode: 'sandbox', price: 'CA$9.99/month', priceId: price.id, portalId: portal.id, portalIsDefault: verifiedPortal.is_default, paymentUpdates: verifiedPortal.features.payment_method_update.enabled, invoices: verifiedPortal.features.invoice_history.enabled, cancellation: verifiedPortal.features.subscription_cancel.mode, webhookId: endpoint.id, webhookUrl: endpoint.url, webhookStatus: endpoint.status, signingSecretSaved: secretSaved, existingLocalSigningSecret: Boolean(process.env.BILLING_WEBHOOK_SECRET), appUrlSaved: true }));
} catch (error) {
  console.error(JSON.stringify({ error: 'Sandbox configuration could not complete', type: error.type, code: error.code, status: error.statusCode }));
  process.exitCode = 1;
}
