/**
 * Lógica de despliegue (sin efectos propios: todo lo externo entra por `io`, así se puede probar).
 *
 * Qué hace un despliegue (staging o prod):
 *   1. Comprueba la rama, que el árbol esté limpio y que lo local esté subido a GitHub.
 *   2. Corre las pruebas.
 *   3. (prod) Pide confirmar que se hizo el respaldo de la hoja.
 *   4. Anota en qué versión está hoy la implementación (para poder volver).
 *   5. Sube el código, crea una versión y mueve la implementación a ella.
 *   6. Prueba el sitio ya publicado (smoke tests).
 *   7. Si fallan y es prod: vuelve SOLA a la versión anterior.
 */

export const CLASP = '@google/clasp@3.3.0';

// ------------------------------------------------------------ salida de clasp

/** "Created version 7." → 7 (o null si no se reconoce). */
export function parseVersionNumber(output) {
  const m = String(output || '').match(/version\s+#?(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Salida de `clasp deployments`:  "- AKfy… @7 - descripción"  o  "@HEAD".
 * @return {{id:string, version:(number|'HEAD'), description:string}[]}
 */
export function parseDeployments(output) {
  const out = [];
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/(AKfy[A-Za-z0-9_-]+)\s+@(\d+|HEAD)(?:\s*-?\s*(.*))?/);
    if (m) out.push({ id: m[1], version: m[2] === 'HEAD' ? 'HEAD' : Number(m[2]), description: (m[3] || '').trim() });
  }
  return out;
}

// ------------------------------------------------------------ reglas

export function checkBranch({ env, branch, expected }) {
  return branch === expected
    ? { ok: true }
    : { ok: false, message: `Para desplegar a ${env} debes estar en la rama «${expected}» (estás en «${branch}»).` };
}

// ------------------------------------------------------------ pruebas del sitio publicado

/** Una pasada de comprobaciones contra la URL publicada. */
export async function smokeOnce({ url, fetch }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const POST = body => ({ method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });

  try {   // 1. El JSON público solo trae el contenido del sitio, nunca datos de miembros
    const r = await fetch(url + '?api=data');
    const text = await r.text();
    const json = JSON.parse(text);
    const leak = /"(DPI|TokenQR|MemberID|ComprobanteToken)"/.test(text) || /(?<![\w-])\d{13}(?![\w-])/.test(text);
    add('El JSON público trae el sitio', r.status === 200 && json && typeof json === 'object' && 'site' in json, `HTTP ${r.status}`);
    add('El JSON público no filtra datos de miembros', !leak, leak ? 'se encontraron campos o números de DPI' : '');
  } catch (e) { add('El JSON público trae el sitio', false, String(e.message || e)); }

  try {   // 2. El código nuevo está publicado (enlace inexistente → página "no válido")
    const r = await fetch(url + '?carnet=' + '0'.repeat(24));
    const text = await r.text();
    add('Los enlaces inexistentes se rechazan', r.status === 200 && text.includes('Enlace no v'), `HTTP ${r.status}`);
  } catch (e) { add('Los enlaces inexistentes se rechazan', false, String(e.message || e)); }

  try {   // 3. El endpoint del tablet rechaza a quien no está emparejado
    const r = await fetch(url, POST({ action: 'ping', device: '0'.repeat(40) }));
    const json = JSON.parse(await r.text());
    add('El tablet no emparejado es rechazado', json.ok === false && json.status === 'no_autorizado', JSON.stringify(json).slice(0, 80));
  } catch (e) { add('El tablet no emparejado es rechazado', false, String(e.message || e)); }

  try {   // 4. El panel carga
    const r = await fetch(url + '?page=admin');
    const text = await r.text();
    add('El panel carga', r.status === 200 && text.includes('cp-app'), `HTTP ${r.status}`);
  } catch (e) { add('El panel carga', false, String(e.message || e)); }

  return checks;
}

