# New Deed Demo — Deployment Guide

This document covers the production swap for the **New Deed** demo at
`/demos/new-deed/`. The architecture was designed so the demo → live transition
is configuration + adapter changes, not a rewrite.

---

## Architecture overview

```
Browser  /demos/new-deed/index.html
   │
   ├──▶ /.netlify/functions/list-deeds     ─▶ lib/deed-source.js   ─▶ Supabase | Vault
   ├──▶ /.netlify/functions/extract-deed   ─▶ lib/deed-extractor.js ─▶ Anthropic API
   ├──▶ /.netlify/functions/render-deed    ─▶ lib/deed-renderer.js  ─▶ pdf-lib
   └──▶ /.netlify/functions/send-deed      ─▶ lib/email-sender.js   ─▶ Zoho SMTP (nodemailer)
```

All four Netlify functions are thin auth+parsing wrappers around the `lib/`
modules. The `lib/` modules are pure JS — they can be lifted into an n8n
function node, a standalone Express app, or any other runtime with no changes.

---

## Required environment variables

Set these in **Netlify → Site settings → Environment variables**.

### Auth & session (already in use)
| Var | Purpose |
|---|---|
| `SITE_PASSWORD` | Rob's portal login password |
| `SESSION_SECRET` | Token returned to Rob's browser after login |
| `KATY_PASSWORD` / `KATY_SESSION_SECRET` | Same, for Katy |

### Supabase (already in use)
| Var | Purpose |
|---|---|
| `SUPABASE_URL` | e.g. `https://abcd.supabase.co` |
| `SUPABASE_KEY` | service-role or anon key with read access to `demo_new_deeds` |

### Anthropic (required for AI extraction)
| Var | Purpose |
|---|---|
| `ANTHROPIC_DEED_API` | Claude API key — needed by `extract-deed` |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-4-5` |

### Email (Zoho SMTP)
| Var | Purpose |
|---|---|
| `ZOHO_SMTP_USER` | Zoho mailbox address |
| `ZOHO_SMTP_PASSWORD` | Zoho **app-specific** password (not your account password) |
| `ZOHO_SMTP_HOST` | Optional. Defaults to `smtp.zoho.com` |
| `ZOHO_SMTP_PORT` | Optional. Defaults to `465` (SSL) |
| `ZOHO_FROM_NAME` | Optional. Defaults to `RMT Networks` |
| `ZOHO_FROM_ADDRESS` | Optional. Defaults to `ZOHO_SMTP_USER` |

### Backend selection
| Var | Purpose |
|---|---|
| `DEED_SOURCE` | `supabase` (demo, default) · `static` (offline fallback) · `vault` (live) |
| `EMAIL_PROVIDER` | `zoho` (default). Hook in `sendgrid` / `mailgun` in `lib/email-sender.js`. |

### Vault (when going live)
| Var | Purpose |
|---|---|
| `VAULT_API_URL` | Attorney's secure source endpoint, e.g. `https://vault.example.com/api` |
| `VAULT_API_KEY` | Bearer token for that API |

---

## Demo → Live checklist

### 1. Database
- [ ] Run `db/new-deed-schema.sql` in the Supabase SQL editor (creates `demo_new_deeds` + seeds 5 fake rows). This is for the demo only.
- [ ] When live: drop the demo table or leave it isolated. Production data should NOT live in `demo_new_deeds`.

### 2. Data source
- [ ] Implement the attorney's vault adapter in `lib/deed-source.js` (the `listVault` / `getVault` functions are stubs — fill in the correct URL paths, auth, and any field mapping).
- [ ] Set `DEED_SOURCE=vault` in Netlify env.
- [ ] Confirm `/.netlify/functions/list-deeds` returns real records.

### 3. Deed template
The demo renders deeds programmatically with `pdf-lib` in `lib/deed-renderer.js`.
Two upgrade paths when the attorney provides her template:

**Option A — AcroForm PDF (recommended if her template has fillable fields):**
```js
const { PDFDocument } = require('pdf-lib');
const templateBytes = fs.readFileSync('templates/her-new-deed-template.pdf');
const doc = await PDFDocument.load(templateBytes);
const form = doc.getForm();
form.getTextField('GranteeName').setText(deed.grantee_name);
// ...for every field...
form.flatten(); // make non-editable
return doc.save();
```

