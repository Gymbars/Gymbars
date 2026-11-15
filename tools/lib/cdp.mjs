/**
 * Control mínimo de Chrome por el protocolo DevTools (sin dependencias).
 * Sirve para probar la interfaz de verdad: abrir páginas, hacer clic, escribir,
 * esperar elementos y tomar capturas, además de recoger los errores de consola.
 *
 *   const b = await launchChrome({ width: 1360, height: 900 });
 *   await b.goto('http://localhost:3200/');
 *   await b.waitFor('#gb-progress .cp-gb-stat');
 *   await b.click('[data-tab="miembros"]');
 *   await b.shot('/tmp/captura.png');
 *   b.errors   // errores de JavaScript vistos hasta ahora
 *   await b.close();
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launchChrome({ width = 1360, height = 900, mobile = false, args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'gb-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, ...args, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome no inició')), 15000);
    let buffer = '';
    proc.stderr.on('data', chunk => {
      buffer += chunk;
      const m = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', () => reject(new Error('Chrome se cerró')));
  });

  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find(t => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  const logs = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value !== undefined ? a.value : a.description).join(' ');
      logs.push(msg.params.type + ': ' + text);
      if (msg.params.type === 'error') errors.push('console.error: ' + text);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });

  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const api = {
    errors, logs, send, evaluate,
    async goto(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        if ((await evaluate('document.readyState')) === 'complete') break;
      }
      await sleep(300);
    },
    async waitFor(selectorOrExpr, timeout = 8000) {
      const expr = /^[#.\[]|^[a-z]+[\s.#\[>:]|^[a-z]+$/i.test(selectorOrExpr) && !selectorOrExpr.includes('=>') && !selectorOrExpr.includes('(')
        ? `!!document.querySelector(${JSON.stringify(selectorOrExpr)})` : selectorOrExpr;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expr).catch(() => false)) return true;
        await sleep(100);
      }
      throw new Error('Tiempo agotado esperando: ' + selectorOrExpr);
    },
    async click(selector) {
      await api.waitFor(selector);
      await evaluate(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); el.click(); })()`);
      await sleep(150);
    },
    async type(selector, value) {
      await api.waitFor(selector);
      await evaluate(`(function(){ var el = document.querySelector(${JSON.stringify(selector)});
        var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      await sleep(100);
    },
    async text(selector) {
      return evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`);
    },
    async count(selector) {
      return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    },
    async shot(path, { fullPage = false } = {}) {
      let clip;
      if (fullPage) {
        const m = await send('Page.getLayoutMetrics');
        const h = Math.ceil(m.cssContentSize.height);
        await send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h, 6000), deviceScaleFactor: 1, mobile });
        await sleep(150);
      }
      const r = await send('Page.captureScreenshot', { format: 'png', clip });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      if (fullPage) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      return path;
    },
    async close() {
      try { ws.close(); } catch (_) {}
      proc.kill();
      await sleep(200);
      try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    }
  };
  return api;
}
