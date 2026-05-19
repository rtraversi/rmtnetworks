// /scripts/generate-sample-deed.js
//
// Regenerates /demos/new-deed/sample-old-deed.pdf — a fictional "old deed"
// in N.Y.B.T.U. Form 8007 format used as the demo upload sample.
//
// NOTE: The demo now uses the real Ma-No Trust deed (provided by the attorney)
// as the default sample. Run this script only if you want to swap back to a
// fully fictional Westchester deed for offline/redacted demos.
//
// Usage:  node scripts/generate-sample-deed.js

const fs   = require('fs');
const path = require('path');
const { renderDeedPdf } = require('../lib/deed-renderer');

// Fictional Westchester estate-planning scenario:
// Eleanor Caldwell (a widow) transferring her home to her daughter as trustee of a family trust.
const sampleDeed = {
  deed_type:            "Bargain and Sale Deed With Covenant Against Grantor's Acts",
  // Prior conveyance (chain of title — who conveyed TO Eleanor)
  prior_grantor_name:   'Harold R. Caldwell and Eleanor M. Caldwell, husband and wife',
  prior_deed_date:      '1978-06-15',
  prior_recording_info: 'the Westchester County Clerk\'s Office on June 22, 1978 in Liber 7843 page 412',
  // Current owners conveying out (grantors of THIS deed)
  grantor_name:         'Eleanor M. Caldwell, a widow',
  grantor_address:      '12 Heathcote Road, Scarsdale, NY 10583',
  // New owner / trustee (grantee of THIS deed)
  grantee_name:         'Patricia A. Caldwell as Trustee of THE CALDWELL FAMILY REVOCABLE TRUST dated January 4, 2024',
  grantee_address:      '12 Heathcote Road, Scarsdale, NY 10583',
  // Consideration — nominal for trust transfer
  consideration_amount: 10,
  consideration_words:  'TEN DOLLARS ($10)',
  conveyance_date:      '2024-03-01',
  // Property
  property_address:     '12 Heathcote Road',
  property_city:        'Scarsdale',
  property_state:       'New York',
  property_county:      'Westchester',
  tax_section:          '167.16',
  tax_block:            '2',
  tax_lot:              '14',
  legal_description:
    'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon ' +
    'erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of ' +
    'Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain ' +
    'map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk\'s Office ' +
    'on June 8, 1928 as Map No. 3461. Said premises being more particularly bounded and described ' +
    'as follows: BEGINNING at a point on the southerly side of Heathcote Road distant 187.42 feet ' +
    'easterly from the corner formed by the intersection of the southerly side of Heathcote Road ' +
    'with the easterly side of Brewster Road; running thence southerly, parallel with said Brewster ' +
    'Road, 142.85 feet; thence easterly, parallel with said Heathcote Road, 78.00 feet; thence ' +
    'northerly, again parallel with said Brewster Road, 142.85 feet to the southerly side of ' +
    'Heathcote Road; thence westerly, along the southerly side of Heathcote Road, 78.00 feet to ' +
    'the point or place of BEGINNING.',
};

(async () => {
  const bytes = await renderDeedPdf(sampleDeed);
  const out   = path.join(__dirname, '..', 'demos', 'new-deed', 'sample-old-deed.pdf');
  fs.writeFileSync(out, Buffer.from(bytes));
  console.log(`Wrote ${out} (${bytes.length.toLocaleString()} bytes)`);
})().catch(e => { console.error(e); process.exit(1); });
