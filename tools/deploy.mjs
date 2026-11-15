#!/usr/bin/env node
/**
 * Despliegue a Apps Script con comprobaciones y vuelta atrás.
 *
 *   node tools/deploy.mjs staging            # rama develop → hoja de PRUEBAS
 *   node tools/deploy.mjs prod               # rama master  → hoja REAL (pide confirmar el respaldo)
 *   node tools/deploy.mjs prod --dry-run     # simulacro: revisa todo y no cambia nada
 *
 * Opciones:  --yes (no preguntar por el respaldo)  --skip-tests  --allow-unpushed
 * Requiere haber iniciado sesión una vez:  npx @google/clasp login
 * Ver DEPLOY.md.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { runDeploy } from './lib/deploy-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const env = args.find(a => !a.startsWith('--'));
const has = flag => args.includes(flag);

if (!['staging', 'prod'].includes(env)) {
  console.error('Uso: node tools/deploy.mjs <staging|prod> [--dry-run] [--yes] [--skip-tests] [--allow-unpushed]');
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(ROOT, 'tools', 'deploy.config.json'), 'utf8'));

const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { code: r.status === null ? 1 : r.status, stdout: (r.stdout || '') + (r.stderr || '') };
};

const git = gitArgs => {
  const r = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} falló: ${r.stderr}`);
  return r.stdout;
};

const confirm = async question => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return ['s', 'si', 'sí', 'y', 'yes'].includes(answer);
};

const result = await runDeploy({
  env, config,
  options: { yes: has('--yes'), skipTests: has('--skip-tests'), dryRun: has('--dry-run'), allowUnpushed: has('--allow-unpushed') },
  io: { run, git, fetch, confirm, log: console.log }
});

if (!result.dryRun) {
  try {
    appendFileSync(join(ROOT, '.deploy-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), env, ok: result.ok, step: result.step, version: result.version, previousVersion: result.previousVersion, rolledBack: !!result.rolledBack }) + '\n');
  } catch (_) { /* el registro local es opcional */ }
}
process.exit(result.ok ? 0 : 1);
