#!/usr/bin/env node
/**
 * Prueba de interfaz del panel de administración (requiere Google Chrome instalado).
 *
 *   node tools/ui-check.mjs [carpeta_de_capturas]
 *
 * Levanta tools/preview-admin.mjs con datos de ejemplo, recorre los flujos principales
 * con Chrome (ficha de miembro, pago, medidas, evaluación, mensajes, asistencia, ajustes,
 * rol de entrenador y móvil), guarda capturas y FALLA si hay errores de JavaScript.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchChrome } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(ROOT, 'ui-shots');
const PORT = 3290;
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const server = spawn('node', [join(ROOT, 'tools', 'preview-admin.mjs'), '--demo'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch (_) { await sleep(100); } }

let step = 0;
const log = msg => console.log(`  ${String(++step).padStart(2, '0')}. ${msg}`);
let failed = false;

async function run(name, fn) {
  console.log('\n' + name);
  try { await fn(); } catch (e) { failed = true; console.log('   ✖ ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n     ')); }
}

try {
  // ---------------------------------------------------------------- Admin, escritorio
  const b = await launchChrome({ width: 1360, height: 900 });

  await run('Admin · escritorio', async () => {
    await b.goto(`${BASE}/?tab=progreso`);
    await b.waitFor('#gb-progress .cp-gb-stat');
    log('Progreso carga con cifras');
    await b.shot(join(OUT, '01-progreso.png'));
    assert.ok((await b.count('#gb-progress [data-open]')) > 3, 'lista de atención');
    assert.ok(await b.count('.cp-gb-count') >= 1, 'contador de mensajes pendientes en el menú');

    await b.click('[data-tab="miembros"]');
    await b.waitFor('#gb-m-list .cp-gb-row');
    log('Miembros lista ' + (await b.count('#gb-m-list .cp-gb-row')) + ' filas');
    await b.shot(join(OUT, '02-miembros.png'));

    await b.type('#gb-m-q', 'maria');
    await sleep(700);
    const filtered = await b.count('#gb-m-list .cp-gb-row');
    assert.ok(filtered > 0 && filtered < 24, 'la búsqueda filtra (' + filtered + ')');
    log('Búsqueda "maria" → ' + filtered);
    await b.type('#gb-m-q', '');
    await b.type('#gb-m-pago', 'vencido');
    await sleep(500);
    log('Filtro vencidos → ' + (await b.count('#gb-m-list .cp-gb-row')));
    await b.type('#gb-m-pago', '');
    await sleep(500);

    await b.click('#gb-m-list .cp-gb-row');
    await b.waitFor('.cp-gb-modal .cp-gb-kv');
    await b.waitFor('.cp-gb-modal [data-act="pay"]');
    log('Ficha abierta: ' + (await b.text('.cp-gb-modal-head h2')));
    await b.shot(join(OUT, '03-ficha.png'));
    assert.ok(await b.count('.cp-gb-modal [data-act="void"]') >= 1, 'el Admin ve los pagos y puede anular');

    // --- Pago
    await b.click('.cp-gb-modal [data-act="pay"]');
    await b.waitFor('.cp-gb-modal [name="montoSel"]');
    await b.shot(join(OUT, '04-form-pago.png'));
    await b.type('.cp-gb-modal [name="montoSel"]', 'otro');
    await b.type('.cp-gb-modal [name="monto"]', '175');
    await b.type('.cp-gb-modal [name="nota"]', 'Pago de prueba');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('[data-msg-act="wa"]');
    log('Pago registrado y boleta lista para WhatsApp');
    await b.shot(join(OUT, '05-pago-boleta.png'));
    const waUrl = await b.evaluate(`document.querySelector('[data-msg-act="wa"]').getAttribute('data-url')`);
    assert.match(waUrl, /^https:\/\/wa\.me\/502\d{8}\?text=/);
    assert.match(decodeURIComponent(waUrl), /Total: Q175/);
    await b.click('[data-msg-act="sent"]');
    await b.waitFor('.cp-gb-msg.is-done');
    log('Mensaje marcado como enviado');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn');   // cerrar

    // --- Medidas
    await b.waitFor('.cp-gb-modal [data-act="measure"]');
    await b.click('.cp-gb-modal [data-act="measure"]');
    await b.waitFor('.cp-gb-modal [name="pesoLb"]');
    assert.ok((await b.evaluate(`document.querySelector('.cp-gb-modal:last-of-type [name="pesoLb"]').value`)) !== '', 'precarga las últimas medidas');
    await b.shot(join(OUT, '06-form-medidas.png'));
    await b.type('.cp-gb-modal:last-of-type [name="pesoLb"]', '150.5');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('.cp-gb-modal-head h2');
    await sleep(500);
    log('Medidas guardadas: ' + (await b.text('.cp-gb-modal:last-of-type .cp-gb-modal-head h2')));
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary'); // preparar reporte
    await b.waitFor('[data-msg-act="wa"]');
    const reportUrl = decodeURIComponent(await b.evaluate(`document.querySelector('[data-msg-act="wa"]').getAttribute('data-url')`));
    assert.match(reportUrl, /\/exec\?reporte=medidas&m=GB-\d+&r=MD-\d+&s=[0-9a-f]{32}/);
    log('Reporte de medidas listo con enlace firmado');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn');

    // --- Evaluación
    await b.click('.cp-gb-modal [data-act="eval"]');
    await b.waitFor('.cp-gb-modal [name="N01"]');
    await b.shot(join(OUT, '07-form-evaluacion.png'), { fullPage: false });
    await b.type('.cp-gb-modal:last-of-type [name="N01"]', '45');
    await b.type('.cp-gb-modal:last-of-type [name="N02"]', '18');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await sleep(600);
    log('Evaluación: ' + (await b.text('.cp-gb-modal:last-of-type .cp-gb-modal-body')).slice(0, 80));
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn');   // Cancelar (no preparar reporte)

    // --- Enviar mensaje (carnet)
    await b.click('.cp-gb-modal [data-act="send"]');
    await b.waitFor('.cp-gb-modal [data-type="carnet"]');
    await b.shot(join(OUT, '08-menu-enviar.png'));
    await b.click('.cp-gb-modal [data-type="carnet"]');
    await b.waitFor('[data-msg-act="wa"]');
    assert.match(decodeURIComponent(await b.evaluate(`document.querySelector('[data-msg-act="wa"]').getAttribute('data-url')`)), /\?carnet=[0-9a-f]{24}/);
    log('Carnet listo para enviar');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn');

    // --- Registrar visita
    await b.click('.cp-gb-modal [data-act="visit"]');
    await sleep(500);
    log('Visita manual registrada');
    await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

    // --- Nuevo miembro: validación y alta
    await b.click('#gb-m-new');
    await b.waitFor('.cp-gb-modal [name="nombres"]');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('.cp-gb-field.has-error');
    log('Validación del formulario: ' + (await b.count('.cp-gb-field.has-error')) + ' campos con error');
    await b.shot(join(OUT, '09-form-miembro-errores.png'));
    await b.type('[name="nombres"]', 'Rosa');
    await b.type('[name="apellidos"]', 'Prueba Gómez');
    await b.type('[name="dpi"]', '2999999999999');
    await b.type('[name="fechaNacimiento"]', '1992-05-20');
    await b.type('[name="telefono"]', '45678901');
    await b.type('[name="genero"]', 'Femenino');
    await b.type('[name="mensualidad"]', '150');
    await b.type('[name="diaPago"]', '10');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('.cp-gb-modal [data-act="pay"]');
    log('Miembro nuevo creado: ' + (await b.text('.cp-gb-modal-head h2')));
    await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

    // --- Mensajes
    await b.click('[data-tab="mensajes"]');
    await b.waitFor('#gb-ms-list .cp-gb-msg');
    log('Bandeja de mensajes: ' + (await b.count('#gb-ms-list .cp-gb-msg')) + ' pendientes');
    await b.shot(join(OUT, '10-mensajes.png'));
    await b.click('#gb-ms-templates');
    await b.waitFor('#gb-tpl-text');
    await b.shot(join(OUT, '11-plantillas.png'));
    await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

    // --- Asistencia
    await b.click('[data-tab="asistencia"]');
    await b.waitFor('#gb-a-list .cp-gb-row');
    await b.type('#gb-a-q', 'an');
    await b.waitFor('#gb-a-results [data-visit]');
    log('Asistencia: ' + (await b.count('#gb-a-list .cp-gb-row')) + ' visitas hoy; búsqueda manual funciona');
    await b.shot(join(OUT, '12-asistencia.png'));

    // --- Ajustes
    await b.click('[data-tab="ajustes"]');
    await b.waitFor('#gb-s-toggle');
    await b.waitFor('#gb-s-pair');
    await b.waitFor('#gb-s-save');
    await b.shot(join(OUT, '13-ajustes.png'), { fullPage: true });
    await b.click('#gb-s-dry');
    await b.waitFor('.cp-gb-modal .cp-gb-table');
    await b.shot(join(OUT, '14-simulacro.png'));
    await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);
    await b.click('#gb-s-review');
    await b.waitFor('.cp-gb-modal .gb-rv');
    await b.shot(join(OUT, '15-revision-estados.png'));
    await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);
    await b.click('#gb-s-pair');
    await b.type('.cp-gb-modal [name="nombre"]', 'Recepción 2');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('.cp-gb-code');
    const code = await b.text('.cp-gb-code');
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    log('Código de emparejamiento: ' + code);
    await b.shot(join(OUT, '16-emparejar.png'));

    assert.deepEqual(b.errors, [], 'errores de JavaScript: ' + b.errors.join(' | '));
    log('Sin errores de JavaScript');
  });
  await b.close();

  // ---------------------------------------------------------------- Entrenador
  const c = await launchChrome({ width: 1360, height: 900 });
  await run('Entrenador (Coach)', async () => {
    await c.goto(`${BASE}/?rol=coach&tab=ajustes`);          // pide una pestaña solo-Admin a propósito
    await c.waitFor('#gb-progress .cp-gb-stat');
    log('Entra a Progreso aunque pidió Ajustes (no tiene permiso)');
    const hidden = await c.evaluate(`Array.prototype.every.call(document.querySelectorAll('[data-role="admin"]'), function(e){ return e.hidden; })`);
    assert.equal(hidden, true, 'las opciones de Admin están ocultas');
    const navTabs = await c.evaluate(`Array.prototype.filter.call(document.querySelectorAll('.cp-nav-item'), function(e){ return !e.hidden; }).map(function(e){ return e.getAttribute('data-tab'); }).join(',')`);
    assert.equal(navTabs, 'progreso,miembros,asistencia,mensajes');
    log('Menú del entrenador: ' + navTabs);
    await c.shot(join(OUT, '20-coach-progreso.png'));

    await c.click('[data-tab="miembros"]');
    await c.waitFor('#gb-m-list .cp-gb-row');
    await c.click('#gb-m-list .cp-gb-row');
    await c.waitFor('.cp-gb-modal .cp-gb-kv');
    assert.equal(await c.count('.cp-gb-modal [data-act="pay"]'), 0, 'sin botón de pago');
    assert.equal(await c.count('.cp-gb-modal [data-act="delete"]'), 0, 'sin botón eliminar');
    const dpi = await c.text('.cp-gb-modal .cp-gb-kv');
    assert.match(dpi, /•••• •••• \d{4}/, 'DPI enmascarado');
    assert.ok(!/Pagos \(/.test(await c.text('.cp-gb-modal-body')), 'sin sección de pagos');
    log('Ficha del entrenador: sin pagos, sin eliminar, DPI enmascarado');
    await c.shot(join(OUT, '21-coach-ficha.png'));

    // el servidor rechaza una acción de Admin aunque se invoque a mano, sin cerrar la sesión
    const res = await c.evaluate(`new Promise(function(resolve){ cpRun('payments.register', [{memberId:'GB-0001', monto:150}], { busy:false, ok:function(){ resolve('OK'); }, fail:function(m){ resolve(m); } }); })`);
    assert.match(res, /PERM: Tu rol \(Coach\)/);
    assert.equal(await c.evaluate('CP.role'), 'Coach', 'la sesión sigue abierta');
    log('Acción de Admin rechazada por el servidor: ' + res.slice(0, 50));
    assert.deepEqual(c.errors, [], 'errores de JavaScript: ' + c.errors.join(' | '));
  });
  await c.close();

  // ---------------------------------------------------------------- Escáner del tablet (extremo a extremo)
  const rpc = async (fn, args) => {
    const r = await (await fetch(BASE + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) })).json();
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  const adminApi = (action, ...args) => rpc('gbApi', ['', action, args]);

  const t = await launchChrome({ width: 1024, height: 768, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  await run('Escáner del tablet (emparejar y escanear con la página real)', async () => {
    await fetch(BASE + '/');                                              // fija el rol de Admin del servidor
    // Dos miembros que todavía no tienen visita hoy (otros escenarios ya registraron algunas).
    const visited = new Set((await adminApi('attendance.today')).items.map(i => i.memberId));
    const free = (await adminApi('members.search', '', { estado: 'Activo' })).items.filter(m => !visited.has(m.memberId));
    assert.ok(free.length >= 2, 'hay miembros sin visita hoy');
    const ana = free[0], luis = free[1];
    const qr = async m => (await adminApi('wallet.carnet', m.memberId)).qrTexto;
    const pairing = await adminApi('devices.createPairing', 'Tablet de prueba');
    log('Código de emparejamiento creado: ' + pairing.code);

    await t.goto(`${BASE}/checkin/`);
    await t.waitFor('#pair-code');
    assert.equal(await t.evaluate('document.getElementById("pair").hidden'), false, 'pide el código');
    await t.shot(join(OUT, '40-escaner-emparejar.png'));
    await t.type('#pair-code', 'ZZZZ-ZZZZ');
    await t.click('#pair-btn');
    await t.waitFor('(document.getElementById("pair-error").textContent || "").indexOf("no válido") !== -1');
    log('Código falso rechazado');
    await t.type('#pair-code', pairing.code);
    await t.click('#pair-btn');
    await t.waitFor('document.getElementById("start").hidden === false');
    assert.match(await t.text('#start-name'), /Tablet de prueba/);
    log('Tablet emparejado');
    await t.shot(join(OUT, '41-escaner-inicio.png'));

    await t.click('#start-btn');
    await t.waitFor('document.getElementById("scan").hidden === false');
    await t.waitFor('document.getElementById("video").videoWidth > 0');
    log('Cámara (simulada) abierta');
    await t.shot(join(OUT, '42-escaner-camara.png'));

    // La cámara simulada no muestra un QR: se sustituye el lector de QR por uno que devuelve el código dado.
    const feed = code => t.evaluate(`window.__qr = ${JSON.stringify(code)}; window.jsQR = function () { return window.__qr ? { data: window.__qr } : null; }; true`);
    const waitResult = async pattern => {
      await t.waitFor('document.getElementById("result").classList.contains("show")');
      const title = await t.text('#result-title');
      assert.match(title, pattern);
      return title;
    };
    const waitHidden = () => t.waitFor('!document.getElementById("result").classList.contains("show")', 9000);

    await feed(await qr(ana));
    log('Escaneo 1: ' + (await waitResult(/¡bienvenido, /i)));
    await t.shot(join(OUT, '43-escaner-ok.png'));
    await feed('');
    await waitHidden();

    // Un mismo QR dentro de la ventana no se reenvía desde el tablet (anti-rebote local)…
    await feed(await qr(ana));
    await sleep(1200);
    assert.equal(await t.evaluate('document.getElementById("result").classList.contains("show")'), false, 'sin reenviar el mismo QR tan pronto');
    log('El mismo QR no se reenvía de inmediato');
    await feed('');

    // …y pasada la ventana, el servidor responde que ya se registró.
    await sleep(6000);
    await feed(await qr(ana));
    log('Escaneo repetido: ' + (await waitResult(/hola de nuevo/i)));
    await t.shot(join(OUT, '44-escaner-duplicado.png'));
    await feed(''); await waitHidden();

    await feed('GB1:' + '0'.repeat(24));
    log('QR desconocido: ' + (await waitResult(/código no reconocido/i)));
    await feed(''); await waitHidden();

    // Solo se registró UNA visita de ana, y luis todavía ninguna
    const today = await adminApi('attendance.today');
    assert.equal(today.items.filter(i => i.memberId === ana.memberId).length, 1);
    assert.equal(today.items.filter(i => i.memberId === luis.memberId).length, 0);
    assert.ok(today.items.some(i => i.origen === 'QR'));
    log('Asistencia en el servidor: 1 visita QR de ' + ana.nombre.split(' ')[0]);

    // Revocar el tablet: el siguiente escaneo lo desconecta y vuelve a pedir código
    const device = (await adminApi('devices.list')).items.find(d => d.nombre === 'Tablet de prueba');
    await adminApi('devices.revoke', device.id);
    await feed(await qr(luis));
    log('Tablet revocado: ' + (await waitResult(/tablet no autorizado/i)));
    await t.shot(join(OUT, '45-escaner-revocado.png'));
    await t.waitFor('document.getElementById("pair").hidden === false', 9000);
    const after = await adminApi('attendance.today');
    assert.equal(after.items.filter(i => i.memberId === luis.memberId).length, 0, 'un tablet revocado no registra asistencia');
    log('Volvió a la pantalla de emparejamiento');
    assert.deepEqual(t.errors, [], 'errores de JavaScript: ' + t.errors.join(' | '));
  });
  await t.close();

  // ---------------------------------------------------------------- Móvil
  const m = await launchChrome({ width: 390, height: 844, mobile: true });
  await run('Móvil (390 px)', async () => {
    await m.goto(`${BASE}/?tab=progreso`);
    await m.waitFor('#gb-progress .cp-gb-stat');
    await m.shot(join(OUT, '30-movil-progreso.png'));
    await m.click('#cp-menu-toggle');
    await m.click('[data-tab="miembros"]');
    await m.waitFor('#gb-m-list .cp-gb-row');
    await m.shot(join(OUT, '31-movil-miembros.png'));
    await m.click('#gb-m-list .cp-gb-row');
    await m.waitFor('.cp-gb-modal .cp-gb-kv');
    await m.shot(join(OUT, '32-movil-ficha.png'));
    const overflow = await m.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');
    assert.equal(overflow, false, 'sin desplazamiento horizontal de la página');
    log('Sin desbordamiento horizontal');
    assert.deepEqual(m.errors, [], 'errores de JavaScript: ' + m.errors.join(' | '));
  });
  await m.close();
} finally {
  server.kill();
}

console.log('\n' + (failed ? 'HAY FALLAS ✖' : 'Todo correcto ✔') + '  Capturas en ' + OUT);
process.exit(failed ? 1 : 0);
