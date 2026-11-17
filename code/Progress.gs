/**
 * Progress.gs — Panorama para el administrador y los entrenadores.
 *
 * Reúne en una sola llamada lo que el personal necesita ver cada día:
 *   - a quién hay que atender (mensualidad vencida, sin asistir, medidas pendientes),
 *   - cuánta gente viene (hoy y por semana),
 *   - cómo está la cartera de miembros.
 * No incluye montos de dinero (los entrenadores también lo ven).
 */

/** Gravedad de cada motivo para ordenar la lista (mayor = más urgente). */
function gbAttentionWeights_() {
  return { pago_vencido: 50, sin_pagos: 40, inactividad: 30, por_vencer: 20, medidas: 10 };
}

/** Lunes de la semana de una fecha. */
function gbWeekStart_(value) {
  var d = gbParseDate_(value);
  var day = d.getDay() || 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day - 1), 12);
}

/** Orden de la lista: primero los que están al día y al final los que más deben (peor estado = más abajo). */
function gbPaymentRank_(code) {
  return { al_dia: 0, por_vencer: 1, gracia: 2, vencido: 3, sin_pagos: 4 }[code];
}

/**
 * Días desde la última actividad de un miembro: pago, visita o medidas. Si nunca tuvo ninguna,
 * se cuenta desde su fecha de registro. '' si no hay ninguna fecha.
 */
function gbDaysSinceActivity_(m, lastPay, lastAtt, lastMeas, todayDate) {
  var latest = null;
  [lastPay[m.MemberID], lastAtt[m.MemberID], lastMeas[m.MemberID]].forEach(function (d) {
    if (d && (!latest || d > latest)) latest = d;
  });
  if (!latest) latest = gbParseDate_(m.FechaRegistro);
  return latest ? gbDaysBetween_(latest, todayDate) : '';
}

/** ¿Pasó más tiempo sin actividad que el configurado? (límite 0 = nunca se deja de dar seguimiento) */
function gbIsStale_(days, limit) {
  return limit > 0 && days !== '' && days > limit;
}

function gbLastMeasurementMap_() {
  var map = {};
  gbList_('measurements').forEach(function (x) {
    var d = gbParseDate_(x.Fecha);
    if (d && (!map[x.MemberID] || d > map[x.MemberID])) map[x.MemberID] = d;
  });
  return map;
}

function gbDaysText_(n) {
  return n + (n === 1 ? ' día' : ' días');
}

/**
 * @return {{ok:boolean, hoy:Object, miembros:Object, atencion:Object[], semanas:Object[]}}
 */
