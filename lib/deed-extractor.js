// /lib/deed-extractor.js
//
// Extracts deed fields from an uploaded document using Claude's vision API.
// Accepts either a PDF or an image (JPG/PNG) as base64.
//
// Returns the same DeedRecord shape as /lib/deed-source.js so downstream
// renderers don't care whether the data came from a vault or an OCR pass.
//
// Env: ANTHROPIC_DEED_API (required)
//      ANTHROPIC_MODEL    (optional, defaults to claude-sonnet-4-5)

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

// JSON schema we want Claude to fill. Mirrors the DeedRecord shape used elsewhere.
const EXTRACTION_PROMPT = `You are a paralegal assistant extracting structured fields from a recorded real-estate deed.

Read the attached deed carefully and return ONLY a JSON object with this exact shape (no commentary, no markdown fences):

{
  "deed_type": "<e.g. Bargain and Sale Deed With Covenants | Quitclaim Deed | Warranty Deed | Executor's Deed>",
  "grantor_name": "<full name(s) of the seller / current owner, as written on the deed>",
  "grantor_address": "<grantor's address as written on the deed>",
  "grantee_name": "<full name(s) of the buyer / new owner, as written, including form of co-ownership or trustee capacity if stated>",
  "grantee_address": "<grantee's address as written on the deed>",
  "consideration_amount": <numeric, dollars; 0 if none or nominal>,
  "consideration_words": "<the consideration phrase as written, e.g. 'Ten Dollars ($10.00) and other good and valuable consideration'>",
  "conveyance_date": "<YYYY-MM-DD>",
  "property_address": "<street address of the property, if stated>",
  "property_city": "<city / village / town — for NYC deeds use the borough name e.g. 'Manhattan'>",
  "property_state": "<state>",
  "property_county": "<county — for NYC deeds use the borough: Manhattan, Brooklyn, Queens, Bronx, or Staten Island>",
  "tax_section": "<tax map section number if shown; leave empty for NYC deeds which use Borough/Block/Lot only>",
  "tax_block": "<tax map block number>",
  "tax_lot": "<tax map lot number>",
  "legal_description": "<full metes-and-bounds OR lot-block legal description as written, preserving line breaks as spaces>",
  "recording_info": "<recording reference as shown on the deed, e.g. 'the Office of the City Register, New York County, on September 27, 2022 at CRFN 2022000371832' or 'the Westchester County Clerk on June 1, 2015 in Liber 12345 page 678'; leave empty if not shown>"
}

Rules:
- If a field is not present in the document, return an empty string "" (or 0 for consideration_amount).
- Preserve the exact spellings, abbreviations, and party-name formatting from the deed.
- Do not infer or invent values. Only report what is on the document.
- For NYC deeds: the CRFN (City Register File Number) and recording date appear on the cover page.
- For Westchester deeds: the Liber/Page and recording date appear on the cover page or endorsement.
- Output MUST be valid JSON parseable by JSON.parse. No trailing commas. No markdown.`;

/**
 * Extract deed fields from an uploaded file.
 * @param {object} input
 * @param {string} input.base64   - base64-encoded file content (no data URI prefix)
 * @param {string} input.mediaType - MIME type, e.g. 'application/pdf' or 'image/jpeg'
 * @returns {Promise<object>} DeedRecord-shaped object
 */
async function extractDeedFields({ base64, mediaType }) {
  if (!process.env.ANTHROPIC_DEED_API) {
    throw new Error('ANTHROPIC_DEED_API env var is not set');
  }
  if (!base64 || !mediaType) {
    throw new Error('extractDeedFields requires {base64, mediaType}');
  }

  // Build the content block — image vs document differs by API contract.
  const isPdf = mediaType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,            data: base64 } };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_DEED_API,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            contentBlock,
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();

  // Strip accidental ```json fences just in case.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 400)}`);
  }

  return parsed;
}

module.exports = { extractDeedFields };
