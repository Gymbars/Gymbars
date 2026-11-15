/**
 * Triggers.gs — Automatización diaria: recordatorios de pago e inactividad.
 *
 * Un disparador (trigger) diario ejecuta `gbDailyJob`. Si `automatizacion_activa`
 * está en SI, el sistema revisa a los miembros ACTIVOS y deja mensajes en la bandeja:
 *   - recordatorio_pago : la mensualidad vence en ≤ N días (o hoy)
 *   - pago_vencido      : pasó el periodo de gracia sin pagar (uno por ciclo)
 *   - inactividad       : tiene membresía vigente pero no viene hace ≥ N días
 *                         (solo si el control de asistencia ya está en uso)
 *   - progreso          : ya tocan medidas (≥ N días desde las últimas)
 *
 * Nada sale solo por WhatsApp: los mensajes quedan pendientes en la bandeja para
 * enviarse con un toque. Solo los correos se envían automáticamente.
 *
 * Seguridad al estrenar: la automatización arranca APAGADA y existe una pantalla
 * de revisión de estados para que el personal marque como Inactivos a quienes ya
 * no vienen ANTES de encenderla.
 */

/** Cuántos mensajes crear como máximo por ejecución (el resto sigue al día siguiente). */
var GB_DAILY_MAX = 60;

/** Estados de pago que cuentan como membresía vigente. */
function gbSubscribedCodes_() {
  return ['al_dia', 'por_vencer', 'gracia'];
}


// ============================================================
// ===  Plan del día (no escribe nada)  =======================
// ============================================================

/**
 * Calcula qué mensajes corresponde crear hoy.
 * @param {string} today yyyy-MM-dd
 * @return {Array<{type:string, memberId:string, nombre:string, extra?:Object, motivo:string}>}
 */
function gbDailyPlan_(today) {
  var options = gbPaymentOptions_();
  var inactivityDays = gbConfigNumber_('inactividad_dias', 10);
  var measureDays = gbConfigNumber_('medidas_dias', 30);
  var start = gbAttendanceStart_();
  var todayDate = gbParseDate_(today);

  var members = gbList_('members', function (m) { return m.Estado === 'Activo'; });
  var lastPay = gbLastPaymentMap_();
  var lastAtt = start ? gbLastAttendanceMap_() : {};
  var lastMeas = {};
  gbList_('measurements').forEach(function (x) {
    var d = gbParseDate_(x.Fecha);
    if (d && (!lastMeas[x.MemberID] || d > lastMeas[x.MemberID])) lastMeas[x.MemberID] = d;
  });
  var lastInactivityMsg = {};
  gbList_('messages', function (m) { return m.Tipo === 'inactividad' && m.Estado !== 'Descartado'; }).forEach(function (m) {
    var d = gbParseDate_(m.CreadoEn);
    if (d && (!lastInactivityMsg[m.MemberID] || d > lastInactivityMsg[m.MemberID])) lastInactivityMsg[m.MemberID] = d;
  });

  var plan = [];
  members.forEach(function (m) {
    var status = gbPaymentStatus_(m, lastPay[m.MemberID], today, options);
    var name = gbFullName_(m);

    if (status.code === 'por_vencer') {
      plan.push({ type: 'recordatorio_pago', memberId: m.MemberID, nombre: name, motivo: 'Vence ' + status.nextDue });
    } else if (status.code === 'vencido') {
      plan.push({ type: 'pago_vencido', memberId: m.MemberID, nombre: name,
                  motivo: 'Venció ' + status.nextDue + ' (' + status.daysOverdue + ' días)' });
    }

    if (gbSubscribedCodes_().indexOf(status.code) === -1) return;

    // Inactividad: solo con control de asistencia en uso; se cuenta desde la última visita
    // o desde que empezó el control (lo que sea más reciente), para no culpar a nadie del pasado.
    if (start) {
      var reference = lastAtt[m.MemberID] && lastAtt[m.MemberID] > start ? lastAtt[m.MemberID] : start;
      var registered = gbParseDate_(m.FechaRegistro);
      if (registered && registered > reference) reference = registered;
      var days = gbDaysBetween_(reference, todayDate);
      var lastMsg = lastInactivityMsg[m.MemberID];
      if (days >= inactivityDays && (!lastMsg || gbDaysBetween_(lastMsg, todayDate) >= 14)) {
        plan.push({ type: 'inactividad', memberId: m.MemberID, nombre: name, extra: { dias: days },
                    motivo: days + ' días sin asistir' });
      }
    }

    // Progreso: solo miembros que ya tienen medidas (el entrenador ya les lleva el control).
    if (lastMeas[m.MemberID] && gbDaysBetween_(lastMeas[m.MemberID], todayDate) >= measureDays) {
      plan.push({ type: 'progreso', memberId: m.MemberID, nombre: name,
                  motivo: gbDaysBetween_(lastMeas[m.MemberID], todayDate) + ' días desde las últimas medidas' });
    }
  });

  // Prioridad: pagos primero, luego inactividad, luego progreso.
  var order = { pago_vencido: 0, recordatorio_pago: 1, inactividad: 2, progreso: 3 };
  plan.sort(function (a, b) { return order[a.type] - order[b.type]; });
  return plan;
}


