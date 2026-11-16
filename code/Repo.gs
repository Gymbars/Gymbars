/**
 * Repo.gs — Acceso a las pestañas del sistema de gestión (ver Schema.gs).
 *
 * - Lee y escribe por NOMBRE de columna (se pueden reordenar columnas en la hoja).
 * - Usa getValues (valores reales, fechas como Date), no los textos mostrados.
 * - Toda escritura pasa por un bloqueo (LockService) para que dos personas, o
 *   dos escaneos del tablet a la vez, no se pisen ni dupliquen IDs.
 * - Agrega filas (append) o actualiza UNA fila; nunca reescribe la pestaña entera.
 *
 * Las funciones son privadas (terminan en `_`): solo se llaman desde el
 * servidor, nunca desde el navegador (ver Auth.gs / Api.gs).
 */

var GB_TZ = 'America/Guatemala';


// ============================================================
// ===  Utilidades generales  =================================
// ============================================================

/** Profundidad de bloqueo de ESTA ejecución (cada ejecución de Apps Script tiene su propio estado global). */
var GB_LOCK_DEPTH_ = 0;

/**
 * Ejecuta `fn` con el bloqueo del script. Es reentrante: si esta ejecución ya
 * tiene el bloqueo (un servicio que llama a gbAppend_, por ejemplo) simplemente
 * ejecuta `fn`, porque el bloqueo de Apps Script NO es reentrante y se trabaría.
 * Falla con un mensaje claro si otra ejecución tarda demasiado.
 */
function gbWithLock_(fn, timeoutMs) {
  if (GB_LOCK_DEPTH_ > 0) return fn();

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(timeoutMs || 20000);
  } catch (e) {
    throw new Error('El sistema está ocupado con otra operación. Intenta de nuevo en unos segundos.');
  }
  GB_LOCK_DEPTH_ = 1;
  try {
    return fn();
  } finally {
    GB_LOCK_DEPTH_ = 0;
    lock.releaseLock();
  }
}

/** Texto aleatorio hexadecimal no adivinable (hasta 64 caracteres). */
function gbToken_(length) {
  var raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  return raw.substring(0, Math.min(length || 24, raw.length));
}

/** Bytes (con signo, como los devuelve Apps Script) a texto hexadecimal. */
function gbHex_(bytes) {
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/** SHA-256 en hexadecimal. */
function gbHash_(value) {
  return gbHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value)));
}

/** Comparación en tiempo constante de dos textos. */
function gbSafeEquals_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Convierte a Date: acepta Date, 'yyyy-mm-dd', 'dd/mm/yyyy' y 'yyyy-mm-ddThh:mm…'.
 * Las fechas sin hora quedan a las 12:00 para que ningún cambio de zona horaria
 * mueva el día. Devuelve null si no se puede interpretar.
 */
function gbParseDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  var s = String(value == null ? '' : value).trim();
  if (!s) return null;

  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    var hasTime = m[4] !== undefined;
    return new Date(+m[1], +m[2] - 1, +m[3], hasTime ? +m[4] : 12, hasTime ? +m[5] : 0, hasTime && m[6] ? +m[6] : 0);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12, 0, 0);
  return null;
}

function gbFmtDate_(value) {
  var d = gbParseDate_(value);
  return d ? Utilities.formatDate(d, GB_TZ, 'yyyy-MM-dd') : '';
}

function gbFmtDateTime_(value) {
  var d = gbParseDate_(value);
  return d ? Utilities.formatDate(d, GB_TZ, "yyyy-MM-dd'T'HH:mm:ss") : '';
}

/** Hoy (yyyy-MM-dd) en la zona horaria del gimnasio. */
function gbToday_() {
  return Utilities.formatDate(new Date(), GB_TZ, 'yyyy-MM-dd');
}


// ============================================================
// ===  Tablas  ===============================================
// ============================================================

function gbSpec_(key) {
  var spec = gbSchema_()[key];
  if (!spec) throw new Error('Tabla desconocida: ' + key);
  return spec;
}

function gbSheet_(key) {
  var spec = gbSpec_(key);
  var sheet = ss_().getSheetByName(spec.name);
  if (!sheet) {
    throw new Error('Falta la pestaña "' + spec.name + '". Ejecuta Gymbars → Crear pestañas faltantes.');
  }
  return sheet;
}

/**
 * Lee los encabezados reales de la hoja y los compara con el esquema.
 * @return {Object<string,number>} nombre de columna → índice (0-based)
 */
function gbHeaderMap_(sheet, spec) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var actual = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  actual.forEach(function (name, index) {
    var clean = String(name == null ? '' : name).trim();
    if (clean && map[clean] === undefined) map[clean] = index;
  });
  spec.headers.forEach(function (name) {
    if (map[name] === undefined) {
      throw new Error('Falta la columna "' + name + '" en la pestaña "' + spec.name + '".');
    }
  });
  return map;
}

