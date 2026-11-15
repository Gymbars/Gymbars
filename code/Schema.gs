/**
 * Schema.gs — Modelo de datos del sistema de gestión del gimnasio.
 *
 * UNA sola fuente de verdad para las pestañas operativas (miembros, pagos,
 * medidas, evaluaciones, asistencia, mensajes…). Cada pestaña es una tabla con
 * encabezados fijos; Repo.gs lee y escribe por NOMBRE de columna, así que se
 * puede reordenar columnas en la hoja sin romper el código.
 *
 * Todo es una función (no variables globales) para no depender del orden en que
 * Apps Script carga los archivos.
 *
 * IMPORTANTE: estas pestañas contienen datos personales (DPI, teléfonos, fechas
 * de nacimiento). Nunca se agregan a `getWebsiteData()` ni a `?api=data`.
 */

/** Código del país por defecto (Guatemala) para armar enlaces de WhatsApp. */
var GB_DEFAULT_COUNTRY_CODE = '502';

/**
 * Definición de las pestañas.
 *  - name:    nombre visible de la pestaña
 *  - headers: encabezados en orden
 *  - id:      { field, prefix, pad } para generar IDs legibles (GB-0001)
 *  - dates:   columnas con fecha (yyyy-mm-dd)
 *  - dateTimes: columnas con fecha y hora
 *  - text:    columnas que SIEMPRE son texto (DPI, teléfonos…)
 *  - numbers: columnas numéricas (monto, medidas, resultados…)
 *  - lists:   validaciones de lista { Columna: [valores] }
 *
 * @return {Object<string,Object>}
 */
function gbSchema_() {
  var exerciseCols = [];
  [0, 1, 2, 3].forEach(function (level) {
    for (var n = 1; n <= 7; n++) exerciseCols.push('N' + level + n);
  });

  return {
    users: {
      name: 'Usuarios',
      headers: ['Email', 'Rol', 'Activo'],
      lists: { Rol: ['Admin', 'Coach'], Activo: ['Si', 'No'] }
    },
    members: {
      name: 'Miembros',
      headers: ['MemberID', 'DPI', 'Nombres', 'Apellidos', 'FechaNacimiento', 'Telefono', 'Correo',
                'Genero', 'Mensualidad', 'DiaPago', 'Estado', 'TokenQR', 'FechaRegistro', 'Notas'],
      id: { field: 'MemberID', prefix: 'GB-', pad: 4 },
      dates: ['FechaNacimiento', 'FechaRegistro'],
      numbers: ['Mensualidad', 'DiaPago'],
      text: ['MemberID', 'DPI', 'Telefono', 'TokenQR'],
      lists: { Genero: ['Masculino', 'Femenino'], Estado: ['Activo', 'Inactivo', 'Suspendido'] }
    },
    payments: {
      name: 'Pagos',
      headers: ['PagoID', 'MemberID', 'Fecha', 'Monto', 'Nota', 'ComprobanteToken'],
      id: { field: 'PagoID', prefix: 'PG-', pad: 5 },
      dates: ['Fecha'],
      numbers: ['Monto'],
      text: ['PagoID', 'MemberID', 'ComprobanteToken']
    },
    measurements: {
      name: 'Medidas',
      headers: ['MedidaID', 'MemberID', 'Fecha', 'Cuello', 'Pecho', 'BrazoDer', 'BrazoIzq', 'Cintura',
                'Cadera', 'PiernaDer', 'PiernaIzq', 'PesoLb'],
      id: { field: 'MedidaID', prefix: 'MD-', pad: 5 },
      dates: ['Fecha'],
      numbers: ['Cuello', 'Pecho', 'BrazoDer', 'BrazoIzq', 'Cintura', 'Cadera', 'PiernaDer', 'PiernaIzq', 'PesoLb'],
      text: ['MedidaID', 'MemberID']
    },
    evaluations: {
      name: 'Evaluaciones',
      headers: ['EvalID', 'MemberID', 'Fecha'].concat(exerciseCols),
      id: { field: 'EvalID', prefix: 'EV-', pad: 5 },
      dates: ['Fecha'],
      numbers: exerciseCols,
      text: ['EvalID', 'MemberID']
    },
    exercises: {
      name: 'EjerciciosEvaluacion',
      headers: ['Codigo', 'Nivel', 'Nombre', 'Meta', 'Unidad'],
      numbers: ['Nivel', 'Meta'],
      text: ['Codigo'],
      lists: { Unidad: ['rep', 'seg'] }
    },
    attendance: {
      name: 'Asistencia',
      headers: ['AsistenciaID', 'MemberID', 'FechaHora', 'Fecha', 'Origen', 'DispositivoID', 'EstadoAlMomento'],
      id: { field: 'AsistenciaID', prefix: 'AS-', pad: 6 },
      dates: ['Fecha'],
      dateTimes: ['FechaHora'],
      text: ['AsistenciaID', 'MemberID', 'DispositivoID'],
      lists: { Origen: ['QR', 'Manual'] }
    },
    devices: {
      name: 'Dispositivos',
      headers: ['DispositivoID', 'Nombre', 'TokenHash', 'Activo', 'CreadoEn', 'UltimoUso'],
      id: { field: 'DispositivoID', prefix: 'DV-', pad: 3 },
      dateTimes: ['CreadoEn', 'UltimoUso'],
      text: ['DispositivoID', 'TokenHash'],
      lists: { Activo: ['Si', 'No'] }
    },
    messages: {
      name: 'Mensajes',
      headers: ['MensajeID', 'MemberID', 'Tipo', 'Canal', 'Para', 'Asunto', 'Texto', 'EnlaceReporte',
                'Estado', 'CreadoEn', 'EnviadoPor', 'EnviadoEn', 'ClaveDedup'],
      id: { field: 'MensajeID', prefix: 'MS-', pad: 6 },
      dateTimes: ['CreadoEn', 'EnviadoEn'],
      text: ['MensajeID', 'MemberID', 'Para', 'ClaveDedup'],
      lists: {
        Canal: ['WhatsApp', 'Email'],
        Estado: ['Pendiente', 'Enviado', 'Descartado', 'Error']
      }
    },
    templates: {
      name: 'Plantillas',
      headers: ['Tipo', 'Canal', 'Asunto', 'Texto'],
      lists: { Canal: ['WhatsApp', 'Email'] }
    },
    config: {
      name: 'ConfigGym',
      headers: ['Clave', 'Valor'],
      text: ['Clave']
    }
  };
}

