/**
 * Migration.gs — Importa a Google Sheets los datos del Excel (CONTROL GYMBRAS.xlsm).
 *
 * Flujo:
 *   1. En tu computadora:  python3 tools/migrate-xlsm.py "CONTROL GYMBRAS.xlsm"
 *      (genera la carpeta `migration/` con 4 CSV y un reporte).
 *   2. Sube esa carpeta a Google Drive (privada) y copia su ID.
 *   3. En la hoja:  Gymbars → Migración: simulacro   (valida sin escribir)
 *                   Gymbars → Migración: importar     (escribe los datos)
 *                   Gymbars → Verificar datos migrados (revisa la hoja ya cargada)
 *   4. Borra la carpeta de Drive y la carpeta `migration/` local al terminar.
 *
 * La validación ocurre ANTES de escribir: si hay un solo error no se importa nada.
 * Las funciones son privadas (terminan en `_`); solo se usan desde el menú de la hoja
 * y solo un Admin puede ejecutarlas. Los logs guardan conteos, nunca datos personales.
 */

var GB_MIGRATION_FOLDER_PROP = 'GB_MIGRATION_FOLDER_ID';

/** Tablas que se importan y su archivo CSV (en este orden: miembros primero). */
function gbMigrationFiles_() {
  return [
    { key: 'members', file: 'Miembros.csv' },
    { key: 'payments', file: 'Pagos.csv' },
    { key: 'measurements', file: 'Medidas.csv' },
    { key: 'evaluations', file: 'Evaluaciones.csv' }
  ];
}


// ============================================================
// ===  Lectura y validación (sin escribir nada)  =============
// ============================================================

/**
 * Convierte el texto de un CSV en objetos tipados según el esquema.
 * @return {Object[]|null} filas { Columna: valor, _line: número }; null si el
 *   archivo no tiene la estructura esperada (vacío o faltan columnas).
 */
function gbCsvToObjects_(key, text, errors) {
  var spec = gbSpec_(key);
  var grid = Utilities.parseCsv(String(text || '').replace(/^﻿/, ''));
  if (!grid.length || (grid.length === 1 && !grid[0].join('').trim())) {
    errors.push(spec.name + ': el archivo está vacío.');
    return null;
  }

  var header = grid[0].map(function (h) { return String(h).trim(); });
  var missing = spec.headers.filter(function (h) { return header.indexOf(h) === -1; });
  missing.forEach(function (h) { errors.push(spec.name + ': falta la columna "' + h + '".'); });
  if (missing.length) return null;

  var isText = {}, isDate = {}, isDateTime = {}, isNumber = {};
  (spec.text || []).forEach(function (h) { isText[h] = true; });
  (spec.dates || []).forEach(function (h) { isDate[h] = true; });
  (spec.dateTimes || []).forEach(function (h) { isDateTime[h] = true; });
  (spec.numbers || []).forEach(function (h) { isNumber[h] = true; });

  var out = [];
  for (var i = 1; i < grid.length; i++) {
    var line = grid[i];
    if (!line.join('').trim()) continue;
    var obj = { _line: i + 1 };

    spec.headers.forEach(function (h) {
      var raw = line[header.indexOf(h)];
      var value = String(raw == null ? '' : raw).trim();
      var where = spec.name + ' fila ' + (i + 1) + ', ' + h;

      if (value === '') { obj[h] = ''; return; }

      if (isDate[h] || isDateTime[h]) {
        var d = gbParseDate_(value);
        if (!d) { errors.push(where + ': fecha no válida.'); obj[h] = ''; } else { obj[h] = d; }
      } else if (isNumber[h]) {
        var n = Number(value.replace(',', '.'));
        if (isNaN(n)) { errors.push(where + ': número no válido.'); obj[h] = ''; } else { obj[h] = n; }
      } else {
        obj[h] = value; // texto (DPI, teléfonos, IDs…) se conserva tal cual
      }
    });

    out.push(obj);
  }
  return out;
}

/**
 * Valida los CSV y arma las filas a escribir. No toca la hoja.
 *
 * @param {Object<string,string>} csvByKey { members: '…csv…', payments: … }
 * @return {{rows:Object<string,Object[]>, errors:string[], warnings:string[], counts:Object}}
 */
