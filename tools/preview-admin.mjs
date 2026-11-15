#!/usr/bin/env node
/**
 * Vista previa local del PANEL DE ADMINISTRACIÓN con el backend REAL (.gs) en memoria.
 *
 *   node tools/preview-admin.mjs                 → http://localhost:3200  (rol Admin)
 *   node tools/preview-admin.mjs --demo          → datos de ejemplo (sin datos personales)
 *   PORT=4000 node tools/preview-admin.mjs
 *   http://localhost:3200/?rol=coach             → ver el panel como entrenador
 *   http://localhost:3200/?tab=mensajes          → abrir una pestaña
 *
 * - Sirve code/ConfigPanel/ConfigPanel.html resolviendo los <?!= include() ?> de Apps Script.
 * - `google.script.run` del navegador se redirige a los archivos .gs reales, que corren en un
 *   contexto de Node con hojas en memoria (Schema.gs define las pestañas).
 * - Si existe migration/ (la carpeta que genera tools/migrate-xlsm.py) usa esos datos REALES,
 *   solo en esta computadora; con --demo, o si no existe, genera datos de ejemplo.
 * - Los cambios viven en memoria: al reiniciar vuelven los datos iniciales. No usa clasp.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGas, memSheet } from './tests/gas-sandbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.join(ROOT, 'code');
const PORT = Number(process.env.PORT) || 3200;
const USE_DEMO = process.argv.includes('--demo') || !fs.existsSync(path.join(ROOT, 'migration', 'Miembros.csv'));

const OWNER = 'owner@gym.test';
const COACH = 'coach@gym.test';
let currentRole = 'admin';

// ---------------------------------------------------------------- backend en memoria

const SERVER_FILES = ['Auth.gs', 'Api.gs', 'Schema.gs', 'Repo.gs', 'Rules.gs', 'Members.gs', 'Payments.gs',
  'Measurements.gs', 'Evaluations.gs', 'Messaging.gs', 'Attendance.gs', 'Triggers.gs', 'Wallet.gs', 'Pages.gs',
  'Progress.gs', 'Migration.gs', 'Modules.gs'];

// Funciones del panel del sitio web (ConfigPanelService.gs): aquí solo se simulan.
const SITE_STUBS = `
  function cpGetData_() { return { site: [], images: [], carousel: [], features: [], programs: [], schedule: [], social: [],
    siteGroups: [], system: { tabs: [], folder: {}, backup: {} }, log: [] }; }
  ['cpSaveSite_','cpSaveImages_','cpSaveCarousel_','cpSaveFeatures_','cpSavePrograms_','cpSaveSchedule_','cpSaveSocial_',
   'cpListImages_','cpUploadImage_','cpCheckImages_','cpRefreshCache_','cpSetupSheets_','cpBackup_']
    .forEach(function (n) { this[n] = function () { return { ok: true, message: 'Simulado en la vista previa.' }; }; }, this);
  function cpGetGoogleAuthResult() { return { status: 'pending' }; }
  function cpLogoutAdmin() { return { success: true }; }
`;

function buildBackend() {
  const sheets = {};
  const g = loadGas(SERVER_FILES, {
    owner: OWNER, sheets, activeUser: OWNER, extra: SITE_STUBS,
    baseUrl: `http://localhost:${PORT}/exec`, props: { GB_REPORT_BASE_URL: `http://localhost:${PORT}/exec` }
  });
  const ctx = g.ctx;
  Object.values(ctx.gbSchema_()).forEach(spec => { sheets[spec.name] = memSheet([[...spec.headers]]); });
  sheets['Usuarios'].data.push([COACH, 'Coach', 'Si']);
  sheets['EjerciciosEvaluacion'].data.push(...ctx.gbExerciseSeed_());
  sheets['Plantillas'].data.push(...ctx.gbTemplateSeed_());
  sheets['ConfigGym'].data.push(...ctx.gbConfigSeed_());
  return { g, ctx, sheets };
}

function seedFromMigration(b) {
  const read = name => fs.readFileSync(path.join(ROOT, 'migration', name), 'utf8');
  const result = b.ctx.gbMigrationImport_({
    members: read('Miembros.csv'), payments: read('Pagos.csv'),
    measurements: read('Medidas.csv'), evaluations: read('Evaluaciones.csv')
  });
  if (!result.ok) throw new Error('No se pudo cargar migration/: ' + result.errors.slice(0, 3).join(' | '));
  console.log('Datos REALES de migration/ cargados:', JSON.stringify(result.counts));
}

/** Datos de ejemplo (sin datos personales) para desarrollar la interfaz. */
function seedDemo(b) {
  const { ctx } = b;
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = list => list[Math.floor(rnd() * list.length)];
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, 12);
  const names = ['Ana', 'Luis', 'María', 'Carlos', 'Sofía', 'Diego', 'Valeria', 'Jorge', 'Lucía', 'Pedro', 'Camila', 'Andrés',
    'Daniela', 'Mateo', 'Isabel', 'Héctor', 'Paola', 'Rodrigo', 'Fernanda', 'Gabriel', 'Mónica', 'Esteban', 'Claudia', 'Iván'];
  const surnames = ['Pérez', 'López', 'García', 'Morales', 'Ramírez', 'Castillo', 'Méndez', 'Hernández', 'Reyes', 'Cruz', 'Ortiz', 'Díaz'];
  const fees = [100, 130, 135, 140, 150];

  names.forEach((name, i) => {
    const offsets = [20, 12, 2, -2, -10, -45, null, 25, 8, 1];            // cuándo vence la próxima mensualidad
    const k = offsets[i % offsets.length];
    const due = k === null ? null : addDays(today, k);
    const m = ctx.gbAppend_('members', {
      DPI: String(2000000000000 + i * 7919), Nombres: name, Apellidos: pick(surnames) + ' ' + pick(surnames),
      FechaNacimiento: new Date(1975 + Math.floor(rnd() * 30), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27), 12),
      Telefono: String(40000000 + Math.floor(rnd() * 9999999)), Correo: i % 4 === 0 ? name.toLowerCase().replace(/[^a-z]/g, '') + '@mail.test' : '',
      Genero: i % 3 === 0 ? 'Femenino' : 'Masculino', Mensualidad: pick(fees), DiaPago: due ? due.getDate() : '',
      Estado: i === 9 ? 'Inactivo' : 'Activo', TokenQR: ctx.gbToken_(24), FechaRegistro: addDays(today, -200), Notas: ''
    });
    if (due) {
      const prev = new Date(due.getFullYear(), due.getMonth() - 1, Math.min(due.getDate(), 28), 12);
      for (let p = 0; p < 3; p++) {
        ctx.gbAppend_('payments', { MemberID: m.MemberID, Fecha: new Date(prev.getFullYear(), prev.getMonth() - p, prev.getDate(), 12),
          Monto: m.Mensualidad, ComprobanteToken: ctx.gbToken_(24) });
      }
    }
    for (let t = 0; t < 4; t++) {
      const w = 160 - t * 1.5 + rnd();
      ctx.gbAppend_('measurements', { MemberID: m.MemberID, Fecha: addDays(today, -t * 30 - (i % 12)), Cuello: 37 - t * 0.2, Pecho: 96 + t * 0.3,
        BrazoDer: 30 + t * 0.2, BrazoIzq: 29.5 + t * 0.2, Cintura: 88 - t, Cadera: 95, PiernaDer: 53, PiernaIzq: 53, PesoLb: Math.round(w * 10) / 10 });
    }
    const ev = { MemberID: m.MemberID, Fecha: addDays(today, -40) };
    ['N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07'].forEach((c, j) => { ev[c] = [45, 15, 8, 14, 7, 50, 12][j] + Math.floor(rnd() * 8); });
    if (i % 2 === 0) ['N11', 'N12', 'N13'].forEach((c, j) => { ev[c] = [3, 40, 3][j]; });
    ctx.gbAppend_('evaluations', ev);
  });

  // Control de asistencia en uso desde hace 25 días + visitas recientes.
  ctx.gbConfigSet_('asistencia_desde', ctx.gbFmtDate_(addDays(today, -25)));
  const members = ctx.gbList_('members');
  members.forEach((m, i) => {
    if (i % 4 === 3) return;                                              // algunos no vienen
    for (let d = 0; d < 20; d++) {
      if (rnd() < 0.55) {
        const day = addDays(today, -d - (i % 3));
        ctx.gbAppend_('attendance', { MemberID: m.MemberID, FechaHora: day, Fecha: day, Origen: 'QR', DispositivoID: 'DV-001', EstadoAlMomento: 'al_dia' });
      }
    }
  });
  ctx.gbAppend_('devices', { Nombre: 'Recepción', TokenHash: ctx.gbHash_('demo'), Activo: 'Si', CreadoEn: addDays(today, -10), UltimoUso: today });

  // Algunos mensajes pendientes
  ['recordatorio_pago', 'pago_vencido', 'inactividad'].forEach((type, i) => {
    try { ctx.gbQueueMessage_({ type, memberId: members[i * 2 + 2].MemberID, extra: { dias: 12 } }); } catch (_) { /* sin pagos */ }
  });
  console.log('Datos de EJEMPLO cargados (' + members.length + ' miembros).');
}

