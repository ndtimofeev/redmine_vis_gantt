const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
async function launch(opts = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined, // default: the browser installed by playwright
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: opts.width || 1400, height: opts.height || 900 }, locale: opts.locale || 'en-US', timezoneId: opts.tz || 'UTC' });
  const page = await context.newPage();
  const problems = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => problems.push(`[requestfailed] ${r.url()} ${r.failure() && r.failure().errorText}`));
  return { browser, context, page, problems };
}
async function login(page, user = 'admin', pass = 'adminadmin1') {
  await page.goto(BASE + '/login');
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await Promise.all([page.waitForNavigation(), page.click('#login-submit')]);
}
module.exports = { launch, login, BASE };
