/**
 * Pruebas de la lógica del escáner del tablet (checkin/scanner-core.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require(join(ROOT, 'checkin', 'scanner-core.js'));

const TOKEN = 'a'.repeat(40);
const QR = 'GB1:' + 'ab12'.repeat(6);

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
/** fetch falso que responde con las respuestas dadas (o falla). */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { json: async () => next };
  };
  fn.calls = calls;
  return fn;
}
const noSleep = () => Promise.resolve();

test('parseQr: solo acepta el formato del carnet', () => {
  assert.equal(core.parseQr(QR), QR);
  assert.equal(core.parseQr('  ' + QR + '\n'), QR);
  for (const bad of ['', null, undefined, 'hola', 'GB1:123', 'GB2:' + 'a'.repeat(24), 'GB1:' + 'g'.repeat(24), 'https://x.co/?q=' + QR, QR + 'extra']) {
    assert.equal(core.parseQr(bad), '', String(bad));
  }
});

test('describeResult: cada respuesta del servidor tiene su mensaje', () => {
  const d = core.describeResult;
  assert.deepEqual({ ...d({ status: 'ok', nombre: 'Ana', pago: { code: 'al_dia' } }) }, { tone: 'ok', title: '¡Bienvenido, Ana!', detail: '' });
  assert.equal(d({ status: 'ok', nombre: 'Ana', pago: { code: 'vencido' } }).tone, 'warn');
  assert.match(d({ status: 'ok', nombre: 'Ana', pago: { code: 'vencido' } }).detail, /Pasa por recepción/);
  assert.equal(d({ status: 'ok', nombre: 'Ana', pago: { code: 'gracia' } }).tone, 'warn');
  assert.equal(d({ status: 'ok', nombre: 'Ana', pago: { code: 'por_vencer' } }).tone, 'ok');
  assert.match(d({ status: 'duplicado', nombre: 'Ana', hora: '08:15' }).detail, /hoy a las 08:15/);
  assert.equal(d({ status: 'duplicado', nombre: 'Ana' }).tone, 'info');
  assert.equal(d({ status: 'sin_membresia', nombre: 'Ana' }).tone, 'bad');
  assert.equal(d({ status: 'desconocido' }).title, 'Código no reconocido');
  assert.equal(d({ status: 'no_autorizado' }).unpair, true);
  assert.equal(d({ status: 'limite', error: 'Espera' }).detail, 'Espera');
  assert.equal(d({ networkError: true }).title, 'Sin conexión');
  assert.equal(d(null).tone, 'bad');
  assert.equal(d({ status: 'raro' }).tone, 'bad');
});

test('describeResult: no inventa datos (sin nombre no escribe "undefined")', () => {
  const view = core.describeResult({ status: 'ok', pago: { code: 'al_dia' } });
  assert.ok(!JSON.stringify(view).includes('undefined'));
});

test('deduper: el mismo código no se reenvía dentro de la ventana, otro código sí', () => {
  const d = core.createDeduper(6000);
  assert.equal(d.shouldSend('A', 0), true);
  assert.equal(d.shouldSend('A', 3000), false);
  assert.equal(d.shouldSend('B', 3100), true);
  assert.equal(d.shouldSend('A', 3200), true, 'volvió a A después de B');
  assert.equal(d.shouldSend('A', 10000), true, 'pasó la ventana');
  d.reset();
  assert.equal(d.shouldSend('A', 10001), true);
});