const backend = buildBackend();
if (USE_DEMO) seedDemo(backend); else seedFromMigration(backend);

// ---------------------------------------------------------------- plantillas de Apps Script

function render(text, vars, depth = 0) {
  if (depth > 8) throw new Error('include demasiado profundo');
  const include = name => render(fs.readFileSync(path.join(CODE, name + '.html'), 'utf8'), vars, depth + 1);
  return text.replace(/<\?!?=\s*([\s\S]*?)\s*\?>/g, (_, expr) => {
    const fn = new Function('include', ...Object.keys(vars), `return (${expr});`);
    const out = fn(include, ...Object.values(vars));
    return out == null ? '' : String(out);
  });
}

const SHIM = `<script>
window.google = { script: { run: (function () {
  function make(ok, fail) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (fn) { return make(fn, fail); };
      if (name === 'withFailureHandler') return function (fn) { return make(ok, fn); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: String(name), args: args }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j.ok) { if (ok) ok(j.result); } else if (fail) fail({ message: j.error }); })
          .catch(function (e) { if (fail) fail({ message: String(e) }); });
      };
    } });
  }
  return make(null, null);
})() } };
</script>`;

const RPC_ALLOWED = new Set(['gbApi', 'cpVerifyAdminAccess', 'cpGetGoogleAuthResult', 'cpLogoutAdmin']);