**Option B — Full HTML rendering (if her template is more complex):**
- Replace `pdf-lib` with `puppeteer-core` + `@sparticuz/chromium` (Lambda-compatible).
- Build the deed as HTML/CSS, render with Chromium.
- Bundle size goes up — may need to move the render function to a longer-running container (Hostinger VPS, n8n, etc.).

### 4. Email
- [ ] Confirm Zoho app password is provisioned for the production mailbox.
- [ ] Update `ZOHO_FROM_ADDRESS` to her firm's domain if it's a per-client mailbox.
- [ ] Consider a custom `Reply-To` header (add to `lib/email-sender.js`) so replies go to her, not the system mailbox.

### 5. Security
- [ ] **Auth boundary** — the demo uses Rob/Katy session tokens. For client-facing live use, add a per-client login (extend `auth.js` and `verify.js`) or move behind her firm's IDP.
- [ ] **Rate-limit** `extract-deed` — Claude API calls cost money. Consider a per-session quota or a simple counter in Supabase.
- [ ] **PII handling** — uploaded deeds may contain SSNs, etc. Confirm Anthropic data-use policy with the attorney before going live, and document in her engagement letter.
- [ ] **No persistence** of uploaded files — currently in-memory only. If you change this, add retention policy + access logging.
- [ ] **Audit log** — `send-deed.js` should write `{timestamp, user, recipient, deed_summary}` to a table. Not present in demo.

### 6. Cost ceiling
- Anthropic vision: ~$0.003 per page extracted (Sonnet pricing as of writing). 100 deeds/month ≈ negligible.
- Netlify functions: free tier covers light usage. Email sends are free via Zoho.
- Supabase: free tier covers demo. Bump only if she stores actual deed records here.

---

## Migrating to n8n (if she wants the workflow on her own infrastructure)

The `lib/` modules can be lifted directly into n8n Function nodes or invoked
from an n8n HTTP Request node. Recommended topology:

```
n8n webhook (file upload)
   ├──▶ Function: extractDeedFields()    → calls Anthropic
   ├──▶ HTTP node: GET vault deed record
   ├──▶ Function: renderDeedPdf()        → returns binary
   └──▶ Email node (SMTP credentials)    → delivers attachment
```

The `lib/*.js` files are pure CommonJS with no Netlify dependencies — paste
them into n8n's Function nodes verbatim. Only `email-sender.js` needs minor
adjustment (n8n usually has its own SMTP node — use that instead of nodemailer).

---

## Local development

```powershell
# Install deps
cd C:\sites\rmtnetworks
npm install

# (One-time) regenerate the sample old-deed PDF
node scripts/generate-sample-deed.js

# Run Netlify dev (loads .env and serves functions locally)
npx netlify dev
```

Set env vars locally in `.env` at the repo root. **Do not commit `.env`.**

---

## Files added by this feature

```
demos/new-deed/
  ├── index.html              # Demo UI (4-step flow + preview + email)
  ├── seed.json               # Fallback seed data (5 fake deeds)
  └── sample-old-deed.pdf     # Pre-generated sample for "Use sample deed instead"

lib/
  ├── deed-source.js          # Adapter: supabase | static | vault
  ├── deed-extractor.js       # Claude vision → JSON fields
  ├── deed-renderer.js        # DeedRecord → PDF (pdf-lib)
  └── email-sender.js         # Provider-agnostic email (Zoho default)

netlify/functions/
  ├── list-deeds.js           # GET — dropdown options
  ├── extract-deed.js         # POST {base64, mediaType} — Claude extraction
  ├── render-deed.js          # POST deed → application/pdf
  └── send-deed.js            # POST {deed, to, subject?, message?} — render + email

db/
  └── new-deed-schema.sql     # Run once in Supabase

scripts/
  └── generate-sample-deed.js # Regenerates sample-old-deed.pdf

DEPLOYMENT.md                 # This file
```

Plus modifications to:
- `portal.html` — added Demo Site tile at top of grid
- `demos.html` — NEW. Hub for the 4 client demos
- `package.json` — added `pdf-lib`, `nodemailer`
