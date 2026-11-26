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
  const prices = [
    ['BILLING_PREMIUM_MONTHLY_PRICE_ID', 'price_1UeEL8GZBGrNJ51pysmDxGoi', 690, 'month'],
    ['BILLING_PREMIUM_ANNUAL_PRICE_ID', 'price_1UeEL8GZBGrNJ51pe8qa8Lga', 6900, 'year'],
  ];
  let env = readFileSync('.env.local', 'utf8');
  for (const [name, fallback, amount, interval] of prices) {
    const price = await stripe.prices.retrieve(process.env[name] || fallback);
    if (!price.active || price.livemode || price.currency !== 'cad' || price.unit_amount !== amount || price.recurring?.interval !== interval || price.recurring.interval_count !== 1) throw new Error('Unexpected Premium price configuration.');
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    env = pattern.test(env) ? env.replace(pattern, `${name}=${price.id}`) : `${env.trimEnd()}\n${name}=${price.id}\n`;
  }
  writeFileSync('.env.local', env, { mode: 0o600 });
  console.log(JSON.stringify({ mode: 'sandbox', monthly: 'CA$6.90/month', annual: 'CA$69/year', savedTo: '.env.local' }));
} catch (error) {
  console.error(JSON.stringify({ error: 'Stripe sandbox setup failed', type: error.type, code: error.code, status: error.statusCode }));
  process.exitCode = 1;
}
