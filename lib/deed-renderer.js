// /lib/deed-renderer.js
//
// Renders a DeedRecord to a PDF matching the attorney's N.Y.B.T.U. Form 8007 template:
// "Bargain and Sale Deed with Covenant Against Grantor's Acts" — Westchester County.
//
// Output: Uint8Array suitable for streaming as application/pdf.
//
// DeedRecord fields used:
//   grantor_name, grantor_address       — party of the first part (the CURRENT owners)
//   grantee_name, grantee_address       — party of the second part (new owner / trustee)
//   conveyance_date                     — YYYY-MM-DD, date of new deed
//   consideration_words                 — defaults to "TEN DOLLARS ($10)"
//   prior_grantor_name                  — who conveyed to grantors (for "being" clause)
//   prior_deed_date                     — date of prior conveyance (YYYY-MM-DD)
//   prior_recording_info                — e.g. "in the Office of the County Clerk on …"
//   property_address, property_city, property_county, property_state
//   tax_section, tax_block, tax_lot
//   legal_description                   — full metes-and-bounds; goes to Schedule A

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 612;   // US Letter, points
const PAGE_H = 792;
const MX     = 72;    // left / right margin — 1 inch
const MY     = 72;    // top / bottom margin — 1 inch
const CW     = PAGE_W - MX * 2;  // content width = 468 pt

const BLACK = rgb(0, 0, 0);
const GREY  = rgb(0.35, 0.35, 0.35);

// ── helpers ───────────────────────────────────────────────────────────────────