test('cliente: emparejar guarda el token y escanear lo envía como texto plano (sin preflight)', async () => {
  const storage = memoryStorage();
  const f = fakeFetch([{ ok: true, device: TOKEN, nombre: 'Recepción' }, { ok: true, status: 'ok', nombre: 'Ana' }]);
  const client = core.createClient({ apiUrl: 'https://api.test/exec', fetch: f, storage, sleep: noSleep });
  assert.equal(client.hasDevice(), false);

  const paired = await client.pair(' abcd-efgh ');
  assert.equal(paired.ok, true);
  assert.equal(client.hasDevice(), true);
  assert.equal(client.deviceName(), 'Recepción');
  assert.deepEqual(f.calls[0].body, { action: 'pair', code: 'abcd-efgh' });
  assert.equal(f.calls[0].init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.equal(f.calls[0].init.method, 'POST');

  const res = await client.scan(QR);
  assert.equal(res.status, 'ok');
  assert.deepEqual(f.calls[1].body, { action: 'scan', device: TOKEN, code: QR });
  assert.equal(f.calls[1].url, 'https://api.test/exec');
});

test('cliente: un código de emparejamiento rechazado no guarda nada', async () => {
  const storage = memoryStorage();
  const client = core.createClient({ apiUrl: 'u', storage, sleep: noSleep, fetch: fakeFetch([{ ok: false, error: 'Código no válido o vencido.' }]) });
  const res = await client.pair('ZZZZZZZZ');
  assert.equal(res.ok, false);
  assert.equal(storage.m.size, 0);
});

test('cliente: no envía nada al servidor con un QR inválido o sin tablet emparejado', async () => {
  const f = fakeFetch([]);
  const storage = memoryStorage();
  const client = core.createClient({ apiUrl: 'u', fetch: f, storage, sleep: noSleep });
  assert.equal((await client.scan('hola')).status, 'desconocido');
  assert.equal((await client.scan(QR)).status, 'no_autorizado');
  assert.equal(f.calls.length, 0);
});

test('cliente: si el servidor dice "no autorizado" el tablet se desconecta solo', async () => {
  const storage = memoryStorage();
  storage.setItem(core.STORAGE_KEY, JSON.stringify({ token: TOKEN, name: 'Recepción' }));
  const client = core.createClient({ apiUrl: 'u', storage, sleep: noSleep, fetch: fakeFetch([{ ok: false, status: 'no_autorizado' }]) });
  assert.equal(client.hasDevice(), true);
  await client.scan(QR);
  assert.equal(client.hasDevice(), false);
});

test('cliente: reintenta cuando falla la red y después avisa "sin conexión"', async () => {
  const storage = memoryStorage();
  storage.setItem(core.STORAGE_KEY, JSON.stringify({ token: TOKEN, name: 'x' }));
  const f1 = fakeFetch([new Error('network'), { ok: true, status: 'ok', nombre: 'Ana' }]);
  const c1 = core.createClient({ apiUrl: 'u', storage, sleep: noSleep, fetch: f1 });
  assert.equal((await c1.scan(QR)).status, 'ok');
  assert.equal(f1.calls.length, 2, 'un reintento');

  const f2 = fakeFetch([new Error('a'), new Error('b'), new Error('c')]);
  const c2 = core.createClient({ apiUrl: 'u', storage, sleep: noSleep, fetch: f2, retries: 2 });
  const res = await c2.scan(QR);
  assert.equal(res.networkError, true);
  assert.equal(f2.calls.length, 3);
  assert.equal(core.describeResult(res).title, 'Sin conexión');
  assert.equal(c2.hasDevice(), true, 'un fallo de red no desconecta el tablet');
});

test('cliente: un token guardado dañado se ignora', () => {
  const storage = memoryStorage();
  storage.setItem(core.STORAGE_KEY, '{no es json');
  assert.equal(core.createClient({ apiUrl: 'u', storage, fetch: fakeFetch([]) }).hasDevice(), false);
  storage.setItem(core.STORAGE_KEY, JSON.stringify({ token: 'corto', name: 'x' }));
  assert.equal(core.createClient({ apiUrl: 'u', storage, fetch: fakeFetch([]) }).hasDevice(), false);
});

test('página: carga config.js, la lógica y jsQR; avisa si se abre dentro de otra página', () => {
  const html = readFileSync(join(ROOT, 'checkin', 'index.html'), 'utf8');
  for (const needle of ['src="config.js"', 'src="scanner-core.js"', 'jsQR', 'window.top !== window.self', 'noindex']) {
    assert.ok(html.includes(needle), 'falta ' + needle);
  }
  assert.ok(!/DPI|dpi/.test(html), 'la página nunca maneja el DPI');
  const config = readFileSync(join(ROOT, 'checkin', 'config.js'), 'utf8');
  assert.match(config, /apiUrl: ('';?|'https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec')/, 'apiUrl vacío o un /exec de Apps Script');
});


// ---------------------------------------------------------------- enlaces con tu dominio (checkin/v)

const links = require(join(ROOT, 'checkin', 'link-core.js'));
const EXEC = 'https://script.google.com/macros/s/AKfycbwTEST_-id123/exec';
const T24 = 'ab12cd34ef56ab12cd34ef56';
const S32 = '0123456789abcdef0123456789abcdef';

test('enlaces: el carnet y la boleta se reenvían tal cual al Web App', () => {
  assert.equal(links.buildTarget('?carnet=' + T24, EXEC), EXEC + '?carnet=' + T24);
  assert.equal(links.buildTarget('?comprobante=' + T24, EXEC), EXEC + '?comprobante=' + T24);
});

test('enlaces: el reporte firmado exige tipo, miembro, registro y firma coherentes', () => {
  assert.equal(links.buildTarget(`?reporte=medidas&m=GB-0012&r=MD-00007&s=${S32}`, EXEC), `${EXEC}?reporte=medidas&m=GB-0012&r=MD-00007&s=${S32}`);
  assert.equal(links.buildTarget(`?reporte=evaluacion&m=GB-0012&r=EV-00003&s=${S32}`, EXEC), `${EXEC}?reporte=evaluacion&m=GB-0012&r=EV-00003&s=${S32}`);
  for (const bad of [
    `?reporte=medidas&m=GB-0012&r=EV-00007&s=${S32}`,      // el registro no corresponde al tipo
    `?reporte=evaluacion&m=GB-0012&r=MD-00007&s=${S32}`,
    `?reporte=otro&m=GB-0012&r=MD-00007&s=${S32}`,
    `?reporte=medidas&m=12&r=MD-00007&s=${S32}`,
    `?reporte=medidas&m=GB-0012&r=MD-7&s=${S32}`,
    `?reporte=medidas&m=GB-0012&r=MD-00007&s=corta`,
    `?reporte=medidas&m=GB-0012&r=MD-00007`
  ]) assert.equal(links.buildTarget(bad, EXEC), '', bad);
});

test('enlaces: solo pasan las formas exactas; parámetros extra o intentos de inyección se descartan', () => {
  assert.equal(links.buildTarget('', EXEC), '');
  assert.equal(links.buildTarget('?carnet=corto', EXEC), '');
  assert.equal(links.buildTarget('?carnet=' + 'g'.repeat(24), EXEC), '', 'no hexadecimal');
  assert.equal(links.buildTarget('?page=admin', EXEC), '', 'no se puede abrir el panel por aquí');
  assert.equal(links.buildTarget('?api=data', EXEC), '');
  assert.equal(links.buildTarget('?carnet=' + T24 + '&page=admin&x=http://evil.com', EXEC), EXEC + '?carnet=' + T24, 'lo extra se ignora');
  assert.equal(links.buildTarget('?carnet=' + T24 + '%26page%3Dadmin', EXEC), '', 'el valor codificado no es hexadecimal');
  assert.equal(links.buildTarget('?carnet=https://evil.com/' + T24, EXEC), '');
});

test('enlaces: solo apunta a un /exec de script.google.com (o a localhost si se permite para la vista previa)', () => {
  for (const bad of ['', undefined, 'http://script.google.com/macros/s/AKfy/exec', 'https://evil.com/macros/s/AKfy/exec',
    'https://script.google.com/macros/s/AKfy/dev', 'https://script.google.com/macros/s/AKfy/exec?x=1', 'https://script.google.com/macros/s/AKfy/exec/..//x', 'javascript:alert(1)']) {
    assert.equal(links.buildTarget('?carnet=' + T24, bad), '', String(bad));
  }
  assert.equal(links.buildTarget('?carnet=' + T24, 'http://localhost:3200/exec'), '', 'localhost no se acepta por defecto');
  assert.equal(links.buildTarget('?carnet=' + T24, 'http://localhost:3200/exec', { allowLocal: true }), 'http://localhost:3200/exec?carnet=' + T24);
});

test('enlaces: la página usa el módulo, no admite configuración ajena y no se indexa', () => {
  const html = readFileSync(join(ROOT, 'checkin', 'v', 'index.html'), 'utf8');
  for (const needle of ['../link-core.js', '../config.js', 'buildTarget(location.search', 'noindex', 'no-referrer']) assert.ok(html.includes(needle), needle);
  assert.ok(!/location\.(href|hash)\s*=|window\.open|document\.write/.test(html), 'sin redirecciones libres');
});


test('qr: el enlace personal del carnet se reconoce y se convierte al formato corto', () => {
  const token = 'ab12'.repeat(6);
  const url = 'https://script.google.com/macros/s/AKfy123/exec?carnet=' + token;
  assert.equal(core.parseQr(url), 'GB1:' + token);
  assert.equal(core.parseQr('https://app.midominio.com/v/?carnet=' + token), 'GB1:' + token);
  for (const bad of ['http://x.co/?carnet=' + token, url + '&x=1', url + ' mas', 'https://x.co/?carnet=' + token.slice(2), 'https://x.co/#?carnet=' + token]) {
    assert.equal(core.parseQr(bad), '', bad);
  }
});

test('página: el lector de QR (jsQR) va incluido en la carpeta, no depende de una CDN', () => {
  const html = readFileSync(join(ROOT, 'checkin', 'index.html'), 'utf8');
  assert.ok(html.includes('src="jsQR.js"'));
  assert.ok(!/cdnjs[^"']*jsQR/i.test(html), 'esa ruta de cdnjs no existe (404)');
  const lib = readFileSync(join(ROOT, 'checkin', 'jsQR.js'), 'utf8');
  assert.ok(lib.length > 100000 && /jsQR/.test(lib), 'jsQR.js completo');
});
