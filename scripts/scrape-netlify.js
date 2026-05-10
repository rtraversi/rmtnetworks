// Scrapes Netlify billing page for current credit balance and writes to Supabase.
// Run via GitHub Actions — requires NETLIFY_EMAIL, NETLIFY_PASSWORD, SUPABASE_URL, SUPABASE_KEY.

const { chromium } = require('playwright');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const NL_EMAIL = process.env.NETLIFY_EMAIL;
const NL_PASS  = process.env.NETLIFY_PASSWORD;

async function patchMetric(service, metric, usedValue) {
  const url = `${SB_URL}/rest/v1/usage_metrics`
    + `?service_name=eq.${encodeURIComponent(service)}`
    + `&metric_name=eq.${encodeURIComponent(metric)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ used_value: usedValue, last_updated: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${await res.text()}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('Navigating to Netlify login...');
    await page.goto('https://app.netlify.com/login', { waitUntil: 'load', timeout: 90000 });
    await page.waitForTimeout(3000);

    // Click "Log in with email" option
    const emailBtn = page.locator('a[href*="email"], button:has-text("Email"), a:has-text("Email")').first();
    await emailBtn.click();
    await page.waitForTimeout(2000);

    console.log('Filling login form...');
    await page.fill('input[name="email"], input[type="email"]', NL_EMAIL);
    await page.fill('input[name="password"], input[type="password"]', NL_PASS);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForURL('**/app.netlify.com/**', { timeout: 30000 });
    console.log('Logged in. Current URL:', page.url());

    // Navigate to billing page
    console.log('Navigating to billing...');
    await page.goto('https://app.netlify.com/teams/rtraversi/billing', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    console.log('Billing URL:', page.url());

    // Wait a moment for dynamic content to load
    await page.waitForTimeout(3000);

    // Dump page text so we can find the right selector
    const bodyText = await page.locator('body').innerText();
    console.log('--- PAGE TEXT SAMPLE ---');
    // Print lines containing "credit" (case insensitive)
    const creditLines = bodyText.split('\n').filter(l => /credit/i.test(l));
    console.log(creditLines.join('\n'));
    console.log('--- END SAMPLE ---');

    // Try to find credit balance — look for number near "credit" text
    const creditsText = creditLines.find(l => /[\d,]+\.?\d*\s*(credits?|available)/i.test(l));
    if (creditsText) {
      const match = creditsText.match(/([\d,]+\.?\d*)/);
      if (match) {
        const available = parseFloat(match[1].replace(/,/g, ''));
        console.log(`Credits available: ${available}`);

        // Get total from Supabase to calculate used
        const sbRes = await fetch(
          `${SB_URL}/rest/v1/usage_metrics?service_name=eq.Netlify&metric_name=eq.credits&select=limit_value`,
          { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
        );
        const sbData = await sbRes.json();
        const total = sbData[0]?.limit_value ?? 3000;
        const used = Math.max(0, total - available);
        console.log(`Total: ${total}, Used: ${used}`);

        await patchMetric('Netlify', 'credits', used);
        console.log('Supabase updated successfully.');
      } else {
        console.log('Could not parse credit number from:', creditsText);
        process.exit(1);
      }
    } else {
      console.log('No credit-related text found. All lines:', bodyText.split('\n').slice(0, 50).join('\n'));
      process.exit(1);
    }

  } catch (e) {
    console.error('Error:', e.message);
    try { await page.screenshot({ path: `screenshot-error-${Date.now()}.png`, fullPage: true }); } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