function wrap(text, font, size, maxW) {
  if (!text) return [];
  const lines = [];
  let line = '';
  for (const w of String(text).split(/\s+/)) {
    const cand = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(cand, size) > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = cand;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function ordinal(n) {
  const v = n % 100;
  return n + (['th','st','nd','rd'][(v - 20) % 10] || ['th','st','nd','rd'][v] || 'th');
}

function fmtLongDate(iso) {
  if (!iso) return '__________ day of ____________, ____';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d)) return iso;
  return `${ordinal(d.getDate())} day of ${MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
}

function fmtYear(iso) { return iso ? iso.slice(0, 4) : '____'; }

// Split "A and B" into two parties; keeps trust / LLC names intact.
function splitParties(name) {
  if (!name) return [''];
  if (/\b(trust|trustee|llc|corp|inc|lp|llp)\b/i.test(name)) return [name.trim()];
  const parts = name.trim().split(/,?\s+and\s+(?=[A-Z])/);
  return parts.length > 1 ? parts.map(p => p.trim()) : [name.trim()];
}

// ── main renderer ─────────────────────────────────────────────────────────────

async function renderDeedPdf(deed) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Deed — ${deed.grantee_name || 'Draft'}`);
  doc.setAuthor('Eileen Donovan Law');
  doc.setSubject("Bargain and Sale Deed with Covenant Against Grantor's Acts");

  const R  = await doc.embedFont(StandardFonts.TimesRoman);
  const B  = await doc.embedFont(StandardFonts.TimesRomanBold);
  const BI = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const I  = await doc.embedFont(StandardFonts.TimesRomanItalic);

  // ── page / y tracking ──────────────────────────────────────────────────────
  let pg, y;

  function addPage() {
    pg = doc.addPage([PAGE_W, PAGE_H]);
    y  = PAGE_H - MY;
  }

  // Ensure there is at least `pts` of vertical space; if not, start a new page.
  function ensure(pts) {
    if (y - pts < MY) addPage();
  }

  function t(str, x, yy, sz, font, color = BLACK) {
    if (!str) return;
    pg.drawText(String(str), { x, y: yy, size: sz, font, color });
  }

  function rule(yy, x1 = MX, x2 = MX + CW, thickness = 0.5) {
    pg.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color: BLACK });
  }

  // Draw text centered on the current line.
  function ctr(str, sz, font, dy = 0) {
    const w = font.widthOfTextAtSize(str, sz);
    t(str, (PAGE_W - w) / 2, y - dy, sz, font);
  }

  // Wrap-and-draw a paragraph; advances y.
  function para(str, sz, font, opts = {}) {
    const { indent = 0, lh = sz * 1.35, before = 0, after = 8, width = CW - indent, color = BLACK } = opts;
    y -= before;
    for (const ln of wrap(str, font, sz, width)) {
      ensure(lh + MY);
      t(ln, MX + indent, y, sz, font, color);
      y -= lh;
    }
    y -= after;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 1 — Deed body
  // ═══════════════════════════════════════════════════════════════════════════
  addPage();

  // Title
  ctr('BARGAIN AND SALE DEED', 15, B);                            y -= 20;
  ctr("WITH COVENANT AGAINST GRANTOR'S ACTS", 15, B);            y -= 18;
  ctr('(INDIVIDUAL OR CORPORATION)', 10, R);                     y -= 13;
  ctr('STANDARD NYBTU FORM 8007', 9, R);                        y -= 28;

  // Caution
  para(
    'CAUTION: THIS AGREEMENT SHOULD BE PREPARED BY AN ATTORNEY AND REVIEWED BY ' +
    'ATTORNEYS FOR SELLER AND PURCHASER BEFORE SIGNING.',
    9, BI, { after: 22 }
  );

  // THIS INDENTURE
  para(
    `THIS INDENTURE, made as of the ${fmtLongDate(deed.conveyance_date)},`,
    11, R, { after: 10 }
  );

  // BETWEEN
  para('BETWEEN', 11, B, { after: 10 });

  // Grantor block
  para(deed.grantor_name || '___________________________', 11, B, { indent: 36, after: 4 });
  if (deed.grantor_address)
    para(deed.grantor_address, 10, I, { indent: 36, after: 12 });

  para('party of the first part, and', 11, R, { after: 12 });

  // Grantee block
  para(deed.grantee_name || '___________________________', 11, B, { indent: 36, after: 4 });
  if (deed.grantee_address)
    para(deed.grantee_address, 10, I, { indent: 36, after: 12 });

  para('party of the second part,', 11, R, { after: 20 });

  // WITNESSETH
  const consideration = deed.consideration_words || 'TEN DOLLARS ($10)';
  para(
    `WITNESSETH, that the party of the first part, in consideration of ${consideration} dollars, ` +
    'lawful money of the United States, paid by the party of the second part, does hereby grant ' +
    'and release unto the party of the second part, the heirs or successors and assigns of the ' +
    'party of the second part forever,',
    11, R, { after: 14 }
  );

  // ALL that certain
  para(
    'ALL that certain plot, piece or parcel of land, with the buildings and improvements ' +
    'thereon erected, situate, lying and being in the',
    11, R, { after: 10 }
  );

  // Schedule A reference (centered, bold)
  ensure(30 + MY);
  ctr('SEE SCHEDULE “A” LEGAL DESCRIPTION ANNEXED HERETO AND MADE PART HEREOF.', 11, B);
  y -= 24;

  // Being the same premises — chain of title
  const priorGrantor = deed.prior_grantor_name  || '___________________________';
  const priorDate    = deed.prior_deed_date ? fmtLongDate(deed.prior_deed_date) : '____________';
  const priorRec     = deed.prior_recording_info || '[recording information]';
  const propAddr     = [deed.property_address, deed.property_city].filter(Boolean).join(', ') || '___________________________';
  const county       = deed.property_county || 'Westchester';

  para(
    `Being the same premises conveyed to grantors herein by deed from ${priorGrantor}, ` +
    `which deed was dated ${priorDate}, and recorded on ${priorRec}. Said premises are commonly ` +
    `known as and by the street address ${propAddr}, located in the County of ${county}, State of New York.`,
    11, R, { after: 14 }
  );

  // TOGETHER
  para(
    'TOGETHER with all right, title and interest, if any, of the party of the first part in and ' +
    'to any streets and roads abutting the above-described premises to the center lines thereof; ' +
    'TOGETHER with the appurtenances and all the estate and rights of the party of the first part ' +
    'in and to said premises; TO HAVE AND TO HOLD the premises herein granted unto the party of ' +
    'the second part, the heirs or successors and assigns of the party of the second part forever.',
    11, R, { after: 14 }
  );

  // AND covenants
  para(
    'AND the party of the first part, covenants that the party of the first part has not done or ' +
    'suffered anything whereby the said premises have been encumbered in any way whatsoever, ' +
    'except as aforesaid.',
    11, R, { after: 14 }
  );

  // AND Lien Law
  para(
    'AND the party of the first part, in compliance with Section 13 of the Lien Law, covenants ' +
    'that the party of the first part will receive the consideration for this conveyance and will ' +
    'hold the right to receive such consideration as a trust fund to be applied first for the ' +
    'purpose of paying the cost of the improvement and will apply the same first to the payment ' +
    'of the cost of the improvement before using any part of the total of the same for any other purpose.',
    11, R, { after: 14 }
  );

  // The word "party"
  para(
    'The word “party” shall be construed as if it read “parties” whenever ' +
    'the sense of this indenture so requires.',
    11, R, { after: 24 }
  );

  // IN WITNESS WHEREOF
  ensure(100 + MY);
  para(
    'IN WITNESS WHEREOF, the party of the first part has duly executed this deed the day and year first above written.',
    11, R, { after: 34 }
  );

  // Signature lines — one per grantor
  const grantors = splitParties(deed.grantor_name);
  for (const g of grantors) {
    ensure(52 + MY);
    rule(y, MX, MX + 270);
    y -= 13;
    t(g, MX, y, 10, R, GREY);
    y -= 30;
  }

  // Notary acknowledgment blocks — one per grantor
  for (const g of grantors) {
    ensure(140 + MY);
    y -= 8;

    t('STATE OF NEW YORK', MX, y, 10, R);
    t(')', MX + 164, y, 10, R);
    y -= 14;
    t(')', MX + 164, y, 10, R);
    t('ss.:', MX + 170, y, 10, R);
    y -= 14;
    t(`COUNTY OF ${county.toUpperCase()}`, MX, y, 10, R);
    t(')', MX + 164, y, 10, R);
    y -= 22;

    para(
      `On the _____ day of __________________________ in the year ${fmtYear(deed.conveyance_date)}, ` +
      `before me, the undersigned, personally appeared ${g}, personally known to me or proved to me ` +
      'on the basis of satisfactory evidence to be the individual whose name is subscribed to the ' +
      'within instrument and acknowledged to me that he/she executed the same in his/her capacity, ' +
      'and that by his/her signature on the instrument, the individual, or the person upon behalf ' +
      'of which the individual acted, executed the instrument.',
      10, R, { after: 26 }
    );

    ensure(30 + MY);
    rule(y, MX, MX + 270);
    y -= 13;
    t('Notary Public', MX, y, 10, R, GREY);
    y -= 30;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE — Cover sheet (back of deed)
  // ═══════════════════════════════════════════════════════════════════════════
  addPage();
  y -= 60;

  ctr('BARGAIN AND SALE DEED', 14, B);                            y -= 20;
  ctr("WITH COVENANT AGAINST GRANTOR'S ACTS", 14, B);            y -= 50;

  // Grantor(s) name
  for (const g of grantors) {
    ctr(g.toUpperCase(), 12, B);
    y -= 18;
  }

  y -= 8;
  ctr('TO', 12, B);
  y -= 26;

  // Grantee(s) name
  const grantees = splitParties(deed.grantee_name);
  for (const g of grantees) {
    ctr(g.toUpperCase(), 12, B);
    y -= 18;
  }

  y -= 50;

  // Tax map
  const sbl = `County: ${county}    Section: ${deed.tax_section || '____'}    Block: ${deed.tax_block || '____'}    Lot: ${deed.tax_lot || '____'}`;
  ctr(sbl, 10, R);
  y -= 16;

  if (deed.property_address) {
    ctr(`Property Address: ${propAddr}`, 10, R);
    y -= 16;
  }

  y -= 60;

  // Return to block (centered)
  const rtX = Math.round((PAGE_W - 220) / 2);
  t('Record and Return to:', rtX, y, 10, B);   y -= 16;
  t('Eileen Donovan Law',          rtX + 16, y, 10, R);  y -= 13;
  t('2 Overhill Road, Suite 400',  rtX + 16, y, 10, R);  y -= 13;
  t('Scarsdale, New York 10583',   rtX + 16, y, 10, R);

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE — Schedule A — Legal Description
  // ═══════════════════════════════════════════════════════════════════════════
  addPage();
  y -= 20;

  ctr('SCHEDULE “A”', 16, B);      y -= 22;
  ctr('Legal Description', 12, R);            y -= 36;
  rule(y + 2);                                y -= 12;

  if (deed.legal_description) {
    para(deed.legal_description, 11, R, { lh: 16, after: 0 });
  } else {
    para('[Legal description to be inserted from prior deed]', 11, I);
  }

  // Footer
  t(
    'DRAFT — Generated by RMT Networks — not a legal instrument until executed and acknowledged',
    MX, MY - 16, 7, I, GREY
  );

  return doc.save();
}

module.exports = { renderDeedPdf };
