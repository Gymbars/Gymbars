#!/usr/bin/env node
/** Falla si git rastrea datos personales o secretos nuevos. Uso: node tools/guard.mjs */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './lib/guard-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const baseline = JSON.parse(readFileSync(join(ROOT, 'tools', 'guard-baseline.json'), 'utf8'));

const readFile = file => {
  try {
    const buf = readFileSync(join(ROOT, file));
    if (buf.length > 2_000_000 || buf.includes(0)) return null;     // binario o enorme
    return buf.toString('utf8');
  } catch (_) { return null; }
};

const { errors, warnings } = scanRepository(files, readFile, baseline);
warnings.forEach(w => console.warn('⚠ ' + w));
if (errors.length) {
  console.error('\n✖ El guardia encontró problemas:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`Guardia OK (${files.length} archivos revisados${warnings.length ? ', ' + warnings.length + ' aviso(s) conocidos' : ''}).`);
