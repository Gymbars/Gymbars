/**
 * Rules.gs — Reglas de negocio puras (sin leer ni escribir la hoja).
 *
 * Todo lo que "decide" algo vive aquí para poder probarlo con casos concretos:
 * próxima fecha de pago, estado de pago, puntaje de evaluación, normalización de
 * DPI/teléfono, enlaces de WhatsApp y plantillas de mensajes.
 *
 * Las reglas replican las del Excel (CONTROL GYMBRAS.xlsm); donde se mejoró algo
 * está indicado.
 */

// ============================================================
// ===  Normalización  ========================================
// ============================================================

function gbDigits_(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

/** DPI: solo dígitos. */
function gbNormDpi_(value) {
  return gbDigits_(value);
}

/** Teléfono local de 8 dígitos (quita el código de país si viene incluido). */
function gbNormPhone_(value) {
  var d = gbDigits_(value);
  if (d.length === 11 && d.indexOf('502') === 0) d = d.substring(3);
  return d;
}

/**
 * Número listo para WhatsApp (código de país + 8 dígitos), o '' si no es válido.
 * El Excel guardaba solo los 8 dígitos, por eso sus enlaces no abrían el chat.
 */
function gbWaPhone_(phone, countryCode) {
  var cc = gbDigits_(countryCode || GB_DEFAULT_COUNTRY_CODE);
  var d = gbDigits_(phone);
  if (d.length === 8) return cc + d;
  if (d.length === 8 + cc.length && d.indexOf(cc) === 0) return d;
  return '';
}

/** Enlace para abrir WhatsApp con el mensaje escrito ('' si el teléfono no sirve). */
function gbWaLink_(phone, text, countryCode) {
  var wa = gbWaPhone_(phone, countryCode);
  if (!wa) return '';
  return 'https://wa.me/' + wa + '?text=' + encodeURIComponent(String(text == null ? '' : text));
}

function gbIsEmail_(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim());
}

/** "Nombres Apellidos" sin espacios dobles. */
function gbFullName_(row) {
  return (String(row.Nombres || '') + ' ' + String(row.Apellidos || '')).replace(/\s+/g, ' ').trim();
}

/** DPI con solo los últimos 4 dígitos visibles. */
function gbMaskDpi_(dpi) {
  var d = gbDigits_(dpi);
  return d.length > 4 ? '•••• •••• ' + d.substring(d.length - 4) : d;
}

/** Texto para búsquedas: minúsculas y sin tildes. */
function gbSearchText_(value) {
  return String(value == null ? '' : value).toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n');
}

/** Años cumplidos a la fecha `today`. */
function gbAge_(birth, today) {
  var b = gbParseDate_(birth), t = gbParseDate_(today);
  if (!b || !t) return '';
  var age = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) age--;
  return age < 0 ? '' : age;
}


// ============================================================
// ===  Pagos  ================================================
// ============================================================

