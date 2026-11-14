#!/usr/bin/env node
/**
 * Vista previa local del sitio con los datos reales (solo lectura).
 *
 *   node tools/preview.mjs            → http://localhost:3000
 *   PORT=4000 node tools/preview.mjs  → otro puerto
 *   PREVIEW_DATA_URL=<url /exec?api=data> node tools/preview.mjs
 *
 * - Arma Index.html resolviendo los <?!= include('...') ?> de Apps Script.
 * - Los archivos se leen en cada recarga: edita y refresca el navegador.
 * - Los datos (hoja de cálculo) se piden al sitio publicado, con caché de 5 min.
 * - No usa clasp y no despliega nada.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'code');
const port = Number(process.env.PORT) || 3000;
const PUBLIC_SITE = process.env.PREVIEW_SITE_URL || 'https://www.gymbarsgt.com/';
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, data: null };
let dataUrl = process.env.PREVIEW_DATA_URL || '';

async function discoverDataUrl() {
  if (dataUrl) return dataUrl;
  const res = await fetch(PUBLIC_SITE);
  const html = await res.text();
  const match = html.match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/);
  if (!match) throw new Error('No se encontró la URL del web app en ' + PUBLIC_SITE);
  dataUrl = match[0] + '?api=data';
  return dataUrl;
}

async function getData(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await fetch(await discoverDataUrl());
  if (!res.ok) throw new Error('El sitio respondió ' + res.status);
  cache = { at: Date.now(), data: await res.json() };
  return cache.data;
}

const include = name => fs.readFileSync(path.join(root, name + '.html'), 'utf8');

function render(data) {
  return include('Index')
    .replace(/<\?!= include\('([^']+)'\) \?>/g, (_, name) => include(name))
    .replace('<?!= siteDataJson ?>', () => JSON.stringify(data).replace(/</g, '\\u003c'))
    .replace("<?!= JSON.stringify(webAppUrl || '') ?>", '""')
    // Las imágenes de Drive (lh3) responden 429 si la petición trae Referer: localhost.
    // Solo para la vista previa: sin referer cargan igual que en el sitio publicado.
    .replace('<head>', '<head>\n  <meta name="referrer" content="no-referrer">');
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No encontrado');
    }
    const data = await getData(url.searchParams.has('refresh'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(render(data));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error: ' + err.message);
  }
}).listen(port, () => {
  console.log('Vista previa: http://localhost:' + port + '  (agrega ?refresh para volver a pedir los datos)');
});
