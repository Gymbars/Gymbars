/**
 * Sandbox mínimo para probar archivos .gs de Apps Script con Node (sin desplegar).
 *
 * Carga los archivos REALES de `code/` en un contexto `vm` con servicios de
 * Google simulados (Cache, Properties, Session, Lock, Utilities, hojas en memoria).
 * Sirve para probar reglas de negocio, autorización y la capa de datos; no
 * reemplaza una prueba final dentro de Apps Script.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Las fechas del sistema se interpretan en la zona del gimnasio (igual que en Apps Script).
process.env.TZ = 'America/Guatemala';

const CODE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'code');

const isEmpty = v => v === '' || v === null || v === undefined;

/**
 * Hoja en memoria con la parte de la API de Sheets que usa el código.
 * `rows` incluye la fila de encabezados.
 */
export function memSheet(rows = [], limits = {}) {
  const data = rows.map(r => [...r]);
  // Una hoja nueva de Google Sheets tiene 1000 filas y 26 columnas; fuera de eso la API falla.
  let maxRows = Math.max(limits.maxRows || 1000, data.length);
  let maxCols = Math.max(limits.maxCols || 26, ...data.map(r => r.length), 1);
  const lastRow = () => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i].some(v => !isEmpty(v))) return i + 1;
    return 0;
  };
  const lastCol = () => data.reduce((max, row) => {
    for (let i = row.length - 1; i >= 0; i--) if (!isEmpty(row[i])) return Math.max(max, i + 1);
    return max;
  }, 0);
  const ensure = (r, c) => {
    while (data.length < r) data.push([]);
    for (let i = 0; i < r; i++) while (data[i].length < c) data[i].push('');
  };
  const check = (r, c, nr, nc) => {
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > maxRows || c + nc - 1 > maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
  };

  const sheet = {
    data,
    getLastRow: lastRow,
    getLastColumn: () => Math.max(lastCol(), 1),
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxCols,
    insertRowsAfter: (after, howMany) => { maxRows += howMany; },
    insertColumnsAfter: (after, howMany) => { maxCols += howMany; },
    deleteRow: n => { data.splice(n - 1, 1); },
    setFrozenRows() { return this; },
    getRange(r, c, nr = 1, nc = 1) {
      check(r, c, nr, nc);
      const range = {
        getValues: () => {
          ensure(r - 1 + nr, c - 1 + nc);
          return data.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc));
        },
        setValues: vals => {
          check(r, c, vals.length, vals[0].length);
          ensure(r - 1 + vals.length, c - 1 + vals[0].length);
          vals.forEach((row, i) => row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; }));
          return range;
        },
        setValue: v => { ensure(r, c); data[r - 1][c - 1] = v; return range; },
        clearContent: () => {
          ensure(r - 1 + nr, c - 1 + nc);
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = '';
          return range;
        },
        setNumberFormat: () => range,
        setDataValidation: () => range,
        setFontWeight: () => range
      };
      return range;
    }
  };
  return sheet;
}
/** Libro en memoria con insertSheet/getSheetByName (para probar la creación de pestañas). */
export function memSpreadsheet() {
  const sheets = {};
  return {
    sheets,
    getSheetByName: name => sheets[name] || null,
    insertSheet(name) { sheets[name] = memSheet([]); return sheets[name]; }
  };
}

/** Compatibilidad con las pruebas de autorización. */
export const fakeSheet = memSheet;

/** Analizador CSV mínimo (RFC 4180) equivalente a Utilities.parseCsv. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function formatDate(date, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second).replace(/'/g, '');
}

/**
 * @param {string[]} files Archivos de code/ a cargar (en orden).
 * @param {{owner?:string, editors?:string[], sheets?:Object<string,Object>, activeUser?:string,
 *          props?:Object, extra?:string, failLock?:boolean}} [opts]
 */
