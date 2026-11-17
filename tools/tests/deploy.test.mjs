/**
 * Pruebas del proceso de despliegue (tools/lib/deploy-lib.mjs) con clasp, git y la red simulados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersionNumber, parseDeployments, checkBranch, smokeOnce, runSmoke, runDeploy, CLASP } from '../lib/deploy-lib.mjs';

const PROD_ID = 'AKfycbwPROD_ID_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STG_ID = 'AKfycbwSTAGING_ID_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CONFIG = {
  staging: { branch: 'develop', clasp: 'code/.clasp.staging.json', deploymentId: STG_ID, url: 'https://script.test/staging/exec' },
  prod: { branch: 'master', clasp: 'code/.clasp.prod.json', deploymentId: PROD_ID, url: 'https://script.test/prod/exec' }
};

// ---------------------------------------------------------------- sitio publicado simulado

/** fetch falso: un sitio sano, con fallos opcionales. */
function fakeSite(over = {}) {
  return async (url, init) => {
    const respond = (body, status = 200) => ({ status, text: async () => body });
    if (init && init.method === 'POST') {
      return respond(over.pingBody || JSON.stringify({ ok: false, status: 'no_autorizado', error: 'Dispositivo no autorizado.' }));
    }
    if (url.includes('?api=health')) return respond(over.healthBody || JSON.stringify({ ok: true, entorno: 'produccion', faltan: [] }));
    if (url.includes('?api=data')) return respond(over.dataBody || JSON.stringify({ site: { nombre: 'Gymbars', telefono: '4799-3217' }, programs: [] }));
    if (url.includes('?carnet=')) return respond(over.carnetBody || '<h1>Enlace no v\\u00e1lido</h1>');
    if (url.includes('?page=admin')) return respond(over.adminBody || '<div class="cp-app">panel</div>', over.adminStatus || 200);
    return respond('?', 404);
  };
}
const names = checks => checks.filter(c => !c.ok).map(c => c.name);

// ---------------------------------------------------------------- clasp / git simulados

/**
 * io de prueba. `script` permite cambiar respuestas: { branch, dirty, remoteSha, deployments, versionOut, testCode,
 * failOn:{push,version,deploy,rollback}, confirm, site }.
 */
function makeIo(script = {}) {
  const calls = [];
  const state = { deployedVersion: null };
  const io = {
    calls,
    log: () => {},
    sleep: async () => {},
    now: () => new Date('2026-11-14T15:30:00Z'),
    confirm: async question => { calls.push(['confirm', question]); return script.confirm !== undefined ? script.confirm : true; },
    git(args) {
      calls.push(['git', ...args]);
      const key = args.join(' ');
      if (key === 'rev-parse --abbrev-ref HEAD') return (script.branch || 'develop') + '\n';
      if (key === 'status --porcelain') return script.dirty ? ' M code/Code.gs\n' : '';
      if (key === 'rev-parse HEAD') return 'aaaaaaa1111\n';
      if (key.startsWith('rev-parse origin/')) return (script.remoteSha || 'aaaaaaa1111') + '\n';
      if (key === 'rev-parse --short HEAD') return 'aaaaaaa\n';
      return '';
    },
    run(cmd, args) {
      calls.push(['run', cmd, ...args]);
      if (cmd === 'node') return { code: script.testCode === undefined ? 0 : script.testCode, stdout: '' };
      const claspArgs = args.slice(4);                    // npx -y CLASP -P <cfg> …
      const sub = claspArgs[0];
      if (sub === 'deployments') {
        return { code: 0, stdout: script.deployments || `3 Deployments.\n- AKfycbxHEADDEPLOY @HEAD \n- ${PROD_ID} @7 - prod abc\n- ${STG_ID} @3 - staging abc\n` };
      }
      if (sub === 'push') return { code: script.failOn?.push ? 1 : 0, stdout: 'Pushed 40 files.' };
      if (sub === 'version') return { code: script.failOn?.version ? 1 : 0, stdout: script.versionOut || 'Created version 12.' };
      if (sub === 'deploy') {
        const isRollback = claspArgs.includes('-d') && /^rollback/.test(claspArgs[claspArgs.indexOf('-d') + 1]);
        if (isRollback && script.failOn?.rollback) return { code: 1, stdout: '' };
        if (!isRollback && script.failOn?.deploy) return { code: 1, stdout: '' };
        state.deployedVersion = Number(claspArgs[claspArgs.indexOf('-V') + 1]);
        return { code: 0, stdout: 'Deployed.' };
      }
      return { code: 0, stdout: '' };
    },
    fetch: script.fetch || null
  };
  io.fetch = script.fetch || fakeSite(script.site || {});
  io.state = state;
  return io;
}
const claspCalls = io => io.calls.filter(c => c[0] === 'run' && c[1] === 'npx').map(c => c.slice(6));   // tras: run npx -y CLASP -P <cfg>
const go = (env, script, options) => {
  const io = makeIo({ branch: env === 'prod' ? 'master' : 'develop', ...script });
  return runDeploy({ env, config: CONFIG, options, io }).then(result => ({ result, io }));
};