// ============================================================
// ===  Ejecución  ============================================
// ============================================================

/**
 * Ejecuta el trabajo diario.
 * @param {{today?:string, dryRun?:boolean, force?:boolean, max?:number}} [opts]
 *   force: ignora el interruptor de automatización (para pruebas del Admin).
 */
function gbRunDailyJob_(opts) {
  opts = opts || {};
  var startedAt = Date.now();
  if (!opts.force && !gbConfigFlag_('automatizacion_activa')) {
    return { ok: true, skipped: true, reason: 'La automatización está apagada.' };
  }

  var plan = gbDailyPlan_(opts.today || gbToday_());
  var max = opts.max || GB_DAILY_MAX;
  var batch = plan.slice(0, max);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, total: plan.length, mostrados: batch.length,
             porTipo: gbCountBy_(plan, 'type'), items: batch };
  }

  var created = {}, existing = 0, errors = 0, warnings = {};
  for (var i = 0; i < batch.length; i++) {
    if (Date.now() - startedAt > 4.5 * 60 * 1000) break; // el límite de Apps Script es 6 minutos
    var item = batch[i];
    try {
      var r = gbQueueMessage_({ type: item.type, memberId: item.memberId, extra: item.extra });
      var fresh = (r.whatsapp ? 1 : 0) + (r.email ? 1 : 0) - r.existing;
      if (fresh > 0) created[item.type] = (created[item.type] || 0) + fresh;
      existing += r.existing;
      (r.warnings || []).forEach(function (w) { warnings[w] = true; });
    } catch (e) {
      errors++;
      log_('automatizacion', 'ERROR', { tipo: item.type, miembro: item.memberId, error: String(e.message || e).substring(0, 150) });
    }
  }

  var emails = { sent: 0 };
  try { emails = gbSendPendingEmails_(40); } catch (e) { log_('automatizacion', 'ERROR', 'correos: ' + e); }

  var summary = { ok: true, total: plan.length, creados: created, yaExistian: existing, errores: errors,
                  correos: emails, avisos: Object.keys(warnings) };
  log_('automatizacion', 'OK', { total: plan.length, creados: created, errores: errors, correos: emails.sent });
  return summary;
}

function gbCountBy_(rows, field) {
  var out = {};
  rows.forEach(function (r) { out[r[field]] = (out[r[field]] || 0) + 1; });
  return out;
}

/**
 * Punto de entrada del disparador. Es público (los disparadores lo necesitan), así que
 * solo trabaja si lo llama un disparador real del proyecto: comprueba su identificador.
 */
function gbDailyJob(e) {
  var uid = e && e.triggerUid;
  var valid = false;
  try {
    valid = !!uid && ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === uid; });
  } catch (_) {}
  if (!valid) {
    gbWarnOnce_('daily-denied', 'gbDailyJob llamado sin un disparador válido.');
    return;
  }
  return gbRunDailyJob_({});
}


// ============================================================
// ===  Disparadores  =========================================
// ============================================================

function gbTriggersInstalled_() {
  try {
    return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'gbDailyJob'; });
  } catch (_) { return false; }
}

/** Crea (o reemplaza) el disparador diario a la hora de ConfigGym.hora_diaria. */
function gbInstallTriggers_() {
  var hour = Math.max(0, Math.min(23, Math.floor(gbConfigNumber_('hora_diaria', 7))));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'gbDailyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('gbDailyJob').timeBased().everyDays(1).atHour(hour).inTimezone(GB_TZ).create();
  log_('automatizacion', 'OK', { disparador: 'diario ' + hour + ':00' });
  return { ok: true, hora: hour };
}

function gbInstallTriggersApi_() {
  return gbInstallTriggers_();
}


// ============================================================
// ===  Acciones del panel  ===================================
// ============================================================

function gbAutomationStatus_() {
  var review = gbReviewStates_();
  var pending = gbList_('messages', function (m) { return m.Estado === 'Pendiente'; }).length;
  return {
    ok: true,
    activa: gbConfigFlag_('automatizacion_activa'),
    disparador: gbTriggersInstalled_(),
    hora: gbConfigNumber_('hora_diaria', 7),
    emailActivo: gbConfigFlag_('email_activo'),
    asistenciaDesde: gbFmtDate_(gbConfigGet_('asistencia_desde', '')),
    pendientes: pending,
    porRevisar: review.total
  };
}

function gbAutomationSetEnabled_(enabled) {
  var on = enabled === true || enabled === 'SI' || enabled === 'true';
  gbConfigSet_('automatizacion_activa', on ? 'SI' : 'NO');
  if (on && !gbTriggersInstalled_()) gbInstallTriggers_();
  log_('automatizacion', on ? 'ENCENDIDA' : 'APAGADA', { por: gbCtx_().email });
  return gbAutomationStatus_();
}