export function loadGas(files, opts = {}) {
  const logs = [];
  const cacheStore = new Map();
  const propStore = new Map(Object.entries(opts.props || {}));
  const state = { activeUser: opts.activeUser || '', failLock: !!opts.failLock, lockHeld: 0, lockCount: 0 };

  const sandbox = {
    console,
    Date, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set, isNaN, parseFloat, parseInt,
    GOOGLE_AUTH_SHARED_SECRET: 'legacy-secret',
    log_: (type, status, data) => logs.push({ type, status, data }),
    ss_: () => ({
      getOwner: () => (opts.owner ? { getEmail: () => opts.owner } : null),
      getEditors: () => (opts.editors || []).map(email => ({ getEmail: () => email })),
      getSheetByName: name => (opts.sheets && opts.sheets[name]) || null
    }),
    Session: { getActiveUser: () => ({ getEmail: () => state.activeUser }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => { cacheStore.set(k, String(v)); },
        remove: k => { cacheStore.delete(k); }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (propStore.has(k) ? propStore.get(k) : null),
        setProperty: (k, v) => { propStore.set(k, String(v)); },
        deleteProperty: k => { propStore.delete(k); },
        getProperties: () => Object.fromEntries(propStore)
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          if (state.failLock) throw new Error('lock timeout');
          state.lockHeld++; state.lockCount++;
        },
        releaseLock: () => { state.lockHeld--; }
      })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, value) => [...crypto.createHash(alg).update(String(value)).digest()].map(b => (b > 127 ? b - 256 : b)),
      // Apps Script acepta texto o bytes; devuelve base64 "web safe" CON relleno '='.
      base64EncodeWebSafe: v => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v))
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      computeHmacSha256Signature: (value, key) =>
        [...crypto.createHmac('sha256', String(key)).update(String(value)).digest()].map(b => (b > 127 ? b - 256 : b)),
      computeRsaSha256Signature: (value, pemKey) =>
        [...crypto.createSign('RSA-SHA256').update(String(value)).sign(pemKey)].map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate,
      parseCsv
    },
    SpreadsheetApp: {
      newDataValidation: () => {
        const builder = { requireValueInList: () => builder, setAllowInvalid: () => builder, build: () => ({}) };
        return builder;
      }
    },
    MailApp: {
      sent: [],
      quota: opts.mailQuota === undefined ? 100 : opts.mailQuota,
      failNext: false,
      getRemainingDailyQuota() { return this.quota; },
      sendEmail(message) {
        if (this.failNext) { this.failNext = false; throw new Error('mail failure'); }
        this.sent.push(message); this.quota--;
      }
    },
    ScriptApp: {
      triggers: [],
      getService: () => ({ getUrl: () => opts.baseUrl || '' }),
      getProjectTriggers() { return this.triggers; },
      deleteTrigger(t) { this.triggers = this.triggers.filter(x => x !== t); },
      newTrigger(fn) {
        const self = this;
        const t = { fn, uid: 'uid-' + (self.triggers.length + 1), getHandlerFunction: () => fn, getUniqueId() { return this.uid; } };
        const builder = {
          timeBased: () => builder, everyDays: () => builder, atHour: h => { t.hour = h; return builder; },
          inTimezone: () => builder, create() { self.triggers.push(t); return t; }
        };
        return builder;
      }
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutput: html => {
        const out = { html, title: '', setTitle(t) { out.title = t; return out; }, setXFrameOptionsMode: () => out, addMetaTag: () => out };
        return out;
      }
    }
  };
  vm.createContext(sandbox);

  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(CODE_DIR, file), 'utf8'), sandbox, { filename: file });
  }
  if (opts.extra) vm.runInContext(opts.extra, sandbox, { filename: 'test-extra.js' });

  return {
    ctx: sandbox,
    logs,
    props: propStore,
    cache: cacheStore,
    lock: state,
    sheets: opts.sheets || {},
    setActiveUser: email => { state.activeUser = email; },
    /** Guarda una sesión como lo hace cpCompleteGoogleAuth_. */
    addSession: (token, email, ttlMs = 3600_000) =>
      propStore.set('CP_SESSION_' + token, JSON.stringify({ email, expiry: Date.now() + ttlMs }))
  };
}