// ---------------------------------------------------------------- análisis de la salida de clasp

test('clasp: lee el número de la versión creada', () => {
  assert.equal(parseVersionNumber('Created version 7.'), 7);
  assert.equal(parseVersionNumber('Created version 12'), 12);
  assert.equal(parseVersionNumber('Created version #3 of the project'), 3);
  assert.equal(parseVersionNumber('nada'), null);
  assert.equal(parseVersionNumber(''), null);
  assert.equal(parseVersionNumber(null), null);
});

test('clasp: lee la lista de implementaciones (con número de versión o HEAD)', () => {
  const out = `3 Deployments.\n- ${STG_ID} @HEAD \n- ${PROD_ID} @7 - prod 4a7935a\n- AKfycbxOTRO @12\n`;
  const list = parseDeployments(out);
  assert.deepEqual(list.map(d => [d.id === STG_ID ? 'stg' : d.id === PROD_ID ? 'prod' : 'otro', d.version]), [['stg', 'HEAD'], ['prod', 7], ['otro', 12]]);
  assert.equal(list[1].description, 'prod 4a7935a');
  assert.deepEqual(parseDeployments(''), []);
});

test('rama: cada entorno exige su rama', () => {
  assert.equal(checkBranch({ env: 'prod', branch: 'master', expected: 'master' }).ok, true);
  const bad = checkBranch({ env: 'prod', branch: 'develop', expected: 'master' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rama «master».*«develop»/);
});

// ---------------------------------------------------------------- pruebas del sitio publicado

test('smoke: un sitio sano pasa todas las comprobaciones', async () => {
  const checks = await smokeOnce({ url: CONFIG.prod.url, fetch: fakeSite() });
  assert.equal(checks.length, 6);
  assert.deepEqual(names(checks), []);
});

test('smoke: detecta datos de miembros en el JSON público (campos o DPI de 13 dígitos)', async () => {
  for (const dataBody of [
    JSON.stringify({ site: {}, miembros: [{ DPI: '1' }] }),
    JSON.stringify({ site: { nota: 'DPI 2999999999999 visible' } }),
    JSON.stringify({ site: {}, TokenQR: 'abc' })
  ]) {
    const checks = await smokeOnce({ url: CONFIG.prod.url, fetch: fakeSite({ dataBody }) });
    assert.deepEqual(names(checks), ['El JSON público no filtra datos de miembros'], dataBody);
  }
  // el teléfono del gimnasio (campo "telefono" del sitio) NO es una filtración
  assert.deepEqual(names(await smokeOnce({ url: 'u', fetch: fakeSite() })), []);
});

test('smoke: detecta código viejo, tablet sin control, panel caído y sitio inaccesible', async () => {
  assert.deepEqual(names(await smokeOnce({ url: 'u', fetch: fakeSite({ carnetBody: '<h1>Not found</h1>' }) })), ['Los enlaces inexistentes se rechazan']);
  assert.deepEqual(names(await smokeOnce({ url: 'u', fetch: fakeSite({ pingBody: JSON.stringify({ ok: true }) }) })), ['El tablet no emparejado es rechazado']);
  assert.deepEqual(names(await smokeOnce({ url: 'u', fetch: fakeSite({ adminBody: 'error', adminStatus: 500 }) })), ['El panel carga']);
  const down = await smokeOnce({ url: 'u', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.every(c => !c.ok), true);
  assert.match(down[0].detail, /ECONNREFUSED/);
});

test('smoke: reintenta mientras la versión nueva se propaga y se rinde después de los intentos', async () => {
  let calls = 0;
  const flaky = async (url, init) => { calls++; return calls <= 4 ? { status: 500, text: async () => 'x' } : fakeSite()(url, init); };
  const ok = await runSmoke({ url: 'u', fetch: flaky, attempts: 3, sleep: async () => {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2, 'pasó en el segundo intento');
  const never = await runSmoke({ url: 'u', fetch: async () => ({ status: 500, text: async () => 'x' }), attempts: 3, sleep: async () => {} });
  assert.equal(never.ok, false);
  assert.equal(never.attempts, 3);
});

// ---------------------------------------------------------------- despliegue a staging

test('staging: camino feliz en el orden correcto (comprobar → probar → subir → versionar → publicar → verificar)', async () => {
  const { result, io } = await go('staging');
  assert.equal(result.ok, true);
  assert.equal(result.version, 12);
  assert.equal(result.previousVersion, 3);
  const flow = io.calls.map(c => (c[0] === 'run' && c[1] === 'npx' ? 'clasp ' + c[6] : c[0] === 'run' ? c[1] : c.slice(0, 2).join(' ')));
  const idx = s => flow.findIndex(x => x === s);
  assert.ok(idx('git rev-parse') < idx('git status') && idx('git status') < idx('git fetch') && idx('git fetch') < idx('node'));
  assert.ok(idx('node') < idx('clasp deployments') && idx('clasp deployments') < idx('clasp push') && idx('clasp push') < idx('clasp version') && idx('clasp version') < idx('clasp deploy'));
  assert.deepEqual(claspCalls(io).find(c => c[0] === 'push'), ['push', '-f']);
  const deploy = claspCalls(io).find(c => c[0] === 'deploy');
  assert.deepEqual(deploy.slice(0, 5), ['deploy', '-i', STG_ID, '-V', '12']);
  assert.ok(!io.calls.some(c => c[0] === 'confirm'), 'staging no pide confirmar respaldo');
  assert.equal(io.state.deployedVersion, 12);
});

test('staging: usa el proyecto de staging (-P) y la versión lleva rama, commit y fecha', async () => {
  const { io } = await go('staging');
  const npx = io.calls.find(c => c[0] === 'run' && c[1] === 'npx');
  assert.deepEqual(npx.slice(2, 6), ['-y', CLASP, '-P', 'code/.clasp.staging.json']);
  const version = claspCalls(io).find(c => c[0] === 'version');
  assert.equal(version[1], 'staging aaaaaaa 2026-11-14 15:30');
});

test('rama equivocada, árbol sucio o sin subir: se detiene antes de tocar nada', async () => {
  for (const [script, step, pattern] of [
    [{ branch: 'feature/x' }, 'rama', /rama «develop»/],
    [{ dirty: true }, 'arbol', /cambios sin guardar/],
    [{ remoteSha: 'bbbbbbb2222' }, 'push', /origin\/develop/]
  ]) {
    const { result, io } = await go('staging', script);
    assert.equal(result.ok, false);
    assert.equal(result.step, step);
    assert.match(result.message, pattern);
    assert.equal(claspCalls(io).length, 0, 'no llamó a clasp');
    assert.ok(!io.calls.some(c => c[0] === 'run' && c[1] === 'node'), 'ni siquiera corrió las pruebas');
  }
  const unpushedOk = await go('staging', { remoteSha: 'bbbbbbb2222' }, { allowUnpushed: true });
  assert.equal(unpushedOk.result.ok, true);
});

test('pruebas que fallan: no se sube nada; --skip-tests las omite', async () => {
  const bad = await go('staging', { testCode: 1 });
  assert.equal(bad.result.step, 'pruebas');
  assert.equal(claspCalls(bad.io).length, 0);
  const skipped = await go('staging', { testCode: 1 }, { skipTests: true });
  assert.equal(skipped.result.ok, true);
  assert.ok(!skipped.io.calls.some(c => c[0] === 'run' && c[1] === 'node'));
});

test('sin deploymentId/url configurados: explica cómo crearlos y no sube nada', async () => {
  const io = makeIo({ branch: 'develop' });
  const result = await runDeploy({ env: 'staging', config: { ...CONFIG, staging: { ...CONFIG.staging, deploymentId: '', url: '' } }, options: {}, io });
  assert.equal(result.step, 'config');
  assert.match(result.message, /Nueva implementación/);
  assert.equal(claspCalls(io).length, 0);
});

test('una implementación que no existe en ese proyecto se detecta antes de subir', async () => {
  const { result, io } = await go('staging', { deployments: `1 Deployment.\n- AKfycbxOTRO @1\n` });
  assert.equal(result.ok, false);
  assert.match(result.message, /no existe en ese proyecto/);
  assert.ok(!claspCalls(io).some(c => c[0] === 'push'));
});

test('si clasp no puede crear la versión, avisa que el código ya está subido', async () => {
  const { result } = await go('staging', { versionOut: 'algo raro' });
  assert.equal(result.step, 'version');
  assert.match(result.message, /ya está subido/);
});

test('staging con smoke fallido: informa pero no revierte (no hay versión anterior que proteger)', async () => {
  const { result, io } = await go('staging', { site: { adminBody: 'error', adminStatus: 500 } });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'smoke');
  assert.equal(result.rolledBack, undefined);
  assert.equal(claspCalls(io).filter(c => c[0] === 'deploy').length, 1);
});

test('simulacro: revisa todo y lee la versión actual, pero no sube, versiona ni publica', async () => {
  const { result, io } = await go('prod', {}, { dryRun: true, yes: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.previousVersion, 7);
  assert.deepEqual(claspCalls(io).map(c => c[0]), ['deployments']);
});

// ---------------------------------------------------------------- despliegue a producción

test('producción: exige confirmar el respaldo; sin confirmar no sube nada', async () => {
  const declined = await go('prod', { confirm: false });
  assert.equal(declined.result.step, 'respaldo');
  assert.equal(claspCalls(declined.io).length, 0);
  assert.match(declined.io.calls.find(c => c[0] === 'confirm')[1], /respaldo/i);

  const ok = await go('prod', { confirm: true });
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.previousVersion, 7);
  assert.deepEqual(claspCalls(ok.io).find(c => c[0] === 'deploy').slice(0, 5), ['deploy', '-i', PROD_ID, '-V', '12']);

  const skipped = await go('prod', { confirm: false }, { yes: true });
  assert.equal(skipped.result.ok, true, '--yes omite la pregunta');
  assert.ok(!skipped.io.calls.some(c => c[0] === 'confirm'));
});

test('producción solo desde master, no desde develop', async () => {
  const io = makeIo({ branch: 'develop' });
  const result = await runDeploy({ env: 'prod', config: CONFIG, options: { yes: true }, io });
  assert.equal(result.step, 'rama');
  assert.equal(claspCalls(io).length, 0);
});

test('producción apuntando a HEAD no se puede revertir: se niega a desplegar', async () => {
  const { result, io } = await go('prod', { deployments: `1 Deployment.\n- ${PROD_ID} @HEAD \n` }, { yes: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /apunta a HEAD/);
  assert.ok(!claspCalls(io).some(c => c[0] === 'push'));
});

test('producción: si las pruebas del sitio fallan vuelve SOLA a la versión anterior', async () => {
  // El sitio responde mal con la versión nueva (12) y bien después de volver a la 7.
  let io;
  const site = fakeSite();
  const broken = fakeSite({ carnetBody: '<h1>Not found</h1>' });
  const fetchByVersion = (url, init) => (io.state.deployedVersion === 12 ? broken : site)(url, init);
  io = makeIo({ branch: 'master', fetch: fetchByVersion });
  const result = await runDeploy({ env: 'prod', config: CONFIG, options: { yes: true }, io });

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackHealthy, true);
  assert.equal(result.previousVersion, 7);
  const deploys = claspCalls(io).filter(c => c[0] === 'deploy');
  assert.deepEqual(deploys.map(c => c[c.indexOf('-V') + 1]), ['12', '7'], 'publicó la 12 y volvió a la 7');
  assert.match(deploys[1][deploys[1].indexOf('-d') + 1], /^rollback/);
  assert.equal(io.state.deployedVersion, 7);
  assert.match(result.message, /se revirtió a la versión 7/);
});

test('producción: si ni siquiera se puede volver atrás, da la instrucción manual', async () => {
  const { result } = await go('prod', { site: { carnetBody: 'viejo' }, failOn: { rollback: true } }, { yes: true });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'rollback');
  assert.match(result.message, /NO se pudo volver atrás.*versión 7/);
});

test('producción: si la publicación misma falla, no queda nada a medias sin avisar', async () => {
  const { result, io } = await go('prod', { failOn: { deploy: true } }, { yes: true });
  assert.equal(result.step, 'deploy');
  assert.equal(result.version, 12);
  assert.equal(io.state.deployedVersion, null, 'la implementación no se movió');
});

test('producción exitosa: imprime el comando exacto para volver atrás', async () => {
  const lines = [];
  const io = makeIo({ branch: 'master' });
  io.log = m => lines.push(m);
  await runDeploy({ env: 'prod', config: CONFIG, options: { yes: true }, io });
  const hint = lines.find(l => l.includes('Para volver atrás'));
  assert.ok(hint.includes(`-P code/.clasp.prod.json deploy -i ${PROD_ID} -V 7`), hint);
});


// ---------------------------------------------------------------- guardia del repositorio

import { scanRepository } from '../lib/guard-lib.mjs';

const files = map => [Object.keys(map), p => (p in map ? map[p] : null)];

test('guardia: bloquea datos personales y credenciales rastreadas por git', () => {
  const [list, read] = files({ 'migration/Miembros.csv': 'x', 'CONTROL GYMBRAS.xlsm': null, 'code/.clasprc.json': '{}', '.env': 'A=1', 'llave.pem': 'x', 'code/Code.gs': '// ok' });
  const { errors } = scanRepository(list, read);
  assert.equal(errors.length, 5);
  assert.ok(errors.some(e => e.startsWith('migration/Miembros.csv')));
  assert.ok(!errors.some(e => e.startsWith('code/Code.gs')));
});

test('guardia: detecta secretos nuevos pero tolera (con aviso) los de la lista base', () => {
  const secret = "var GOOGLE_AUTH_SHARED_SECRET = '" + 'ab12'.repeat(16) + "';";
  const [list, read] = files({ 'code/Code.gs': secret, 'code/Nuevo.gs': secret, 'x.json': '{"k":"ctx7sk-' + 'a'.repeat(30) + '"}' });
  const baseline = [{ file: 'code/Code.gs', pattern: 'secreto-hex' }, { file: 'viejo.txt', pattern: 'ctx7sk' }];
  const { errors, warnings } = scanRepository(list, read, baseline);
  assert.deepEqual(errors.map(e => e.split(':')[0]).sort(), ['code/Nuevo.gs', 'x.json']);
  assert.ok(warnings.some(w => w.startsWith('code/Code.gs') && w.includes('conocido')));
  assert.ok(warnings.some(w => w.startsWith('viejo.txt') && w.includes('ya no aparece')), 'avisa de entradas obsoletas');
});

test('guardia: el código real del repositorio no tiene secretos nuevos', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url).pathname;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const baseline = JSON.parse(readFileSync(root + 'tools/guard-baseline.json', 'utf8'));
  const read = f => { try { const b = readFileSync(root + f); return b.length > 2_000_000 || b.includes(0) ? null : b.toString('utf8'); } catch (_) { return null; } };
  const { errors } = scanRepository(tracked, read, baseline);
  assert.deepEqual(errors, []);
});