/**
 * Lee todas las filas de una tabla como objetos { Columna: valor, _row: n }.
 * @param {string} key Clave del esquema (ej. 'members').
 * @param {function(Object):boolean} [filterFn]
 * @return {Object[]}
 */
function gbList_(key, filterFn) {
  var spec = gbSpec_(key);
  var sheet = gbSheet_(key);
  var map = gbHeaderMap_(sheet, spec);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var lastCol = Math.max.apply(null, spec.headers.map(function (h) { return map[h]; })) + 1;
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];
  values.forEach(function (row, i) {
    var obj = { _row: i + 2 };
    var empty = true;
    spec.headers.forEach(function (h) {
      var v = row[map[h]];
      obj[h] = v === undefined ? '' : v;
      if (obj[h] !== '' && obj[h] !== null) empty = false;
    });
    if (empty) return;
    if (!filterFn || filterFn(obj)) out.push(obj);
  });
  return out;
}

/**
 * Como gbList_ pero lee solo las últimas `count` filas (tablas que crecen sin parar,
 * como Asistencia): una lectura corta en vez de miles de filas en cada escaneo.
 */
function gbListTail_(key, count, filterFn) {
  var spec = gbSpec_(key);
  var sheet = gbSheet_(key);
  var map = gbHeaderMap_(sheet, spec);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var first = Math.max(2, lastRow - count + 1);
  var lastCol = Math.max.apply(null, spec.headers.map(function (h) { return map[h]; })) + 1;
  var values = sheet.getRange(first, 1, lastRow - first + 1, lastCol).getValues();
  var out = [];
  values.forEach(function (row, i) {
    var obj = { _row: first + i };
    var empty = true;
    spec.headers.forEach(function (h) {
      var v = row[map[h]];
      obj[h] = v === undefined ? '' : v;
      if (obj[h] !== '' && obj[h] !== null) empty = false;
    });
    if (empty) return;
    if (!filterFn || filterFn(obj)) out.push(obj);
  });
  return out;
}

/** Primera fila cuyo `field` es igual a `value` (comparación como texto, sin espacios). */
function gbFind_(key, field, value) {
  var target = String(value == null ? '' : value).trim();
  if (!target) return null;
  var found = gbList_(key, function (o) { return String(o[field]).trim() === target; });
  return found.length ? found[0] : null;
}

/** Siguiente ID legible (GB-0001…) según los existentes. */
function gbNextId_(spec, rows) {
  var info = spec.id;
  var max = 0;
  var re = new RegExp('^' + info.prefix.replace(/[-]/g, '\\-') + '(\\d+)$');
  rows.forEach(function (r) {
    var m = String(r[info.field]).match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = String(max + 1);
  while (n.length < info.pad) n = '0' + n;
  return info.prefix + n;
}

/** Fila (array) en el orden real de columnas de la hoja. */
function gbRowArray_(spec, map, width, obj) {
  var arr = [];
  for (var i = 0; i < width; i++) arr.push('');
  spec.headers.forEach(function (h) {
    var v = obj[h];
    arr[map[h]] = (v === undefined || v === null) ? '' : v;
  });
  return arr;
}

/**
 * Agrega una fila. Genera el ID si la tabla tiene y no se indicó.
 * @return {Object} La fila guardada (con su ID y `_row`).
 */
function gbAppend_(key, obj) {
  var spec = gbSpec_(key);
  return gbWithLock_(function () {
    var sheet = gbSheet_(key);
    var map = gbHeaderMap_(sheet, spec);
    var record = {};
    spec.headers.forEach(function (h) { record[h] = obj[h]; });

    if (spec.id && !String(record[spec.id.field] == null ? '' : record[spec.id.field]).trim()) {
      record[spec.id.field] = gbNextId_(spec, gbList_(key));
    }

    var width = Math.max(sheet.getLastColumn(), spec.headers.length);
    var row = Math.max(sheet.getLastRow(), 1) + 1;
    gbEnsureRows_(sheet, spec, row);   // una hoja nueva solo tiene 1000 filas
    sheet.getRange(row, 1, 1, width).setValues([gbRowArray_(spec, map, width, record)]);
    record._row = row;
    return record;
  });
}

/**
 * Agrega muchas filas de una vez (una sola lectura y una sola escritura).
 * Para cargas grandes; gbAppend_ lee la tabla en cada fila y sería lento.
 * @return {Object[]} Las filas guardadas, con sus IDs.
 */
function gbBulkAppend_(key, objs) {
  var spec = gbSpec_(key);
  if (!objs.length) return [];
  return gbWithLock_(function () {
    var sheet = gbSheet_(key);
    var map = gbHeaderMap_(sheet, spec);
    var width = Math.max(sheet.getLastColumn(), spec.headers.length);
    var firstRow = Math.max(sheet.getLastRow(), 1) + 1;

    var counterSource = spec.id ? gbList_(key) : [];
    var saved = objs.map(function (obj) {
      var record = {};
      spec.headers.forEach(function (h) { record[h] = obj[h]; });
      if (spec.id && !String(record[spec.id.field] == null ? '' : record[spec.id.field]).trim()) {
        record[spec.id.field] = gbNextId_(spec, counterSource);
      }
      if (spec.id) counterSource.push(record);       // el siguiente ID sale de este
      return record;
    });

    gbEnsureRows_(sheet, spec, firstRow + saved.length - 1);
    sheet.getRange(firstRow, 1, saved.length, width).setValues(saved.map(function (r) { return gbRowArray_(spec, map, width, r); }));
    saved.forEach(function (r, i) { r._row = firstRow + i; });
    return saved;
  });
}

/**
 * Actualiza campos de una fila identificada por su ID (o por número de fila).
 * Solo escribe las celdas indicadas en `patch`.
 * @return {Object|null} La fila actualizada, o null si no existe.
 */
function gbUpdate_(key, id, patch) {
  var spec = gbSpec_(key);
  if (!spec.id) throw new Error('La tabla ' + spec.name + ' no tiene ID.');
  return gbWithLock_(function () {
    var current = gbFind_(key, spec.id.field, id);
    if (!current) return null;

    var sheet = gbSheet_(key);
    var map = gbHeaderMap_(sheet, spec);
    Object.keys(patch).forEach(function (field) {
      if (field === spec.id.field || spec.headers.indexOf(field) === -1) return;
      var v = patch[field] === undefined || patch[field] === null ? '' : patch[field];
      sheet.getRange(current._row, map[field] + 1).setValue(v);
      current[field] = v;
    });
    return current;
  });
}

/** Borra la fila con ese ID. Devuelve true si existía. */
function gbRemove_(key, id) {
  var spec = gbSpec_(key);
  return gbWithLock_(function () {
    var current = gbFind_(key, spec.id.field, id);
    if (!current) return false;
    gbSheet_(key).deleteRow(current._row);
    return true;
  });
}


/**
 * Borra todas las filas de una tabla cuyo `field` sea igual a `value`.
 * @return {number} Filas borradas.
 */
function gbRemoveWhere_(key, field, value) {
  return gbWithLock_(function () {
    var rows = gbList_(key, function (o) { return String(o[field]).trim() === String(value).trim(); });
    var sheet = gbSheet_(key);
    rows.map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })        // de abajo hacia arriba
      .forEach(function (row) { sheet.deleteRow(row); });
    return rows.length;
  });
}


