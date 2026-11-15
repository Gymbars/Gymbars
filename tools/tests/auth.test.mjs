/**
 * Pruebas de autorización (Auth.gs + Api.gs).  Ejecutar:  node --test tools/tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGas, fakeSheet } from './gas-sandbox.mjs';

const CODE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'code');

const TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STUBS = `
  var cpCalls = [];
  function cpGetData_() { cpCalls.push('cpGetData'); return { ok: 'data' }; }
  function cpSaveSite_(rows) { cpCalls.push('cpSaveSite'); return { saved: rows.length }; }
  ['cpSaveImages_','cpSaveCarousel_','cpSaveFeatures_','cpSavePrograms_','cpSaveSchedule_','cpSaveSocial_',
   'cpListImages_','cpUploadImage_','cpCheckImages_','cpRefreshCache_','cpSetupSheets_','cpBackup_']
    .forEach(function (n) { this[n] = function () { return n; }; }, this);
`;

function load(opts = {}) {
  return loadGas(['Auth.gs', 'Api.gs'], { owner: 'owner@gym.test', extra: STUBS, ...opts });
}

const usuarios = rows => ({ Usuarios: fakeSheet([['Email', 'Rol', 'Activo'], ...rows]) });

test('sin token ni usuario activo: gbApi rechaza con AUTH', () => {
  const g = load();
  assert.throws(() => g.ctx.gbApi('', 'cpGetData', []), /AUTH:/);
  assert.equal(g.ctx.cpCalls.length, 0, 'no debe ejecutar la acción');
});

test('token con formato inválido o inexistente se rechaza', () => {
  const g = load();
  assert.throws(() => g.ctx.gbApi('x', 'cpGetData', []), /AUTH:/);
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpGetData', []), /AUTH:/);
});

test('sesión válida del propietario: Admin puede leer y guardar', () => {
  const g = load();
  g.addSession(TOKEN, 'Owner@Gym.test');
  assert.deepEqual({ ...g.ctx.gbApi(TOKEN, 'cpGetData', []) }, { ok: 'data' });
  assert.equal(g.ctx.gbApi(TOKEN, 'cpSaveSite', [[1, 2]]).saved, 2);
});

test('sesión vencida se rechaza y se borra', () => {
  const g = load();
  g.addSession(TOKEN, 'owner@gym.test', -1000);
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpGetData', []), /AUTH:/);
  assert.equal(g.props.has('CP_SESSION_' + TOKEN), false);
});

test('un lector de la hoja NO tiene acceso', () => {
  const g = load({ editors: ['editor@gym.test'] }); // el lector no figura como editor
  g.addSession(TOKEN, 'viewer@gym.test');
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpGetData', []), /AUTH:/);
});

test('sin lista de usuarios, un editor de la hoja es Admin (compatibilidad)', () => {
  const g = load({ editors: ['editor@gym.test'] });
  g.addSession(TOKEN, 'editor@gym.test');
  assert.equal(g.ctx.gbAuth_(TOKEN).role, 'Admin');
});

test('con lista de usuarios, un editor que no está en la lista queda fuera', () => {
  const g = load({
    editors: ['editor@gym.test'],
    sheets: usuarios([['coach@gym.test', 'Coach', 'Si']])
  });
  g.addSession(TOKEN, 'editor@gym.test');
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpGetData', []), /AUTH:/);
});

test('Coach no puede ejecutar acciones de Admin; el propietario sí', () => {
  const g = load({ sheets: usuarios([['coach@gym.test', 'Entrenador', 'Si']]) });
  g.addSession(TOKEN, 'coach@gym.test');
  assert.equal(g.ctx.gbAuth_(TOKEN).role, 'Coach');
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpGetData', []), /PERM: Tu rol \(Coach\)/);
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpBackup', []), /PERM:/);
  assert.equal(g.ctx.cpCalls.length, 0);
});

test('usuario marcado como inactivo no entra', () => {
  const g = load({ sheets: usuarios([['coach@gym.test', 'Coach', 'No'], ['otro@gym.test', 'Admin', 'Si']]) });
  g.addSession(TOKEN, 'coach@gym.test');
  assert.throws(() => g.ctx.gbApi(TOKEN, 'cpGetData', []), /AUTH:/);
});

test('acción inexistente o heredada del prototipo no se ejecuta', () => {
  const g = load();
  g.addSession(TOKEN, 'owner@gym.test');
  assert.throws(() => g.ctx.gbApi(TOKEN, 'noExiste', []), /no disponible/);
  assert.throws(() => g.ctx.gbApi(TOKEN, 'constructor', []), /no disponible/);
  assert.throws(() => g.ctx.gbApi(TOKEN, '__proto__', []), /no disponible/);
});

test('usuario activo de Google (diálogo en la hoja) entra sin token', () => {
  const g = load();
  g.setActiveUser('owner@gym.test');
  assert.deepEqual({ ...g.ctx.gbApi('', 'cpGetData', []) }, { ok: 'data' });
});

test('usuario activo sin permisos y sin token: rechazado', () => {
  const g = load();
  g.setActiveUser('random@gmail.com');
  assert.throws(() => g.ctx.gbApi('', 'cpGetData', []), /AUTH:/);
});

test('el contexto de la llamada se limpia al terminar', () => {
  const g = load();
  g.addSession(TOKEN, 'owner@gym.test');
  g.ctx.gbApi(TOKEN, 'cpGetData', []);
  assert.equal(g.ctx.gbCtx_().email, '');
});

test('cpVerifyAdminAccess conserva el formato anterior y agrega el rol', () => {
  const g = load();
  assert.equal(g.ctx.cpVerifyAdminAccess('').needLogin, true);
  g.addSession(TOKEN, 'owner@gym.test');
  const ok = g.ctx.cpVerifyAdminAccess(TOKEN);
  assert.equal(ok.authorized, true);
  assert.equal(ok.role, 'Admin');
  g.addSession('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', 'viewer@gym.test');
  const no = g.ctx.cpVerifyAdminAccess('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(no.unauthorized, true);
});

test('gbPurgeSessions_ borra solo las vencidas', () => {
  const g = load();
  g.addSession('live-live-live-live-live-1', 'owner@gym.test');
  g.addSession('dead-dead-dead-dead-dead-1', 'owner@gym.test', -5);
  g.ctx.gbPurgeSessions_();
  assert.equal(g.props.has('CP_SESSION_live-live-live-live-live-1'), true);
  assert.equal(g.props.has('CP_SESSION_dead-dead-dead-dead-dead-1'), false);
});

test('el secreto sale de Script Properties y, si falta, usa el histórico con aviso', () => {
  const a = load({ props: { GOOGLE_AUTH_SHARED_SECRET: 'rotado' } });
  assert.equal(a.ctx.gbAuthSecret_(), 'rotado');
  const b = load();
  assert.equal(b.ctx.gbAuthSecret_(), 'legacy-secret');
  assert.ok(b.logs.some(l => l.type === 'seguridad'));
});

test('el registro solo apunta a funciones con nombre privado (termina en _)', () => {
  const src = readFileSync(join(CODE, 'Api.gs'), 'utf8') + readFileSync(join(CODE, 'Modules.gs'), 'utf8');
  const refs = [...src.matchAll(/roles:\s*[A-Z]+,\s*fn:\s*([A-Za-z0-9_]+)/g)].map(m => m[1]);
  assert.ok(refs.length >= 50, 'debe registrar las acciones del panel y de los módulos');
  for (const name of refs) assert.match(name, /_$/, name + ' debe ser privada');
});

test('superficie pública: solo estas funciones pueden llamarse desde el navegador', () => {
  // Cualquier función global de Apps Script cuyo nombre NO termina en _ puede
  // invocarse con google.script.run por cualquier visitante del sitio.
  const ALLOWED = new Set([
    'doGet', 'doPost', 'onOpen', 'include',
    'getWebsiteData', 'getWebsiteUrl',
    'gbApi', 'cpVerifyAdminAccess', 'cpGetGoogleAuthResult', 'cpLogoutAdmin',
    'showAdminPanel',
    'gbDailyJob' // punto de entrada del disparador: solo actúa si lo llama un disparador real
  ]);
  const found = [];
  for (const file of readdirSync(CODE, { recursive: true })) {
    if (!String(file).endsWith('.gs')) continue;
    const text = readFileSync(join(CODE, String(file)), 'utf8');
    for (const m of text.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
      if (!m[1].endsWith('_')) found.push(file + ': ' + m[1]);
    }
  }
  const unexpected = found.filter(f => !ALLOWED.has(f.split(': ')[1]));
  assert.deepEqual(unexpected, [], 'funciones públicas no permitidas: ' + unexpected.join(', '));
});