/** Pestañas operativas: { clave: nombre } (para listados de estado). */
function gbSheetNames_() {
  var schema = gbSchema_();
  var out = {};
  Object.keys(schema).forEach(function (key) { out[key] = schema[key].name; });
  return out;
}

/** Columnas de evaluación (N01…N37) en orden. */
function gbExerciseCodes_() {
  var codes = [];
  [0, 1, 2, 3].forEach(function (level) {
    for (var n = 1; n <= 7; n++) codes.push('N' + level + n);
  });
  return codes;
}


// ============================================================
// ===  Datos iniciales (solo si la pestaña está vacía)  ======
// ============================================================

/**
 * Catálogo de la evaluación física (4 niveles × 7 ejercicios) con la meta de
 * cada uno. El puntaje de un nivel es el promedio de (resultado / meta) de los
 * ejercicios registrados; es la misma regla del Excel, ahora en una tabla.
 */
function gbExerciseSeed_() {
  var rows = [
    ['N01', 0, 'Plancha', 60, 'seg'], ['N02', 0, 'Sentadillas', 20, 'rep'],
    ['N03', 0, 'Desplantes', 10, 'rep'], ['N04', 0, 'Flexiones', 20, 'rep'],
    ['N05', 0, 'Elevación de piernas', 10, 'rep'], ['N06', 0, 'Alpinista', 60, 'seg'],
    ['N07', 0, 'Flexiones pica', 20, 'rep'],

    ['N11', 1, 'Dominada supina', 5, 'rep'], ['N12', 1, 'Wall sit', 60, 'seg'],
    ['N13', 1, 'Fondos', 5, 'rep'], ['N14', 1, 'Sentadillas', 20, 'rep'],
    ['N15', 1, 'Flexiones declinadas', 8, 'rep'], ['N16', 1, 'Dominada prona', 5, 'rep'],
    ['N17', 1, 'Elevación de pies', 5, 'rep'],

    ['N21', 2, 'Dominada supina', 10, 'rep'], ['N22', 2, 'Fondos en paralelas', 10, 'rep'],
    ['N23', 2, 'Dominadas pronas', 10, 'rep'], ['N24', 2, 'Flexiones', 15, 'rep'],
    ['N25', 2, 'Parada de manos', 5, 'seg'], ['N26', 2, 'Sentadillas con salto', 20, 'rep'],
    ['N27', 2, 'Remos invertidos', 20, 'rep'],

    ['N31', 3, 'Dominada supina', 20, 'rep'], ['N32', 3, 'Fondos en paralelas', 20, 'rep'],
    ['N33', 3, 'Dominadas pronas', 20, 'rep'], ['N34', 3, 'Flexiones', 20, 'rep'],
    ['N35', 3, 'Parada de manos', 30, 'seg'], ['N36', 3, 'Sentadillas con salto', 20, 'rep'],
    ['N37', 3, 'Remos invertidos', 20, 'rep']
  ];
  return rows;
}

