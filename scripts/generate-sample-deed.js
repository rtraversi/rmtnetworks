// /scripts/generate-sample-deed.js
//
// One-off: regenerates /demos/new-deed/sample-old-deed.pdf, the sample
// "old deed" the demo offers as a try-with-sample option.
//
// Usage:  node scripts/generate-sample-deed.js
//
// All names/addresses are fictional. Property address mirrors a plausible
// Scarsdale, NY parcel for realism. Re-run any time you tweak the renderer
// or want to refresh the sample.

const fs = require('fs');
const path = require('path');
const { renderDeedPdf } = require('../lib/deed-renderer');

const sampleOldDeed = {
  deed_type: 'Bargain and Sale Deed With Covenants',
  grantor_name: 'Eleanor M. Caldwell, a widow',
  grantor_address: '12 Heathcote Road, Scarsdale, NY 10583',
  grantee_name: 'Margaret E. Whitfield and Robert J. Whitfield, husband and wife, as tenants by the entirety',
  grantee_address: '12 Heathcote Road, Scarsdale, NY 10583',
  consideration_amount: 875000.00,
  consideration_words: 'Eight Hundred Seventy-Five Thousand and 00/100 Dollars ($875,000.00)',
  conveyance_date: '2008-09-12',
  property_address: '12 Heathcote Road',
  property_city: 'Scarsdale',
  property_state: 'New York',
  property_county: 'Westchester',
  tax_section: '167.16',
  tax_block: '2',
  tax_lot: '14',
  legal_description:
    'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk\'s Office on June 8, 1928 as Map No. 3461. Said premises being more particularly bounded and described as follows: BEGINNING at a point on the southerly side of Heathcote Road distant 187.42 feet easterly from the corner formed by the intersection of the southerly side of Heathcote Road with the easterly side of Brewster Road; running thence southerly, parallel with said Brewster Road, 142.85 feet; thence easterly, parallel with said Heathcote Road, 78.00 feet; thence northerly, again parallel with said Brewster Road, 142.85 feet to the southerly side of Heathcote Road; thence westerly, along the southerly side of Heathcote Road, 78.00 feet to the point or place of BEGINNING.',
};

(async () => {
  const bytes = await renderDeedPdf(sampleOldDeed);
  const out = path.join(__dirname, '..', 'demos', 'new-deed', 'sample-old-deed.pdf');
  fs.writeFileSync(out, Buffer.from(bytes));
  console.log(`Wrote ${out} (${bytes.length.toLocaleString()} bytes)`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