function gbProgressOverview_() {
  var today = gbToday_();
  var todayDate = gbParseDate_(today);
  var options = gbPaymentOptions_();
  var inactivityDays = gbConfigNumber_('inactividad_dias', 10);
  var measureDays = gbConfigNumber_('medidas_dias', 30);
  var start = gbAttendanceStart_();
  var weights = gbAttentionWeights_();

  var members = gbList_('members');
  var lastPay = gbLastPaymentMap_();
  var attendance = gbListTail_('attendance', 4000);
  var lastAtt = gbLastAttendanceMap_(attendance);
  var lastMeas = gbLastMeasurementMap_();
  var trackingDays = gbConfigNumber_('seguimiento_dias', 0);
  var hidden = 0;

  var counts = { activos: 0, inactivos: 0, suspendidos: 0, pago: { al_dia: 0, por_vencer: 0, gracia: 0, vencido: 0, sin_pagos: 0 } };
  var attention = [];

  members.forEach(function (m) {
    if (m.Estado === 'Inactivo') { counts.inactivos++; return; }
    if (m.Estado === 'Suspendido') { counts.suspendidos++; return; }
    counts.activos++;

    var status = gbPaymentStatus_(m, lastPay[m.MemberID], today, options);
    counts.pago[status.code]++;

    // Mucho tiempo sin actividad: ya no se les da seguimiento (no aparecen en la lista; se pueden archivar).
    if (gbIsStale_(gbDaysSinceActivity_(m, lastPay, lastAtt, lastMeas, todayDate), trackingDays)) { hidden++; return; }
    var reasons = [];

    if (status.code === 'vencido') reasons.push({ code: 'pago_vencido', texto: 'Mensualidad vencida hace ' + gbDaysText_(status.daysOverdue) });
    else if (status.code === 'sin_pagos') reasons.push({ code: 'sin_pagos', texto: 'Sin pagos registrados' });
    else if (status.code === 'por_vencer') reasons.push({ code: 'por_vencer', texto: status.daysToDue === 0 ? 'Vence hoy' : 'Vence en ' + gbDaysText_(status.daysToDue) });

    var subscribed = gbSubscribedCodes_().indexOf(status.code) !== -1;
    if (subscribed && start) {
      var reference = lastAtt[m.MemberID] && lastAtt[m.MemberID] > start ? lastAtt[m.MemberID] : start;
      var registered = gbParseDate_(m.FechaRegistro);
      if (registered && registered > reference) reference = registered;
      var days = gbDaysBetween_(reference, todayDate);
      if (days >= inactivityDays) reasons.push({ code: 'inactividad', texto: gbDaysText_(days) + ' sin asistir' });
    }
    if (lastMeas[m.MemberID]) {
      var since = gbDaysBetween_(lastMeas[m.MemberID], todayDate);
      if (since >= measureDays) reasons.push({ code: 'medidas', texto: 'Medidas hace ' + gbDaysText_(since) });
    }

    if (reasons.length) {
      var score = 0;
      reasons.forEach(function (r) { score = Math.max(score, weights[r.code]); });
      attention.push({
        memberId: String(m.MemberID), nombre: gbFullName_(m), telefono: String(m.Telefono),
        pago: { code: status.code, label: status.label }, motivos: reasons, prioridad: score
      });
    }
  });
  // Primero los que están al día, al final los de peor estado; dentro de cada grupo, lo más urgente y luego por nombre.
  attention.sort(function (a, b) {
    return gbPaymentRank_(a.pago.code) - gbPaymentRank_(b.pago.code) || b.prioridad - a.prioridad || a.nombre.localeCompare(b.nombre, 'es');
  });

  // Asistencia por semana (últimas 8, la más reciente al final).
  var thisMonday = gbWeekStart_(today);
  var weeks = [];
  for (var i = 7; i >= 0; i--) {
    var from = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * i, 12);
    weeks.push({ desde: gbFmtDate_(from), from: from, visitas: 0, personas: {} });
  }
  attendance.forEach(function (a) {
    var d = gbParseDate_(a.Fecha);
    if (!d) return;
    var diff = gbDaysBetween_(weeks[0].from, d);
    if (diff < 0) return;
    var index = Math.floor(diff / 7);
    if (index >= weeks.length) return;
    weeks[index].visitas++;
    weeks[index].personas[a.MemberID] = true;
  });

  var todayRows = attendance.filter(function (a) { return gbFmtDate_(a.Fecha) === today; });
  var todayPeople = {};
  todayRows.forEach(function (a) { todayPeople[a.MemberID] = true; });

  return {
    ok: true,
    hoy: { fecha: today, visitas: todayRows.length, personas: Object.keys(todayPeople).length },
    miembros: counts,
    atencion: attention.slice(0, 100),
    totalAtencion: attention.length,
    sinSeguimiento: { cantidad: hidden, dias: trackingDays },
    semanas: weeks.map(function (w) { return { desde: w.desde, visitas: w.visitas, personas: Object.keys(w.personas).length }; }),
    controlAsistencia: !!start
  };
}


/**
 * Archiva (marca Inactivo) a los miembros que pasaron más de "seguimiento_dias" sin actividad.
 * No borra nada: si vuelven y pagan, el sistema los reactiva solo. Solo Admin.
 */
function gbArchiveStale_() {
  var limit = gbConfigNumber_('seguimiento_dias', 0);
  if (!(limit > 0)) return { ok: false, message: 'Primero indica los días de seguimiento en Ajustes.' };
  return gbWithLock_(function () {
    var todayDate = gbParseDate_(gbToday_());
    var lastPay = gbLastPaymentMap_(), lastAtt = gbLastAttendanceMap_(), lastMeas = gbLastMeasurementMap_();
    var changed = 0;
    gbList_('members', function (m) { return m.Estado === 'Activo'; }).forEach(function (m) {
      if (gbIsStale_(gbDaysSinceActivity_(m, lastPay, lastAtt, lastMeas, todayDate), limit)) {
        gbUpdate_('members', m.MemberID, { Estado: 'Inactivo' });
        changed++;
      }
    });
    log_('miembros', 'INFO', 'Archivados por ' + limit + ' días sin actividad: ' + changed);
    return { ok: true, cambiados: changed, dias: limit };
  });
}