/** Repite las comprobaciones unos intentos (una versión nueva tarda unos segundos en propagarse). */
export async function runSmoke({ url, fetch, attempts = 5, delayMs = 4000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let checks = [];
  for (let i = 1; i <= attempts; i++) {
    checks = await smokeOnce({ url, fetch });
    if (checks.every(c => c.ok)) return { ok: true, checks, attempts: i };
    if (i < attempts) await sleep(delayMs);
  }
  return { ok: false, checks, attempts };
}

// ------------------------------------------------------------ orquestación

/**
 * @param {{env:'staging'|'prod', config:Object, options?:{yes?:boolean, skipTests?:boolean, dryRun?:boolean, allowUnpushed?:boolean},
 *          io:{run:Function, git:Function, fetch:Function, confirm:Function, log:Function, sleep?:Function, now?:Function}}} args
 *   io.run(cmd, args) → {code, stdout}    io.git(args) → string (stdout)
 * @return {Promise<{ok:boolean, step?:string, message?:string, version?:number, previousVersion?:*, rolledBack?:boolean}>}
 */
export async function runDeploy({ env, config, options = {}, io }) {
  const cfg = config[env];
  const log = io.log;
  const fail = (step, message, extra = {}) => { log('✖ ' + message); return { ok: false, step, message, ...extra }; };
  if (!cfg) return fail('config', `Entorno desconocido: ${env}`);

  const clasp = (...args) => io.run('npx', ['-y', CLASP, '-P', cfg.clasp, ...args]);
  log(`\n== Despliegue a ${env.toUpperCase()} ${options.dryRun ? '(simulacro: no cambia nada)' : ''}`);

  // 1. Rama, árbol limpio y subido
  const branch = io.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const rule = checkBranch({ env, branch, expected: cfg.branch });
  if (!rule.ok) return fail('rama', rule.message);
  log(`✔ Rama ${branch}`);

  if (io.git(['status', '--porcelain']).trim()) {
    return fail('arbol', 'Hay cambios sin guardar (git status). Haz commit o descártalos antes de desplegar.');
  }
  log('✔ Árbol limpio');

  if (!options.allowUnpushed) {
    io.git(['fetch', 'origin', cfg.branch]);
    const local = io.git(['rev-parse', 'HEAD']).trim();
    const remote = io.git(['rev-parse', `origin/${cfg.branch}`]).trim();
    if (local !== remote) return fail('push', `Lo que vas a desplegar no coincide con origin/${cfg.branch}. Haz «git push» (o «git pull») primero.`);
    log('✔ Igual a origin/' + cfg.branch);
  }
  const sha = io.git(['rev-parse', '--short', 'HEAD']).trim();

  // 2. Configuración de la implementación
  if (!cfg.deploymentId || !cfg.url) {
    return fail('config', `Falta deploymentId/url de «${env}» en tools/deploy.config.json.\n` +
      '   1) En el editor de Apps Script: Implementar → Nueva implementación → Aplicación web (Ejecutar como: Yo · Acceso: Cualquier persona).\n' +
      '   2) Copia el ID de la implementación y la URL /exec en tools/deploy.config.json.');
  }

  // 3. Pruebas
  if (!options.skipTests) {
    log('… Corriendo las pruebas');
    const t = io.run('node', ['--test', 'tools/tests/*.test.mjs']);
    if (t.code !== 0) return fail('pruebas', 'Las pruebas fallaron. No se despliega.');
    log('✔ Pruebas OK');
  }

  // 4. Respaldo (solo prod)
  if (env === 'prod' && !options.yes) {
    const okBackup = await io.confirm('¿Hiciste el respaldo de la hoja de PRODUCCIÓN? (Panel → Sistema → Respaldo) [s/N] ');
    if (!okBackup) return fail('respaldo', 'Haz el respaldo y vuelve a intentarlo.');
  }

  // 5. Versión actual de la implementación (para poder volver)
  const listed = clasp('deployments');
  if (listed.code !== 0) return fail('clasp', 'No se pudo leer las implementaciones (¿iniciaste sesión con «npx @google/clasp login»?).');
  const current = parseDeployments(listed.stdout).find(d => d.id === cfg.deploymentId);
  if (!current) return fail('clasp', `La implementación ${cfg.deploymentId} no existe en ese proyecto. Revisa tools/deploy.config.json.`);
  const previousVersion = current.version;
  log(`✔ Implementación encontrada (versión actual: ${previousVersion})`);
  if (env === 'prod' && previousVersion === 'HEAD') {
    return fail('clasp', 'La implementación de producción apunta a HEAD (sin versión), así que no se podría volver atrás. ' +
      'Edita la implementación en el editor y elige una versión numerada una vez; después este comando la maneja.');
  }

  if (options.dryRun) {
    log('Simulacro: se subiría el código, se crearía una versión y se movería la implementación.');
    log(`  clasp push -f · clasp version · clasp deploy -i ${cfg.deploymentId} -V <nueva>`);
    log(`  Para volver: clasp deploy -i ${cfg.deploymentId} -V ${previousVersion}`);
    return { ok: true, dryRun: true, previousVersion };
  }

  // 6. Subir, versionar, publicar
  const stamp = (io.now ? io.now() : new Date()).toISOString().slice(0, 16).replace('T', ' ');
  let r = clasp('push', '-f');
  if (r.code !== 0) return fail('push', 'clasp push falló.');
  log('✔ Código subido');
  r = clasp('version', `${env} ${sha} ${stamp}`);
  const version = parseVersionNumber(r.stdout);
  if (r.code !== 0 || !version) return fail('version', 'No se pudo crear la versión (ni leer su número). El código ya está subido; publícala a mano desde el editor.');
  log(`✔ Versión ${version} creada`);
  r = clasp('deploy', '-i', cfg.deploymentId, '-V', String(version), '-d', `${env} ${sha}`);
  if (r.code !== 0) return fail('deploy', 'clasp deploy falló.', { version, previousVersion });
  log(`✔ Implementación movida a la versión ${version}`);

  // 7. Pruebas del sitio publicado
  log('… Probando el sitio publicado');
  const smoke = await runSmoke({ url: cfg.url, fetch: io.fetch, sleep: io.sleep });
  for (const c of smoke.checks) log(`   ${c.ok ? '✔' : '✖'} ${c.name}${c.ok || !c.detail ? '' : ' — ' + c.detail}`);

  if (smoke.ok) {
    log(`\n✔ ${env} desplegado: versión ${version} (antes: ${previousVersion}).`);
    log(`  Para volver atrás: npx @google/clasp -P ${cfg.clasp} deploy -i ${cfg.deploymentId} -V ${previousVersion}`);
    return { ok: true, version, previousVersion };
  }

  // 8. Falló: en prod se vuelve sola a la versión anterior
  if (env === 'prod' && typeof previousVersion === 'number') {
    log(`\n⚠ Las pruebas fallaron. Volviendo a la versión ${previousVersion}…`);
    const back = clasp('deploy', '-i', cfg.deploymentId, '-V', String(previousVersion), '-d', `rollback a ${previousVersion}`);
    if (back.code !== 0) {
      return fail('rollback', `NO se pudo volver atrás automáticamente. Hazlo a mano: Implementar → Administrar implementaciones → editar → versión ${previousVersion}.`, { version, previousVersion });
    }
    const after = await runSmoke({ url: cfg.url, fetch: io.fetch, attempts: 3, sleep: io.sleep });
    log(after.ok ? `✔ Producción volvió a la versión ${previousVersion} y responde bien.` : '⚠ Volvió a la versión anterior pero las pruebas siguen fallando: revisa a mano.');
    return fail('smoke', `El despliegue falló y se revirtió a la versión ${previousVersion}.`, { version, previousVersion, rolledBack: true, rollbackHealthy: after.ok });
  }
  return fail('smoke', `Las pruebas del sitio publicado fallaron (${env}). Revisa los detalles de arriba.`, { version, previousVersion });
}