function gbMigrationPlan_(csvByKey) {
  var errors = [], warnings = [], rows = {}, counts = {}, structural = false;

  gbMigrationFiles_().forEach(function (f) {
    if (csvByKey[f.key] == null) { errors.push('Falta el archivo ' + f.file + '.'); structural = true; return; }
    var parsed = gbCsvToObjects_(f.key, csvByKey[f.key], errors);
    if (parsed === null) { structural = true; return; }
    rows[f.key] = parsed;
    counts[f.key] = parsed.length;
  });
  // Sin la estructura básica no se puede cruzar nada; con solo errores de datos se
  // siguen revisando las relaciones para mostrar todos los problemas de una vez.
  if (structural) return { rows: rows, errors: errors, warnings: warnings, counts: counts };

  // --- listas permitidas (Genero, Estado…) ---
  gbMigrationFiles_().forEach(function (f) {
    var spec = gbSpec_(f.key);
    Object.keys(spec.lists || {}).forEach(function (col) {
      rows[f.key].forEach(function (r) {
        if (r[col] !== '' && spec.lists[col].indexOf(r[col]) === -1) {
          errors.push(spec.name + ' fila ' + r._line + ': ' + col + ' "' + r[col] + '" no es válido.');
        }
      });
    });
  });

  // --- IDs únicos ---
  gbMigrationFiles_().forEach(function (f) {
    var spec = gbSpec_(f.key);
    var seen = {};
    rows[f.key].forEach(function (r) {
      var id = String(r[spec.id.field]);
      if (!id) { errors.push(spec.name + ' fila ' + r._line + ': falta ' + spec.id.field + '.'); return; }
      if (seen[id]) errors.push(spec.name + ' fila ' + r._line + ': ' + spec.id.field + ' repetido (' + id + ').');
      seen[id] = true;
    });
  });

  // --- miembros: DPI, teléfono, token ---
  var memberIds = {}, dpis = {}, tokens = {};
  rows.members.forEach(function (m) {
    memberIds[m.MemberID] = true;
    if (!/^\d{13}$/.test(m.DPI)) errors.push('Miembros fila ' + m._line + ': el DPI debe tener 13 dígitos.');
    if (dpis[m.DPI]) errors.push('Miembros fila ' + m._line + ': DPI repetido.');
    dpis[m.DPI] = true;
    if (!m.TokenQR) errors.push('Miembros fila ' + m._line + ': falta TokenQR.');
    else if (tokens[m.TokenQR]) errors.push('Miembros fila ' + m._line + ': TokenQR repetido.');
    tokens[m.TokenQR] = true;
    if (!/^\d{8}$/.test(m.Telefono)) warnings.push('Miembros fila ' + m._line + ' (' + m.MemberID + '): teléfono sin 8 dígitos.');
    if (m.DiaPago === '') warnings.push('Miembros fila ' + m._line + ' (' + m.MemberID + '): sin día de pago (no recibirá recordatorios).');
  });

  // --- tablas hijas: el miembro debe existir ---
  ['payments', 'measurements', 'evaluations'].forEach(function (key) {
    var spec = gbSpec_(key);
    rows[key].forEach(function (r) {
      if (!memberIds[r.MemberID]) {
        errors.push(spec.name + ' fila ' + r._line + ': el miembro ' + r.MemberID + ' no existe.');
      }
      if (r.Fecha === '') errors.push(spec.name + ' fila ' + r._line + ': falta la fecha.');
    });
  });
  rows.payments.forEach(function (p) {
    if (p.Monto === '' || p.Monto <= 0) errors.push('Pagos fila ' + p._line + ': el monto debe ser mayor que 0.');
  });

  return { rows: rows, errors: errors, warnings: warnings, counts: counts };
}


// ============================================================
// ===  Escritura  ============================================
// ============================================================

/**
 * Valida y, si todo está bien, escribe los datos en las pestañas.
 *
 * @param {Object<string,string>} csvByKey
 * @param {{dryRun?:boolean, force?:boolean}} [opts]
 *   dryRun: solo valida. force: borra los datos actuales de esas pestañas antes.
 * @return {{ok:boolean, dryRun:boolean, errors:string[], warnings:string[], counts:Object}}
 */
