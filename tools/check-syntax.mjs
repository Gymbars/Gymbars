#!/usr/bin/env node
/**
 * Compila (sin ejecutar) todos los .gs, los <script> de los .html y los .js del escáner.
 * Las pruebas solo cargan los archivos que ejercitan; esto atrapa un error de sintaxis en
 * cualquiera, antes de subirlo a Apps Script.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let files = 0, scripts = 0;
const errors = [];

function compile(code, filename) {
  try { new vm.Script(code, { filename }); } catch (e) { errors.push(`${filename}: ${e.message}`); }
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile); else onFile(full);
  }
}

walk(path.join(ROOT, 'code'), file => {
  const rel = path.relative(ROOT, file);
  if (file.endsWith('.gs')) { files++; compile(fs.readFileSync(file, 'utf8'), rel); }
  if (file.endsWith('.html')) {
    // Los <?= … ?> de Apps Script se reemplazan por null para poder compilar el JavaScript del navegador.
    const html = fs.readFileSync(file, 'utf8').replace(/<\?!?=[\s\S]*?\?>/g, 'null');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) { scripts++; compile(m[1], rel); }
  }
});
walk(path.join(ROOT, 'checkin'), file => {
  if (file.endsWith('.js')) { files++; compile(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)); }
  if (file.endsWith('.html')) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) { scripts++; compile(m[1], path.relative(ROOT, file)); }
  }
});

if (errors.length) {
  console.error('Errores de sintaxis:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`Sintaxis correcta: ${files} archivos y ${scripts} bloques <script>.`);