/** Simulacro (por defecto) o ejecución inmediata del trabajo diario. */
function gbAutomationRunApi_(dryRun) {
  return gbRunDailyJob_({ dryRun: dryRun !== false, force: true });
}

/**
 * Miembros ACTIVOS con la mensualidad vencida o sin pagos, del más atrasado al
 * menos: lista para revisar antes de encender la automatización.
 */
function gbReviewStates_() {
  var options = gbPaymentOptions_();
  var today = gbToday_();
  var lastPay = gbLastPaymentMap_();
  var items = [];
  gbList_('members', function (m) { return m.Estado === 'Activo'; }).forEach(function (m) {
    var status = gbPaymentStatus_(m, lastPay[m.MemberID], today, options);
    if (status.code !== 'vencido' && status.code !== 'sin_pagos') return;
    items.push({
      memberId: String(m.MemberID), nombre: gbFullName_(m), telefono: String(m.Telefono),
      pago: status, ultimoPago: lastPay[m.MemberID] ? gbFmtDate_(lastPay[m.MemberID]) : '',
      registro: gbFmtDate_(m.FechaRegistro)
    });
  });
  items.sort(function (a, b) {
    var ra = a.pago.code === 'vencido' ? 0 : 1, rb = b.pago.code === 'vencido' ? 0 : 1;
    return ra !== rb ? ra - rb : b.pago.daysOverdue - a.pago.daysOverdue;
  });
  return { ok: true, items: items, total: items.length };
}

/** Cambia el estado de varios miembros a la vez (para limpiar la lista). */
function gbMembersBulkStatus_(ids, estado) {
  if (GB_ESTADOS.indexOf(estado) === -1) throw new Error('Estado no válido.');
  if (!Array.isArray(ids) || !ids.length) throw new Error('No hay miembros seleccionados.');
  if (ids.length > 200) throw new Error('Demasiados miembros a la vez.');
  var changed = 0;
  gbWithLock_(function () {
    ids.forEach(function (id) {
      if (gbUpdate_('members', String(id), { Estado: estado })) changed++;
    });
  });
  log_('miembros', 'OK', { estadoMasivo: estado, cambiados: changed, por: gbCtx_().email });
  return { ok: true, cambiados: changed };
}


// ============================================================
// ===  Configuración (lista blanca)  =========================
// ============================================================

/** Claves que el panel puede leer/escribir, con su regla de validación. */
function gbConfigRules_() {
  return {
    nombre_gym: { type: 'text', label: 'Nombre del gimnasio' },
    pais_codigo: { type: 'digits', min: 1, max: 4, label: 'Código de país (WhatsApp)' },
    dias_gracia: { type: 'int', min: 0, max: 30, label: 'Días de gracia después del vencimiento' },
    recordatorio_dias_antes: { type: 'int', min: 0, max: 15, label: 'Avisar de la mensualidad con X días de anticipación' },
    inactividad_dias: { type: 'int', min: 3, max: 90, label: 'Días sin asistir para avisar' },
    medidas_dias: { type: 'int', min: 7, max: 120, label: 'Días entre medidas' },
    ventana_scan_minutos: { type: 'int', min: 5, max: 1440, label: 'Minutos para ignorar un segundo escaneo' },
    hora_diaria: { type: 'int', min: 0, max: 23, label: 'Hora del proceso diario' },
    email_activo: { type: 'flag', label: 'Enviar correos automáticamente' },
    scanner_url: { type: 'url', label: 'Dirección de la página del escáner' }
  };
}

function gbConfigGetApi_() {
  var rules = gbConfigRules_();
  var values = {};
  Object.keys(rules).forEach(function (key) { values[key] = gbConfigGet_(key, ''); });
  return { ok: true, valores: values, reglas: rules };
}

function gbConfigSetApi_(key, value) {
  var rule = gbConfigRules_()[key];
  if (!rule) throw new Error('Ese ajuste no se puede cambiar desde el panel.');
  var v = String(value == null ? '' : value).trim();

  if (rule.type === 'int' || rule.type === 'digits') {
    var n = rule.type === 'digits' ? v : Number(v);
    if (rule.type === 'digits' ? !/^\d+$/.test(v) || v.length < rule.min || v.length > rule.max
                               : !(n >= rule.min && n <= rule.max) || Math.floor(n) !== n) {
      throw new Error(rule.label + ': valor no válido.');
    }
  } else if (rule.type === 'flag') {
    v = /^(si|sí|yes|true|1)$/i.test(v) ? 'SI' : 'NO';
  } else if (rule.type === 'url') {
    if (v && !/^https:\/\/[^\s]+$/.test(v)) throw new Error(rule.label + ': debe empezar con https://');
  } else if (!v) {
    throw new Error(rule.label + ': no puede estar vacío.');
  }

  gbConfigSet_(key, v);
  if (key === 'hora_diaria' && gbTriggersInstalled_()) gbInstallTriggers_();
  return { ok: true, clave: key, valor: v };
}