function gbMigrationImport_(csvByKey, opts) {
  opts = opts || {};
  var plan = gbMigrationPlan_(csvByKey);
  var result = { ok: false, dryRun: !!opts.dryRun, errors: plan.errors.slice(), warnings: plan.warnings, counts: plan.counts };
  if (result.errors.length) return result;

  gbMigrationFiles_().forEach(function (f) {
    var spec = gbSpec_(f.key);
    var sheet = gbSheet_(f.key);
    if (sheet.getLastRow() > 1 && !opts.force) {
      result.errors.push('La pestaña "' + spec.name + '" ya tiene datos. Para reemplazarlos confirma la opción de reemplazo.');
    }
  });
  if (result.errors.length || opts.dryRun) {
    result.ok = !result.errors.length;
    return result;
  }

  gbWithLock_(function () {
    gbMigrationFiles_().forEach(function (f) {
      var spec = gbSpec_(f.key);
      var sheet = gbSheet_(f.key);
      var map = gbHeaderMap_(sheet, spec);
      var width = Math.max(sheet.getLastColumn(), spec.headers.length);
      var data = plan.rows[f.key].map(function (r) { return gbRowArray_(spec, map, width, r); });

      if (sheet.getLastRow() > 1) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, width).clearContent();
      }
      if (data.length) {
        gbEnsureRows_(sheet, spec, data.length + 1);
        sheet.getRange(2, 1, data.length, width).setValues(data);
      }
    });
  }, 60000);

  log_('migracion', 'OK', { importado: plan.counts, avisos: plan.warnings.length });
  result.ok = true;
  return result;
}


// ============================================================
// ===  Verificación de la hoja ya cargada  ===================
// ============================================================

/**
 * Revisa la integridad de las pestañas cargadas (sin modificarlas).
 * @return {{ok:boolean, counts:Object, issues:string[]}}
 */
function gbMigrationVerify_() {
  var issues = [];
  var members = gbList_('members');
  var payments = gbList_('payments');
  var measurements = gbList_('measurements');
  var evaluations = gbList_('evaluations');
  var counts = {
    miembros: members.length, pagos: payments.length,
    medidas: measurements.length, evaluaciones: evaluations.length
  };

  var ids = {}, dpis = {}, tokens = {};
  members.forEach(function (m) {
    var ref = 'Miembros fila ' + m._row;
    if (typeof m.DPI !== 'string') issues.push(ref + ': el DPI está guardado como número (debe ser texto; formatea la columna como Texto sin formato).');
    if (!/^\d{13}$/.test(String(m.DPI))) issues.push(ref + ': el DPI no tiene 13 dígitos.');
    if (!/^\d{8}$/.test(String(m.Telefono))) issues.push(ref + ': teléfono sin 8 dígitos.');
    if (ids[m.MemberID]) issues.push(ref + ': MemberID repetido.');
    if (dpis[m.DPI]) issues.push(ref + ': DPI repetido.');
    if (!m.TokenQR) issues.push(ref + ': sin TokenQR.');
    else if (tokens[m.TokenQR]) issues.push(ref + ': TokenQR repetido.');
    if (['Activo', 'Inactivo', 'Suspendido'].indexOf(m.Estado) === -1) issues.push(ref + ': Estado no válido.');
    ids[m.MemberID] = true; dpis[m.DPI] = true; tokens[m.TokenQR] = true;
  });

  [['Pagos', payments], ['Medidas', measurements], ['Evaluaciones', evaluations]].forEach(function (pair) {
    pair[1].forEach(function (r) {
      if (!ids[r.MemberID]) issues.push(pair[0] + ' fila ' + r._row + ': el miembro ' + r.MemberID + ' no existe.');
      if (!(r.Fecha instanceof Date)) issues.push(pair[0] + ' fila ' + r._row + ': la fecha no es una fecha válida.');
    });
  });
  payments.forEach(function (p) {
    if (typeof p.Monto !== 'number' || p.Monto <= 0) issues.push('Pagos fila ' + p._row + ': monto no válido.');
  });

  if (gbList_('exercises').length !== 28) issues.push('EjerciciosEvaluacion debe tener 28 ejercicios (tiene ' + gbList_('exercises').length + ').');
  if (!gbList_('templates').length) issues.push('Plantillas está vacía.');

  return { ok: issues.length === 0, counts: counts, issues: issues };
}


// ============================================================
// ===  Menú de la hoja (solo Admin)  =========================
// ============================================================

