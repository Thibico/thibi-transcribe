/**
 * S5 — Is the Dynamic Batch rate advantage real?
 *
 * This was the last unverified premise of Phase 2. Spike S3 removed latency as a reason to
 * use batchRecognize — it is a flat 5.9x realtime and chunked parallel sync beats it at
 * every size — which leaves cost as its only justification. RESULTS.md closed by saying so:
 * "confirm against the actual bill before writing the routing rule into code".
 *
 * A bill is not needed. The Cloud Billing Catalog API publishes list prices per SKU, and
 * `totalBilledDuration` in a batch response reports audio duration rather than price, so
 * this is the only API that can answer the question at all.
 *
 * Measured 2026-08-10, service 63DE-82AB-F564 (Cloud Speech API):
 *
 *   Cloud Speech-to-Text Recognition                        minute  0.016  (tiers to 0.010
 *                                                                   above 500k min/month)
 *   Cloud Speech-to-Text Dynamic Batch Recognition          minute  0.003  (flat)
 *   Cloud Speech-to-Text Recognition (Logged)               minute  0.012
 *   Cloud Speech-to-Text Dynamic Batch Recognition (Logged) minute  0.00225
 *
 * 5.33x, so the premise holds and the two seeded `rates` rows are the catalog's own numbers.
 * Two riders, both in the Phase 2 plan §8:
 *
 *   - Recognition is tiered and Dynamic Batch is flat, so the ratio is a property of the
 *     tier rather than a constant. This is why rates live in a table an admin can correct.
 *   - The (Logged) SKUs are 25% off in exchange for Google retaining the audio to improve
 *     its models. For a newsroom transcribing confidential sources that is a disclosure and
 *     not a saving. Never a default, never seeded, never a silent cost optimisation.
 *
 * Uses the developer's own gcloud credential rather than the app service account: reading
 * the catalog needs no project permission, but it does need a token, and the app account
 * has no reason to ever hold one for this.
 *
 *   node spikes/s5-rates.mjs [name-filter]      # default filter: speech
 */
import { execFileSync } from 'node:child_process';

const filter = (process.argv[2] ?? 'speech').toLowerCase();
const token = execFileSync('gcloud', ['auth', 'print-access-token']).toString().trim();
const H = { Authorization: `Bearer ${token}` };

async function pages(url) {
  const out = [];
  for (let next; ; ) {
    const r = await fetch(next ? `${url}&pageToken=${next}` : url, { headers: H });
    if (!r.ok) {
      console.error(r.status, (await r.text()).slice(0, 300));
      process.exit(1);
    }
    const j = await r.json();
    out.push(j);
    if (!j.nextPageToken) return out;
    next = j.nextPageToken;
  }
}

const services = (await pages('https://cloudbilling.googleapis.com/v1/services?pageSize=500'))
  .flatMap((p) => p.services)
  .filter((s) => s.displayName.toLowerCase().includes(filter));

for (const s of services) {
  console.log(`\n${s.serviceId}  ${s.displayName}`);
  const skus = (
    await pages(
      `https://cloudbilling.googleapis.com/v1/services/${s.serviceId}/skus?pageSize=500&currencyCode=USD`,
    )
  ).flatMap((p) => p.skus ?? []);

  for (const sku of skus.sort((a, b) => a.description.localeCompare(b.description))) {
    const info = sku.pricingInfo?.[0]?.pricingExpression;
    if (!info) continue;
    const tiers = (info.tieredRates ?? [])
      .map((t) => {
        const usd = Number(t.unitPrice.units ?? 0) + Number(t.unitPrice.nanos ?? 0) / 1e9;
        return `${t.startUsageAmount}+ ${usd.toFixed(6)}`;
      })
      .join('  |  ');
    console.log(`  ${sku.description.padEnd(58)} [${info.usageUnitDescription}]  ${tiers}`);
  }
}