test('smoke: si la hoja no tiene las pestañas nuevas lo dice con claridad y qué hacer', async () => {
  const sheet = JSON.stringify({ ok: false, entorno: 'produccion', faltan: ['Miembros', 'Dispositivos'] });
  const checks = await smokeOnce({ url: 'u', fetch: fakeSite({ healthBody: sheet }) });
  const bad = checks.find(c => !c.ok);
  assert.equal(bad.name, 'La hoja tiene todas las pestañas del sistema');
  assert.match(bad.detail, /Miembros, Dispositivos/);
  assert.match(bad.detail, /Crear pestañas faltantes/);
  // Código viejo: no entiende la comprobación y devuelve el sitio en HTML
  const old = await smokeOnce({ url: 'u', fetch: fakeSite({ healthBody: '<html>sitio</html>' }) });
  assert.equal(old.find(c => !c.ok).name, 'La hoja tiene todas las pestañas del sistema');
});

test('prod con hoja sin preparar: revierte y, al volver a la versión anterior, solo exige que el panel responda', async () => {
  const sheet = JSON.stringify({ ok: false, entorno: 'produccion', faltan: ['Miembros'] });
  const inner = fakeSite({ healthBody: sheet, carnetBody: '<h1>Error</h1>', pingBody: '{"ok":false,"status":"error"}' });
  const { result, io } = await go('prod', { fetch: inner }, { yes: true });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackHealthy, true, 'el panel responde, así que la versión anterior está sana');
  assert.ok(io.state.deployedVersion === 7, 'producción quedó en la versión anterior');
});