/**
 * Plantillas de mensajes. Variables: {nombre} {fecha} {monto} {proximoPago}
 * {enlace} {dias} {gym}. La de "boleta" es el texto que el Excel tenía en Hoja1.
 */
function gbTemplateSeed_() {
  var boleta =
    '🧾 {gym}\n\n' +
    'Hola {nombre} 🙌\n\n' +
    '¡Gracias por tu pago! Ya estás al día y listo para seguir avanzando 💪\n\n' +
    'Tu registro:\n' +
    '📅 Pagaste el: {fecha}\n' +
    '💰 Total: Q{monto}\n' +
    '📆 Próximo pago: {proximoPago}\n\n' +
    'Tu boleta: {enlace}\n\n' +
    'Nos alegra tenerte como parte de la familia {gym} 🔥\n' +
    '¡Nos vemos en el entrenamiento!\n\n' +
    'Equipo {gym}';

  return [
    ['boleta', 'WhatsApp', '', boleta],
    ['boleta', 'Email', 'Tu boleta de pago de {gym}', boleta],
    ['recordatorio_pago', 'WhatsApp', '',
      'Hola {nombre} 👋 Te recordamos que tu mensualidad de {gym} (Q{monto}) vence el {proximoPago}. ¡Te esperamos para seguir entrenando! 💪'],
    ['recordatorio_pago', 'Email', 'Tu mensualidad de {gym} vence pronto',
      'Hola {nombre},\n\nTe recordamos que tu mensualidad de {gym} (Q{monto}) vence el {proximoPago}.\n\n¡Te esperamos para seguir entrenando!\n\nEquipo {gym}'],
    ['pago_vencido', 'WhatsApp', '',
      'Hola {nombre} 👋 Tu mensualidad de {gym} venció el {proximoPago}. Escríbenos para ponerte al día y seguir con tu entrenamiento 💪'],
    ['pago_vencido', 'Email', 'Tu mensualidad de {gym} está vencida',
      'Hola {nombre},\n\nTu mensualidad de {gym} venció el {proximoPago}. Escríbenos para ponerte al día.\n\nEquipo {gym}'],
    ['inactividad', 'WhatsApp', '',
      'Hola {nombre} 👋 Hace {dias} días que no te vemos por {gym}. ¿Todo bien? Tu membresía sigue activa y tu progreso te está esperando 💪'],
    ['inactividad', 'Email', 'Te extrañamos en {gym}',
      'Hola {nombre},\n\nHace {dias} días que no te vemos por {gym}. Tu membresía sigue activa; ¡te esperamos!\n\nEquipo {gym}'],
    ['progreso', 'WhatsApp', '',
      'Hola {nombre} 📈 Ya toca registrar tus medidas del mes. Ven a tu próxima sesión y revisamos tu progreso juntos. Tu último reporte: {enlace}'],
    ['medidas', 'WhatsApp', '', 'Hola {nombre} 📏 Aquí está tu reporte de medidas: {enlace}'],
    ['medidas', 'Email', 'Tu reporte de medidas de {gym}',
      'Hola {nombre},\n\nAquí está tu reporte de medidas: {enlace}\n\nEquipo {gym}'],
    ['evaluacion', 'WhatsApp', '', 'Hola {nombre} 🏋️ Aquí está tu evaluación física: {enlace}'],
    ['evaluacion', 'Email', 'Tu evaluación física de {gym}',
      'Hola {nombre},\n\nAquí está tu evaluación física: {enlace}\n\nEquipo {gym}'],
    ['carnet', 'WhatsApp', '',
      'Hola {nombre} 🎟️ Este es tu carnet de {gym} con tu código QR para registrar tu asistencia: {enlace}'],
    ['carnet', 'Email', 'Tu carnet de {gym}',
      'Hola {nombre},\n\nEste es tu carnet de {gym} con tu código QR para registrar tu asistencia: {enlace}\n\nEquipo {gym}']
  ];
}