function gbDaysInMonth_(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Días enteros de `a` a `b` (positivo si b es posterior). */
function gbDaysBetween_(a, b) {
  var A = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  var B = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((B - A) / 86400000);
}

/**
 * Próxima fecha de pago: el mismo día del mes siguiente (Excel: PAGOS!G14).
 * Mejora: si el mes siguiente no tiene ese día (31 en febrero) se usa el último
 * día del mes, en vez de saltar al mes después como hacía DATE() en Excel.
 *
 * @param {Date|string} paidOn Fecha del pago.
 * @param {number|string} [payDay] Día de pago del miembro (si falta, el del pago).
 * @return {Date|null}
 */
function gbNextPaymentDate_(paidOn, payDay) {
  var d = gbParseDate_(paidOn);
  if (!d) return null;
  var day = parseInt(payDay, 10);
  if (!(day >= 1 && day <= 31)) day = d.getDate();
  var year = d.getFullYear(), month = d.getMonth() + 1;
  if (month > 11) { month = 0; year++; }
  return new Date(year, month, Math.min(day, gbDaysInMonth_(year, month)), 12, 0, 0);
}

/**
 * Estado de pago de un miembro según su último pago.
 *   sin_pagos  nunca ha pagado
 *   al_dia     la mensualidad está cubierta
 *   por_vencer vence en `antes` días o menos
 *   gracia     venció hace `gracia` días o menos
 *   vencido    venció hace más de `gracia` días
 *
 * @param {{DiaPago:*}} member
 * @param {Date|string|null} lastPaidOn
 * @param {Date|string} today
 * @param {{antes?:number, gracia?:number}} [opts]
 * @return {{code:string,label:string,nextDue:string,daysToDue:(number|''),daysOverdue:number}}
 */
function gbPaymentStatus_(member, lastPaidOn, today, opts) {
  opts = opts || {};
  var antes = opts.antes == null ? 3 : opts.antes;
  var gracia = opts.gracia == null ? 3 : opts.gracia;

  var last = gbParseDate_(lastPaidOn);
  if (!last) {
    return { code: 'sin_pagos', label: 'Sin pagos', nextDue: '', daysToDue: '', daysOverdue: 0 };
  }

  var now = gbParseDate_(today);
  var due = gbNextPaymentDate_(last, member && member.DiaPago);
  var diff = gbDaysBetween_(now, due); // días que faltan (negativo = ya venció)
  var out = { nextDue: gbFmtDate_(due), daysToDue: diff, daysOverdue: diff < 0 ? -diff : 0 };

  if (diff >= 0) {
    out.code = diff <= antes ? 'por_vencer' : 'al_dia';
    out.label = diff <= antes ? 'Por vencer' : 'Al día';
  } else if (-diff <= gracia) {
    out.code = 'gracia';
    out.label = 'En gracia';
  } else {
    out.code = 'vencido';
    out.label = 'Vencido';
  }
  return out;
}


// ============================================================
// ===  Evaluación física  ====================================
// ============================================================

/**
 * Puntaje por nivel, igual que las fórmulas del Excel (EVALUACIONES!P5:S5):
 *   suma( resultado / meta  de cada ejercicio registrado ) ÷ nº de ejercicios del nivel.
 * Los ejercicios vacíos cuentan como 0 (por eso una evaluación incompleta puntúa
 * menos) y no hay tope: superar la meta suma más del 100 %. Si no hay ningún
 * resultado el nivel queda vacío ('').
 *
 * @param {Object} evaluation Fila con columnas N01…N37.
 * @param {Array<Array>} catalog Filas [Codigo, Nivel, Nombre, Meta, Unidad].
 * @return {{n0:(number|string), n1:(number|string), n2:(number|string), n3:(number|string)}}
 */
function gbEvaluationScores_(evaluation, catalog) {
  var sums = [0, 0, 0, 0], counts = [0, 0, 0, 0];
  catalog.forEach(function (ex) {
    var code = ex[0], level = Number(ex[1]), goal = Number(ex[3]);
    if (!(level >= 0 && level <= 3)) return;
    counts[level]++;
    var v = evaluation[code];
    if (v === '' || v == null || isNaN(Number(v))) return;
    if (goal > 0) sums[level] += Number(v) / goal;
  });

  var out = {};
  for (var l = 0; l < 4; l++) {
    out['n' + l] = (sums[l] === 0 || counts[l] === 0) ? '' : Math.round((sums[l] / counts[l]) * 10000) / 10000;
  }
  return out;
}


// ============================================================
// ===  Plantillas de mensajes  ===============================
// ============================================================

/** Reemplaza {variable} en el texto; las variables sin valor quedan vacías. */
function gbRenderTemplate_(text, vars) {
  return String(text == null ? '' : text).replace(/\{([A-Za-z0-9_]+)\}/g, function (_, name) {
    var v = vars && vars[name];
    return v == null ? '' : String(v);
  });
}
