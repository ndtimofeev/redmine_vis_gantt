// What the user sees when the chart script cannot do its job: a message instead of an empty page.
const { launch, login, BASE } = require('./lib');
const SP = process.argv[2] || '.';
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!ok) failed++; };

async function scenario(name, route, verify) {
  const { browser, page } = await launch({ width: 1200, height: 600 });
  await login(page);
  if (route) await page.route(route.pattern, route.handler);
  await page.goto(BASE + '/projects/demo/vis_gantt');
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const box = document.getElementById('vis-gantt');
    return {
      text: box ? box.innerText.trim() : null,
      alert: !!(box && box.querySelector('.flash.error')),
      loading: !!(box && box.querySelector('.vg-loading')),
      timeline: !!(box && box.querySelector('.vis-timeline')),
    };
  });
  await page.screenshot({ path: `${SP}/failure_${name}.png` });
  verify(state);
  await browser.close();
}

(async () => {
  await scenario('ok', null, s => check('normal page: no placeholder, no alert, timeline drawn', !s.loading && !s.alert && s.timeline));

  await scenario('library_404', { pattern: /vis-timeline-graph2d.*\.js/, handler: r => r.fulfill({ status: 404, body: 'not found' }) },
    s => check('library 404 -> visible error that names the library', s.alert && /vis-timeline library did not load/i.test(s.text) && !s.loading, s.text));

  await scenario('script_404', { pattern: /plugin_assets\/redmine_vis_gantt\/vis_gantt-?[0-9a-f]*\.js/, handler: r => r.fulfill({ status: 404, body: 'not found' }) },
    s => check('plugin script 404 -> the "loading" text stays and points to the console', s.loading && /did not load or failed/.test(s.text) && !s.timeline, s.text));

  await scenario('script_crash', { pattern: /vis-timeline-graph2d.*\.js/, handler: r => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.vis = {};' }) },
    s => check('script crash at start -> visible error with the reason', s.alert && /did not start/i.test(s.text) && !s.loading, s.text));

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
