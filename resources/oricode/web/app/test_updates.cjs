/* Tests for updates.js with a mocked ServiceWorker in real Chromium. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const appDir = __dirname;
let server, browser, base;

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<textarea id="ta"></textarea><button id="send"></button>
<script src="/app/updates.js"></script></body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/test') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE_HTML); return; }
    const name = decodeURIComponent(req.url.split('?')[0]);
    const file = name.startsWith('/app/') ? path.join(appDir, name.slice(5)) : null;
    if (file && file.startsWith(appDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await new Promise(r => server.close(r)); });

async function newPage(opts = {}) {
  const page = await browser.newPage();
  page.loads = 0;
  page.on('load', () => page.loads++);
  await page.addInitScript(o => {
    window.__msgs = [];
    window.__makeWaiting = o.waiting;
    const listeners = {};
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
        __dispatch(t) { (listeners[t] || []).forEach(f => f()); },
        register() {
          window.__reg = {
            waiting: window.__makeWaiting ? { state: 'installed', postMessage: m => window.__msgs.push(m) } : null,
            installing: null,
            addEventListener() {},
            update() { window.__updateCalled = (window.__updateCalled || 0) + 1; return Promise.resolve(); }
          };
          return Promise.resolve(window.__reg);
        },
        getRegistration() { return Promise.resolve(window.__reg); }
      }
    });
  }, opts);
  await page.goto(base + '/test');
  return page;
}

test('waiting worker shows banner and does NOT reload without acceptance', async () => {
  const page = await newPage({ waiting: true });
  await page.waitForSelector('#oc-update');
  assert.match(await page.locator('#oc-update').innerText(), /Nueva versión disponible/);
  // Simulate a controllerchange anyway (e.g. old worker claiming): must not reload.
  await page.evaluate(() => navigator.serviceWorker.__dispatch('controllerchange'));
  await page.waitForTimeout(700);
  assert.equal(page.loads, 1, 'reloaded without user acceptance');
  await page.close();
});

test('accepted update sends SKIP_WAITING and reloads after controllerchange', async () => {
  const page = await newPage({ waiting: true });
  await page.waitForSelector('#oc-update');
  await page.locator('#oc-update-yes').click();
  await page.waitForFunction(() => window.__msgs.some(m => m.type === 'SKIP_WAITING'));
  await page.evaluate(() => { window.__sentinel = 1; navigator.serviceWorker.__dispatch('controllerchange'); });
  await page.waitForFunction(() => window.__sentinel === undefined, null, { timeout: 3000 });
  assert.ok(page.loads >= 2);
  await page.close();
});

test('reload deferred while generation in flight, then proceeds', async () => {
  const page = await newPage({ waiting: true });
  await page.waitForSelector('#oc-update');
  await page.locator('#send').evaluate(el => el.disabled = true);
  await page.locator('#oc-update-yes').click();
  await page.evaluate(() => navigator.serviceWorker.__dispatch('controllerchange'));
  await page.waitForTimeout(700);
  assert.equal(page.loads, 1, 'reloaded during generation');
  await page.evaluate(() => { window.__sentinel = 1; });
  await page.locator('#send').evaluate(el => el.disabled = false);
  await page.waitForFunction(() => window.__sentinel === undefined, null, { timeout: 3000 });
  await page.close();
});

test('composer draft survives the consent reload', async () => {
  const page = await newPage({ waiting: true });
  await page.waitForSelector('#oc-update');
  await page.locator('#ta').fill('borrador importante');
  await page.locator('#oc-update-yes').click();
  await page.evaluate(() => { window.__sentinel = 1; navigator.serviceWorker.__dispatch('controllerchange'); });
  await page.waitForFunction(() => window.__sentinel === undefined, null, { timeout: 3000 });
  assert.equal(await page.locator('#ta').inputValue(), 'borrador importante');
  await page.close();
});

test('no waiting worker: no banner, no reload', async () => {
  const page = await newPage({ waiting: false });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#oc-update').count(), 0);
  assert.equal(page.loads, 1);
  await page.close();
});