function pageHtml(query) {
  const raw = fs.readFileSync(path.join(CODE, 'ConfigPanel', 'ConfigPanel.html'), 'utf8');
  const html = render(raw, {
    activeTab: query.get('tab') || 'miembros', webAppUrl: '', isWebApp: false, googleAuthStartUrl: '', authCallbackUrl: ''
  });
  return html.replace('<head>', '<head>\n' + SHIM);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      currentRole = url.searchParams.get('rol') === 'coach' ? 'coach' : 'admin';   // cada carga de página define el rol
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(pageHtml(url.searchParams));
    }
    if (req.method === 'OPTIONS') {                                   // el escáner (otro origen) pregunta antes de enviar
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/exec') {          // equivale a doPost de Apps Script (tablet)
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch (_) { return res.end(JSON.stringify({ ok: false, error: 'Solicitud no válida.' })); }
        backend.g.setActiveUser('');
        res.end(JSON.stringify(backend.ctx.gbScanApi_(payload)));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/checkin')) {  // página del escáner (carpeta checkin/)
      const rel = url.pathname.replace(/^\/checkin\/?/, '') || 'index.html';
      if (rel === 'config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return res.end(`window.GYMBARS_CONFIG = { apiUrl: 'http://localhost:${PORT}/exec' };`);
      }
      const file = path.join(ROOT, 'checkin', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(path.join(ROOT, 'checkin')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('No encontrado'); }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && url.pathname === '/exec') {          // páginas públicas (boleta, reportes, carnet)
      const p = url.searchParams, ctx = backend.ctx;
      backend.g.setActiveUser('');
      let out;
      if (p.get('comprobante')) out = ctx.gbVoucherPage_(p.get('comprobante'));
      else if (p.get('reporte')) out = ctx.gbReportPage_(p.get('reporte'), p.get('m'), p.get('r'), p.get('s'));
      else if (p.get('carnet')) out = ctx.gbCarnetPage_(p.get('carnet'));
      else { res.writeHead(404); return res.end('No encontrado'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(out.html);
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        try {
          const { fn, args } = JSON.parse(body);
          if (!RPC_ALLOWED.has(fn)) throw new Error('Función no permitida: ' + fn);
          backend.g.setActiveUser(currentRole === 'coach' ? COACH : OWNER);
          const result = backend.ctx[fn](...(args || []));
          res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('No encontrado');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error: ' + err.message);
  }
}).listen(PORT, () => {
  console.log(`Panel de administración (vista previa): http://localhost:${PORT}  — ?rol=coach para ver como entrenador`);
});
