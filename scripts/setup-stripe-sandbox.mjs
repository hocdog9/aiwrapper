import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env');
const Stripe = require('stripe');
loadEnvConfig(process.cwd());
const key = process.env.BILLING_SECRET_KEY;
if (!key?.startsWith('sk_test_') && !key?.startsWith('rk_test_')) throw new Error('A Stripe sandbox secret key is required. No changes made.');
const stripe = new Stripe(key);
try {
  let product;
  for await (const candidate of stripe.products.list({ active: true, limit: 100 })) {
    if (candidate.metadata.app === 'consensus' && candidate.metadata.planId === 'premium') { product = candidate; break; }
  }
  product ??= await stripe.products.create({ name: 'Consensus Premium', description: '500 AI chat requests per month.', metadata: { app: 'consensus', planId: 'premium' } }, { idempotencyKey: 'consensus-premium-product-v1' });
  let price;
  for await (const candidate of stripe.prices.list({ product: product.id, active: true, limit: 100 })) {
    if (candidate.currency === 'cad' && candidate.unit_amount === 999 && candidate.recurring?.interval === 'month' && candidate.recurring.interval_count === 1) { price = candidate; break; }
  }
  price ??= await stripe.prices.create({ product: product.id, currency: 'cad', unit_amount: 999, recurring: { interval: 'month' }, metadata: { app: 'consensus', planId: 'premium' } }, { idempotencyKey: 'consensus-premium-cad-999-month-v1' });
  const path = '.env.local';
  let env = readFileSync(path, 'utf8');
  const line = `BILLING_PREMIUM_PRICE_ID=${price.id}`;
  env = /^\s*BILLING_PREMIUM_PRICE_ID\s*=.*$/m.test(env) ? env.replace(/^\s*BILLING_PREMIUM_PRICE_ID\s*=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
  writeFileSync(path, env, { mode: 0o600 });
  console.log(JSON.stringify({ mode: 'sandbox', productId: product.id, priceId: price.id, amount: 'CA$9.99/month', savedTo: '.env.local' }));
} catch (error) {
  console.error(JSON.stringify({ error: 'Stripe sandbox setup failed', type: error.type, code: error.code, status: error.statusCode }));
  process.exitCode = 1;
}