function gbMigrationReportText_(result) {
  var lines = [];
  var c = result.counts || {};
  lines.push('Miembros: ' + (c.members || 0) + ' · Pagos: ' + (c.payments || 0) +
             ' · Medidas: ' + (c.measurements || 0) + ' · Evaluaciones: ' + (c.evaluations || 0));
  if (result.errors && result.errors.length) {
    lines.push('', 'ERRORES (' + result.errors.length + '):');
    result.errors.slice(0, 15).forEach(function (e) { lines.push('• ' + e); });
    if (result.errors.length > 15) lines.push('… y ' + (result.errors.length - 15) + ' más.');
  }
  if (result.warnings && result.warnings.length) {
    lines.push('', 'Avisos (' + result.warnings.length + '):');
    result.warnings.slice(0, 8).forEach(function (w) { lines.push('• ' + w); });
    if (result.warnings.length > 8) lines.push('… y ' + (result.warnings.length - 8) + ' más.');
  }
  return lines.join('\n');
}

function gbMigrationFolderId_(ui) {
  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperty(GB_MIGRATION_FOLDER_PROP);
  if (saved) return saved;

  var response = ui.prompt('Carpeta de Drive con los CSV',
    'Pega el enlace o el ID de la carpeta de Drive donde subiste los archivos de la migración.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return '';
  var id = gbDriveId_(response.getResponseText());
  if (!id) { ui.alert('No se reconoció el enlace o ID de la carpeta.'); return ''; }
  props.setProperty(GB_MIGRATION_FOLDER_PROP, id);
  return id;
}

function gbMigrationReadFolder_(folderId) {
  var folder = DriveApp.getFolderById(folderId);
  var csv = {};
  gbMigrationFiles_().forEach(function (f) {
    var files = folder.getFilesByName(f.file);
    if (files.hasNext()) csv[f.key] = files.next().getBlob().getDataAsString('UTF-8');
  });
  return csv;
}

function gbMigrationRunMenu_(dryRun) {
  gbRequireAdminForMenu_();
  var ui = SpreadsheetApp.getUi();
  var folderId = gbMigrationFolderId_(ui);
  if (!folderId) return;

  var csv;
  try { csv = gbMigrationReadFolder_(folderId); }
  catch (e) {
    ui.alert('No se pudo abrir la carpeta de Drive', String(e.message || e), ui.ButtonSet.OK);
    return;
  }

  var result = gbMigrationImport_(csv, { dryRun: dryRun });
  // Si las pestañas ya tienen datos, preguntar antes de reemplazar.
  var needsForce = !dryRun && result.errors.some(function (e) { return e.indexOf('ya tiene datos') !== -1; });
  if (needsForce && result.errors.every(function (e) { return e.indexOf('ya tiene datos') !== -1; })) {
    var answer = ui.alert('Reemplazar datos',
      'Algunas pestañas ya tienen datos. ¿Reemplazarlos por los del Excel? Esta acción borra lo que hay en Miembros, Pagos, Medidas y Evaluaciones.',
      ui.ButtonSet.YES_NO);
    if (answer === ui.Button.YES) result = gbMigrationImport_(csv, { force: true });
  }

  var title = result.ok
    ? (dryRun ? 'Simulacro correcto: todo se puede importar' : 'Migración completada')
    : 'No se importó nada';
  ui.alert(title, gbMigrationReportText_(result), ui.ButtonSet.OK);
}

function gbMigrationDryRunMenu_() { gbMigrationRunMenu_(true); }
function gbMigrationImportMenu_() { gbMigrationRunMenu_(false); }

function gbMigrationVerifyMenu_() {
  gbRequireAdminForMenu_();
  var ui = SpreadsheetApp.getUi();
  var result = gbMigrationVerify_();
  var text = 'Miembros: ' + result.counts.miembros + ' · Pagos: ' + result.counts.pagos +
             ' · Medidas: ' + result.counts.medidas + ' · Evaluaciones: ' + result.counts.evaluaciones;
  if (result.ok) {
    ui.alert('Todo en orden', text + '\n\nNo se encontraron problemas.', ui.ButtonSet.OK);
  } else {
    var shown = result.issues.slice(0, 15).map(function (i) { return '• ' + i; }).join('\n');
    var more = result.issues.length > 15 ? '\n… y ' + (result.issues.length - 15) + ' más.' : '';
    ui.alert('Hay ' + result.issues.length + ' problemas', text + '\n\n' + shown + more, ui.ButtonSet.OK);
  }
}