/**
 * ID de una carpeta o archivo de Drive a partir de un enlace o del ID mismo.
 *   https://drive.google.com/drive/folders/122q4COt…?usp=sharing  →  122q4COt…
 * @return {string} '' si no se reconoce.
 */
function gbDriveId_(text) {
  var t = String(text == null ? '' : text).trim();
  var m = t.match(/\/(?:folders|d)\/([A-Za-z0-9_-]{10,})/) || t.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || t.match(/^([A-Za-z0-9_-]{10,})$/);
  return m ? m[1] : '';
}

// ============================================================
// ===  Configuración (pestaña ConfigGym)  ====================
// ============================================================

/** Todo ConfigGym como objeto { clave: valor } (caché 60 s). */
function gbConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('GB_CONFIG');
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  var config = {};
  gbSeedDefaultsInto_(config);
  try {
    gbList_('config').forEach(function (row) {
      var k = String(row.Clave).trim();
      if (k) config[k] = String(row.Valor == null ? '' : row.Valor).trim();
    });
  } catch (_) { /* sin pestaña todavía: valores por defecto */ }
  cache.put('GB_CONFIG', JSON.stringify(config), 60);
  return config;
}

function gbSeedDefaultsInto_(config) {
  gbConfigSeed_().forEach(function (pair) { config[pair[0]] = pair[1]; });
}

function gbConfigGet_(key, fallback) {
  var v = gbConfig_()[key];
  return (v === undefined || v === '') ? fallback : v;
}

function gbConfigNumber_(key, fallback) {
  var n = parseFloat(gbConfigGet_(key, ''));
  return isNaN(n) ? fallback : n;
}

function gbConfigFlag_(key) {
  return /^(si|sí|yes|true|1)$/i.test(String(gbConfigGet_(key, 'NO')).trim());
}

/** Guarda un valor de configuración (crea la fila si no existe). */
function gbConfigSet_(key, value) {
  var cleanKey = String(key).trim();
  gbWithLock_(function () {
    var sheet = gbSheet_('config');
    var found = gbFind_('config', 'Clave', cleanKey);
    if (found) {
      sheet.getRange(found._row, 2).setValue(value);
    } else {
      var newRow = Math.max(sheet.getLastRow(), 1) + 1;
      gbEnsureRows_(sheet, gbSpec_('config'), newRow);
      sheet.getRange(newRow, 1, 1, 2).setValues([[cleanKey, value]]);
    }
  });
  CacheService.getScriptCache().remove('GB_CONFIG');
}