/** Configuración inicial. Las automatizaciones empiezan APAGADAS. */
function gbConfigSeed_() {
  return [
    ['nombre_gym', 'Gymbars'],
    ['pais_codigo', GB_DEFAULT_COUNTRY_CODE],
    ['dias_gracia', '3'],
    ['recordatorio_dias_antes', '3'],
    ['inactividad_dias', '10'],
    ['medidas_dias', '30'],
    ['ventana_scan_minutos', '240'],
    ['hora_diaria', '7'],
    ['email_activo', 'SI'],
    ['asistencia_desde', ''],
    ['scanner_url', ''],
    ['automatizacion_activa', 'NO']
  ];
}

/**
 * Crea las pestañas del modelo que falten, con encabezados, formatos,
 * validaciones y datos iniciales. No borra ni sobrescribe nada existente.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {string[]} Nombres de pestañas creadas.
 */
function gbSetupSchemaSheets_(ss) {
  var schema = gbSchema_();
  var created = [];

  Object.keys(schema).forEach(function (key) {
    var spec = schema[key];
    var sheet = ss.getSheetByName(spec.name);
    if (!sheet) {
      sheet = ss.insertSheet(spec.name);
      created.push(spec.name);
    }
    // Una hoja nueva trae 26 columnas; Evaluaciones necesita 31.
    if (sheet.getMaxColumns() < spec.headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), spec.headers.length - sheet.getMaxColumns());
    }
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    gbApplySheetFormats_(sheet, spec);
  });

  gbSeedIfEmpty_(ss, schema.exercises, gbExerciseSeed_());
  gbSeedIfEmpty_(ss, schema.templates, gbTemplateSeed_());
  gbSeedIfEmpty_(ss, schema.config, gbConfigSeed_());
  return created;
}

function gbSeedIfEmpty_(ss, spec, rows) {
  var sheet = ss.getSheetByName(spec.name);
  if (!sheet || sheet.getLastRow() > 1 || !rows.length) return;
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Formatos de columna (texto, fechas) y listas desplegables.
 * Sin `firstRow`/`count` se aplican a toda la hoja; con ellos solo a ese tramo
 * (filas nuevas que se agregan cuando la tabla crece).
 */
function gbApplySheetFormats_(sheet, spec, firstRow, count) {
  var start = firstRow || 2;
  var rows = count || Math.max(sheet.getMaxRows() - 1, 1);
  var col = function (name) { return spec.headers.indexOf(name) + 1; };

  (spec.text || []).forEach(function (name) {
    if (col(name) > 0) sheet.getRange(start, col(name), rows, 1).setNumberFormat('@');
  });
  (spec.dates || []).forEach(function (name) {
    if (col(name) > 0) sheet.getRange(start, col(name), rows, 1).setNumberFormat('yyyy-mm-dd');
  });
  (spec.dateTimes || []).forEach(function (name) {
    if (col(name) > 0) sheet.getRange(start, col(name), rows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  });

  var lists = spec.lists || {};
  Object.keys(lists).forEach(function (name) {
    if (col(name) < 1) return;
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(lists[name], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(start, col(name), rows, 1).setDataValidation(rule);
  });
}

/** Asegura que haya sitio para escribir hasta la fila `lastNeeded` (agrega filas con su formato). */
function gbEnsureRows_(sheet, spec, lastNeeded) {
  var max = sheet.getMaxRows();
  if (lastNeeded <= max) return;
  var add = Math.max(500, lastNeeded - max);
  sheet.insertRowsAfter(max, add);
  gbApplySheetFormats_(sheet, spec, max + 1, add);
}
