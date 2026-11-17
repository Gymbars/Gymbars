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

const rpc = async (fn, args) => {
  const r = await (await fetch(BASE + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) })).json();
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
const adminApi = (action, ...args) => rpc('gbApi', ['', action, args]);
const lag = ms => fetch(`${BASE}/__lag?ms=${ms}`);

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
    // La lista empieza por los que están al día y termina con los de peor estado
    const rank = { al_dia: 0, por_vencer: 1, gracia: 2, vencido: 3, sin_pagos: 4 };
    const list = (await adminApi('progress.overview')).atencion.map(a => rank[a.pago.code]);
    assert.deepEqual(list, [...list].sort((x, y) => x - y), 'orden: al día primero');
    // Días de seguimiento: los miembros sin actividad se ocultan y se ofrece archivarlos
    await adminApi('config.set', 'seguimiento_dias', '7');
    await b.goto(`${BASE}/?tab=progreso`);
    await b.waitFor('#gb-p-archive', 20000);
    assert.match(await b.text('#gb-progress .cp-gb-note'), /sin actividad/);
    await b.click('#gb-p-archive');
    await b.waitFor('.cp-gb-modal [data-act], .cp-gb-modal-foot .cp-btn--primary');
    assert.match(await b.text('.cp-gb-modal'), /Inactivo/);
    await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);
    await adminApi('config.set', 'seguimiento_dias', '0');
    log('Progreso: al día primero; con días de seguimiento aparece el aviso y la opción de archivar');
    await b.goto(`${BASE}/?tab=progreso`);
    await b.waitFor('#gb-progress .cp-gb-stat');
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

    // --- DPI: obligatorio para adultos, opcional para menores de 18
    await b.click('#gb-m-new');
    await b.waitFor('.cp-gb-modal [name="nombres"]');
    const fillKid = async birth => {
      await b.type('[name="nombres"]', 'Niño');
      await b.type('[name="apellidos"]', 'Sin Documento');
      await b.type('[name="fechaNacimiento"]', birth);
      await b.type('[name="telefono"]', '45670011');
      await b.type('[name="genero"]', 'Masculino');
      await b.type('[name="mensualidad"]', '100');
      await b.type('[name="diaPago"]', '12');
    };
    await fillKid('1990-01-01');
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('.cp-gb-field.has-error [name="dpi"]');
    assert.match(await b.text('[data-err="dpi"]'), /obligatorio/);
    await b.type('[name="fechaNacimiento"]', new Date(Date.now() - 10 * 365.25 * 864e5).toISOString().slice(0, 10));
    await b.click('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary');
    await b.waitFor('.cp-gb-modal [data-act="pay"]');
    assert.match(await b.text('.cp-gb-modal-head h2'), /Niño/);
    assert.match(await b.text('.cp-gb-modal'), /Sin DPI \(menor de edad\)/);
    log('Adulto sin DPI se rechaza; un menor se registra sin DPI');
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
  await run('Admin · servidor lento: carga unificada, doble clic, búsqueda instantánea y avisos', async () => {
    const errorsBefore = b.errors.length;
    await lag(700);                                                        // cada respuesta tarda 0,7 s
    try {
      await b.goto(`${BASE}/?tab=miembros`);
      await b.waitFor('#gb-m-list .cp-gb-row', 20000);
      assert.equal(await b.count('#pane-miembros .cp-gb-search-icon'), 1, 'icono de búsqueda en Miembros');
      log('Lista cargada con un servidor lento');

      // --- Carga inicial: el menú se desactiva y elegir otra pestaña a medias no se pierde
      await b.goto(`${BASE}/?tab=progreso`);
      await b.waitFor('document.getElementById("cp-nav").classList.contains("is-booting")', 20000);
      assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.cp-nav-item')).pointerEvents`), 'none', 'menú desactivado al cargar');
      await b.evaluate(`document.querySelector('[data-tab="miembros"]').click()`);    // un clic que se cuela igual se ignora
      await b.waitFor('!document.getElementById("cp-nav").classList.contains("is-booting")', 20000);
      await sleep(300);
      assert.equal(await b.evaluate('CP.tab'), 'progreso', 'la pestaña inicial no se pisa a medias');
      await b.click('[data-tab="miembros"]');
      await b.waitFor('#gb-m-list .cp-gb-row', 20000);
      assert.equal(await b.evaluate('CP.tab'), 'miembros', 'ya con el menú activo se puede cambiar');
      log('Carga inicial: menú desactivado hasta terminar; después cambia de pestaña sin problema');
      await b.goto(`${BASE}/?tab=miembros`);
      await b.waitFor('#gb-m-list .cp-gb-row', 20000);

      // --- Lectura: barra de carga arriba (por encima de las ventanas) y esqueleto, sin textos «Cargando…»
      await b.evaluate(`document.querySelector('#gb-m-list .cp-gb-row').click()`);
      await sleep(350);
      assert.equal(await b.evaluate(`document.getElementById('cp-progress').classList.contains('is-on')`), true, 'barra de carga visible');
      const bar = await b.evaluate(`(function(){ var c = getComputedStyle(document.getElementById('cp-progress')); return { pos: c.position, z: Number(c.zIndex) }; })()`);
      assert.equal(bar.pos, 'fixed');
      const modalZ = await b.evaluate(`Number(getComputedStyle(document.querySelector('.cp-gb-modal')).zIndex)`);
      assert.ok(bar.z > modalZ, 'la barra queda por encima de la ventana (' + bar.z + ' > ' + modalZ + ')');
      assert.ok((await b.count('.cp-gb-modal .cp-skeleton')) >= 1, 'esqueleto mientras carga la ficha');
      assert.ok(!/cargando/i.test(await b.evaluate('document.body.innerText')), 'sin textos «Cargando…»');
      await b.shot(join(OUT, '60-carga-ficha.png'));
      await b.waitFor('.cp-gb-modal [data-act="pay"]', 20000);
      await b.waitFor('!document.getElementById("cp-progress").classList.contains("is-on")');
      log('Barra y esqueleto durante la lectura; desaparecen al terminar');

      // --- Acción que modifica datos: bloquea la ventana y un doble clic crea UN solo pago
      const memberId = await b.evaluate(`GBM.open.memberId`);
      const before = (await adminApi('members.get', memberId)).pagos.length;
      await b.click('.cp-gb-modal [data-act="pay"]');
      await b.waitFor('.cp-gb-modal [name="montoSel"]');
      await b.type('.cp-gb-modal:last-of-type [name="nota"]', 'doble clic');
      await b.evaluate(`(function(){ var btn = document.querySelector('.cp-gb-modal:last-of-type .cp-gb-modal-foot .cp-btn--primary'); btn.click(); btn.click(); btn.click(); })()`);
      await sleep(250);
      const card = await b.evaluate(`(function(){ var c = document.querySelector('.cp-gb-modal:last-of-type .cp-gb-modal-card'); return { blocked: c.classList.contains('is-blocked'), events: getComputedStyle(c).pointerEvents, busy: c.getAttribute('aria-busy') }; })()`);
      assert.deepEqual(card, { blocked: true, events: 'none', busy: 'true' }, 'la ventana queda bloqueada mientras guarda');
      await b.shot(join(OUT, '61-carga-bloqueo.png'));
      await b.waitFor('[data-msg-act="wa"]', 20000);
      const after = (await adminApi('members.get', memberId)).pagos.length;
      assert.equal(after, before + 1, 'tres clics seguidos registraron un solo pago');
      log('Triple clic → un solo pago (' + before + ' → ' + after + ')');
      await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

      // --- Búsqueda instantánea: no llama al servidor por cada letra (con 0,7 s de retraso se nota)
      await b.waitFor('!document.getElementById("cp-progress").classList.contains("is-on")');
      const calls = await b.evaluate('window.__rpcLog.filter(function (x) { return x === "members.search"; }).length');
      await b.type('#gb-m-q', 'MARIA');
      await sleep(120);
      const rows = await b.count('#gb-m-list .cp-gb-row');
      assert.ok(rows >= 1 && rows < 24, 'filtra al instante, sin importar mayúsculas ni tildes (' + rows + ')');
      await sleep(900);
      assert.equal(await b.evaluate('window.__rpcLog.filter(function (x) { return x === "members.search"; }).length'), calls, 'sin llamadas al servidor al buscar');
      log('Búsqueda "MARIA" → ' + rows + ' resultado(s) en menos de 120 ms, 0 llamadas al servidor');
      assert.equal(await b.evaluate(`document.getElementById('gb-m-q-clear').hidden`), false, 'botón de borrar visible');
      await b.click('#gb-m-q-clear');
      assert.ok((await b.count('#gb-m-list .cp-gb-row')) > rows, 'borrar la búsqueda devuelve la lista completa');
      await b.type('#gb-m-q', 'maria');
      await b.evaluate(`document.getElementById('gb-m-q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await b.waitFor('.cp-gb-modal [data-act="pay"]', 20000);
      log('Enter abre el primer resultado');
      await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

      // --- Asistencia: mismo buscador (icono, borrar, búsqueda local)
      await b.click('[data-tab="asistencia"]');
      await b.waitFor('#gb-a-q');
      assert.equal(await b.count('#gb-a-q ~ .cp-gb-search-clear'), 1);
      assert.equal(await b.count('#pane-asistencia .cp-gb-search-icon'), 1);
      await b.type('#gb-a-q', 'maria');
      await b.waitFor('#gb-a-results [data-visit]');
      log('Asistencia: el mismo buscador, también instantáneo');

      // --- El botón tocado muestra que trabaja (plantillas tardaban en abrir sin ninguna señal)
      await b.click('[data-tab="mensajes"]');
      await b.waitFor('#gb-ms-templates');
      await b.waitFor('!document.getElementById("cp-progress").classList.contains("is-on")');
      await b.click('#gb-ms-templates');
      await sleep(300);
      assert.equal(await b.evaluate(`document.getElementById('gb-ms-templates').classList.contains('is-loading')`), true, 'el botón muestra carga');
      assert.equal(await b.evaluate(`getComputedStyle(document.getElementById('gb-ms-templates'), '::after').content`), '""', 'con indicador visible');
      await b.waitFor('#gb-tpl-text', 20000);
      await b.waitFor('!document.getElementById("gb-ms-templates").classList.contains("is-loading")');
      log('Plantillas: el botón muestra carga mientras abre y la recupera después');
      await b.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

      // --- Avisos: error del servidor y error inesperado del navegador
      await b.evaluate(`gbCall('members.get', ['GB-9999'], function () {})`);
      await b.waitFor('.cp-toast--error');
      assert.match(await b.text('.cp-toast--error'), /No se encontró el miembro/);
      log('Error del servidor → aviso: ' + (await b.text('.cp-toast--error')).trim());
      await b.evaluate(`document.getElementById('cp-toasts').innerHTML = ''; window.dispatchEvent(new ErrorEvent('error', { message: 'prueba' }))`);
      await b.waitFor('.cp-toast--error');
      assert.match(await b.text('.cp-toast--error'), /error inesperado/);
      log('Error inesperado del navegador → aviso');
    } finally {
      await lag(0);
    }
    assert.deepEqual(b.errors.slice(errorsBefore), [], 'errores de JavaScript: ' + b.errors.slice(errorsBefore).join(' | '));
  });
  await b.close();

  // ---------------------------------------------------------------- Entrenador
  const c = await launchChrome({ width: 1360, height: 900 });
  await run('Entrenador (Coach)', async () => {
    const target = (await adminApi('members.search', '', {})).items[3];             // el rol aún es Admin: se lee el DPI completo
    const targetDpi = (await adminApi('members.get', target.memberId)).member.dpi;
    assert.match(targetDpi, /^\d{13}$/);
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
    await c.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(m){ m.remove(); }); GB.modals.length = 0;`);

    // El entrenador no tiene el DPI completo en su lista: buscarlo entero cae al servidor, que sí lo encuentra.
    await c.type('#gb-m-q', targetDpi);
    await c.waitFor('#gb-m-list .cp-gb-row', 6000);
    assert.equal(await c.count('#gb-m-list .cp-gb-row'), 1);
    assert.match(await c.text('#gb-m-list .cp-gb-name'), new RegExp(target.nombre.split(' ')[0], 'i'));
    assert.ok(!JSON.stringify(await c.evaluate('GB.members.items')).includes(targetDpi), 'el DPI completo nunca estuvo en el navegador del entrenador');
    log('Búsqueda por DPI completo del entrenador: encontrada por el servidor, sin exponer el DPI');

    // el servidor rechaza una acción de Admin aunque se invoque a mano, sin cerrar la sesión
    const res = await c.evaluate(`new Promise(function(resolve){ cpRun('payments.register', [{memberId:'GB-0001', monto:150}], { busy:false, ok:function(){ resolve('OK'); }, fail:function(m){ resolve(m); } }); })`);
    assert.match(res, /PERM: Tu rol \(Coach\)/);
    assert.equal(await c.evaluate('CP.role'), 'Coach', 'la sesión sigue abierta');
    log('Acción de Admin rechazada por el servidor: ' + res.slice(0, 50));
    assert.deepEqual(c.errors, [], 'errores de JavaScript: ' + c.errors.join(' | '));
  });
  await c.close();

  // ---------------------------------------------------------------- Escáner del tablet (extremo a extremo)
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

  // ---------------------------------------------------------------- Páginas públicas: carnet, dominio propio y cámara
  const pp = await launchChrome({ width: 430, height: 900, mobile: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  await run('Páginas públicas (carnet, enlaces con dominio propio, prueba de cámara)', async () => {
    await fetch(BASE + '/');                                             // rol Admin
    const person = (await adminApi('members.search', '', { estado: 'Activo' })).items[0];
    const card = await adminApi('wallet.carnet', person.memberId);
    const token = card.enlace.split('carnet=')[1];

    await pp.goto(card.enlace);
    await pp.waitFor('#qrimg');
    assert.equal(await pp.evaluate(`document.getElementById('apple-tip').hidden`), true, 'el aviso de iPhone está oculto en otros dispositivos');
    assert.ok(!/wallet/i.test(await pp.evaluate('document.body.innerText')), 'sin «Wallet» visible fuera de un iPhone');
    log('Carnet en un dispositivo normal: sin texto de Wallet');
    await pp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    await pp.goto(card.enlace);
    await pp.waitFor('document.getElementById("apple-tip").hidden === false');
    assert.match(await pp.text('#apple-tip'), /Agregar pase a Wallet/);
    await pp.shot(join(OUT, '70-carnet-iphone.png'), { fullPage: true });
    log('Carnet en iPhone: aparece el aviso de Wallet');
    await pp.send('Emulation.setUserAgentOverride', { userAgent: '' });

    // Enlace con el dominio propio: la página muestra la del Web App y conserva la dirección
    await pp.goto(`${BASE}/checkin/v/?carnet=${token}&otro=http://evil.example`);
    await pp.waitFor('document.getElementById("app").hidden === false');
    await pp.waitFor(`(function(){ var d = document.getElementById('app').contentDocument; return !!(d && d.querySelector('h1') && /\\S/.test(d.querySelector('h1').textContent)); })()`);
    const inner = await pp.evaluate(`document.getElementById('app').contentDocument.querySelector('h1').textContent`);
    assert.match(inner.toLowerCase(), new RegExp(person.nombres.toLowerCase().split(' ')[0]));
    assert.equal(await pp.evaluate(`new URL(document.getElementById('app').src).search`), '?carnet=' + token, 'solo se reenvía el parámetro válido');
    assert.ok((await pp.evaluate('location.href')).startsWith(`${BASE}/checkin/v/`), 'la barra de direcciones conserva el dominio propio');
    log('Enlace por dominio propio muestra el carnet de ' + inner.trim());
    await pp.goto(`${BASE}/checkin/v/?carnet=no-es-valido`);
    await pp.waitFor('document.getElementById("msg").hidden === false');
    assert.equal(await pp.evaluate('document.getElementById("app").hidden'), true);
    await pp.goto(`${BASE}/checkin/v/?page=admin`);
    await pp.waitFor('document.getElementById("msg").hidden === false');
    log('Enlaces inválidos o que intentan abrir el panel: «Enlace no válido»');

    // Prueba de cámara dentro de la página de Apps Script
    await pp.goto(`${BASE}/exec?page=camera`);
    await pp.click('#go');
    await pp.waitFor('document.getElementById("out").textContent.indexOf("✔") !== -1', 8000);
    log('Prueba de cámara: ' + (await pp.text('#out')).trim().slice(0, 60));
    assert.deepEqual(pp.errors, [], 'errores de JavaScript: ' + pp.errors.join(' | '));
  });
  await pp.close();

  // ---------------------------------------------------------------- Móvil
  const m = await launchChrome({ width: 390, height: 844, mobile: true });
  await run('Móvil (390 px)', async () => {
    await m.goto(`${BASE}/?tab=progreso`);
    await m.waitFor('#gb-progress .cp-gb-stat');
    await m.shot(join(OUT, '30-movil-progreso.png'));
    await m.click('#cp-menu-toggle');
    await sleep(350);
    const menu = JSON.parse(await m.evaluate(`(function () {
      var rail = document.getElementById('cp-rail'), bar = document.querySelector('.cp-topbar').getBoundingClientRect(), r = rail.getBoundingClientRect();
      var label = rail.querySelector('.cp-nav-label').getBoundingClientRect(), first = rail.querySelector('.cp-nav-item').getBoundingClientRect();
      return JSON.stringify({ belowBar: r.top >= bar.bottom - 1, labelVisible: label.top >= r.top && label.height > 0, firstItemVisible: first.top >= r.top + label.height, gap: Math.round(label.top - r.top) });
    })()`));
    assert.ok(menu.belowBar && menu.labelVisible && menu.firstItemVisible && menu.gap >= 8, 'el menú no queda tapado por la barra: ' + JSON.stringify(menu));
    await m.shot(join(OUT, '35-movil-menu.png'));
    log('Móvil: el menú empieza bajo la barra; se ve «Gimnasio» y «Progreso» completos');
    await m.click('[data-tab="miembros"]');
    await m.waitFor('#gb-m-list .cp-gb-row');
    await m.shot(join(OUT, '31-movil-miembros.png'));
    await m.click('#gb-m-list .cp-gb-row');
    await m.waitFor('.cp-gb-modal .cp-gb-kv');
    await m.shot(join(OUT, '32-movil-ficha.png'));
    // La ficha ocupa todo su contenido: el fondo no se corta y lo último (Editar datos, Eliminar…) queda a la vista
    await m.evaluate(`var mo = document.querySelector('.cp-gb-modal:last-of-type'); mo.scrollTop = mo.scrollHeight; true`);
    await sleep(250);
    const ficha = JSON.parse(await m.evaluate(`(function () {
      var mo = document.querySelector('.cp-gb-modal:last-of-type'), card = mo.querySelector('.cp-gb-modal-card'), foot = mo.querySelector('.cp-gb-modal-foot');
      var btns = mo.querySelectorAll('.cp-gb-modal-body [data-act]'), last = btns[btns.length - 1].getBoundingClientRect();
      var limit = foot ? foot.getBoundingClientRect().top : innerHeight;
      return JSON.stringify({ scrolls: mo.scrollHeight > mo.clientHeight + 50, cardCoversContent: card.getBoundingClientRect().height >= mo.scrollHeight - 1, lastButtonVisible: last.bottom <= limit && last.top >= 0, gap: Math.round(limit - last.bottom) });
    })()`));
    assert.ok(ficha.scrolls, 'la ficha es más larga que la pantalla (si no, la prueba no mide nada)');
    assert.ok(ficha.cardCoversContent, 'el fondo de la ficha cubre todo el contenido: ' + JSON.stringify(ficha));
    assert.ok(ficha.lastButtonVisible && ficha.gap >= 16, 'el último botón no queda tapado y tiene espacio abajo: ' + JSON.stringify(ficha));
    await m.shot(join(OUT, '34-movil-ficha-final.png'));
    log('Móvil: la ficha mantiene su fondo hasta el final y deja espacio bajo el último botón (' + ficha.gap + ' px)');
    // «Guardar cambios» va al final del formulario (no flota); la barra superior solo trae correo y salir
    await m.evaluate(`document.querySelectorAll('.cp-gb-modal').forEach(function(x){ x.remove(); }); GB.modals.length = 0; cpSwitchTab('sitio', true); cpMarkDirty(); true`);
    await sleep(400);
    const bar = JSON.parse(await m.evaluate(`(function(){ var e = document.querySelector('#pane-sitio .cp-save-btn'), r = e.getBoundingClientRect(), p = getComputedStyle(e.parentNode); return JSON.stringify({ sticky: p.position === 'sticky', inView: r.top >= 0 && r.bottom <= innerHeight, wide: r.width > 250, note: !document.querySelector('#pane-sitio .cp-dirty').hidden, topbarButtons: document.querySelectorAll('.cp-topbar .cp-btn--primary, .cp-topbar #cp-save, .cp-topbar .cp-dirty').length }); })()`));
    assert.deepEqual(bar, { sticky: false, inView: true, wide: true, note: true, topbarButtons: 0 }, 'guardar visible al final del formulario: ' + JSON.stringify(bar));
    await m.shot(join(OUT, '33-movil-guardar.png'));
    log('Móvil: «Guardar cambios» al final del formulario, visible; sin botón arriba');
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
