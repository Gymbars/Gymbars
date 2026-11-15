/**
 * Messaging.gs — Mensajes a los miembros: boletas, reportes, recordatorios, etc.
 *
 * Cómo funciona (sin costo):
 *   1. Cada mensaje se deja en la bandeja "Mensajes" (pestaña Mensajes) con su
 *      texto ya armado. Hay una fila por canal: WhatsApp y, si el miembro tiene
 *      correo, Email.
 *   2. WhatsApp: la persona del gimnasio toca el enlace wa.me del mensaje (se abre
 *      el chat con el texto listo) y lo marca como enviado. No se necesita API de pago.
 *   3. Email: se envía solo con MailApp (cuota diaria de Google).
 *
 * wa.me no permite adjuntar archivos, por eso los reportes se comparten como ENLACES
 * (boleta de pago, reporte de medidas, evaluación y carnet con QR).
 *
 * Los mensajes se crean aquí; quién los crea automáticamente (recordatorios,
 * inactividad…) es Triggers.gs.
 */

/** Tipos de mensaje que el personal puede crear a mano. */
function gbManualMessageTypes_() {
  return ['boleta', 'medidas', 'evaluacion', 'carnet', 'recordatorio_pago', 'pago_vencido', 'inactividad', 'progreso'];
}


// ============================================================
// ===  Enlaces públicos (boleta, reportes, carnet)  ==========
// ============================================================

/** URL base del Web App (…/exec). Se puede fijar en Script Properties: GB_REPORT_BASE_URL. */
function gbBaseUrl_() {
  var prop = PropertiesService.getScriptProperties().getProperty('GB_REPORT_BASE_URL');
  if (prop) return String(prop).replace(/[?#].*$/, '');
  try {
    var url = ScriptApp.getService().getUrl();
    if (url) return String(url).replace(/\/u\/\d+/, '');
  } catch (_) {}
  return '';
}

/** Secreto para firmar enlaces de reportes (se crea una vez y se guarda). */
function gbLinkSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('GB_LINK_SECRET');
  if (!secret) {
    secret = gbToken_(64);
    props.setProperty('GB_LINK_SECRET', secret);
  }
  return secret;
}

/** Firma HMAC-SHA256 (32 caracteres hex) de un texto. */
function gbSign_(text) {
  return gbHex_(Utilities.computeHmacSha256Signature(String(text), gbLinkSecret_())).substring(0, 32);
}

/** Enlace firmado a un reporte (medidas | evaluacion) de un miembro hasta cierto registro. */
function gbReportLink_(type, memberId, recordId) {
  var base = gbBaseUrl_();
  if (!base) return '';
  return base + '?reporte=' + encodeURIComponent(type) + '&m=' + encodeURIComponent(memberId) +
    '&r=' + encodeURIComponent(recordId) + '&s=' + gbSign_(type + '|' + memberId + '|' + recordId);
}

function gbVerifyReportLink_(type, memberId, recordId, signature) {
  if (!type || !memberId || !recordId || !signature) return false;
  return gbSafeEquals_(gbSign_(type + '|' + memberId + '|' + recordId), signature);
}

function gbVoucherLink_(payment) {
  var base = gbBaseUrl_();
  return base && payment.ComprobanteToken ? base + '?comprobante=' + encodeURIComponent(payment.ComprobanteToken) : '';
}

function gbCarnetLink_(member) {
  var base = gbBaseUrl_();
  return base && member.TokenQR ? base + '?carnet=' + encodeURIComponent(member.TokenQR) : '';
}


// ============================================================
// ===  Plantillas  ===========================================
// ============================================================

function gbTemplateFor_(type, channel) {
  var rows = [];
  try { rows = gbList_('templates'); } catch (_) {}
  var found = rows.filter(function (r) { return r.Tipo === type && r.Canal === channel; })[0];
  if (found && String(found.Texto).trim()) return { asunto: String(found.Asunto || ''), texto: String(found.Texto) };
  var seed = gbTemplateSeed_().filter(function (r) { return r[0] === type && r[1] === channel; })[0];
  return seed ? { asunto: seed[2], texto: seed[3] } : null;
}

/** Fecha para personas: dd/mm/aaaa. */
function gbHumanDate_(value) {
  var d = gbParseDate_(value);
  return d ? Utilities.formatDate(d, GB_TZ, 'dd/MM/yyyy') : '';
}

/** Número de semana ISO (aaaa-Wnn) para no repetir un aviso en la misma semana. */
function gbWeekKey_(value) {
  var d = gbParseDate_(value || gbToday_());
  var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  var week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + (week < 10 ? '0' + week : week);
}


// ============================================================
// ===  Crear mensajes (bandeja)  =============================
// ============================================================

function gbMessageView_(msg, memberNames) {
  var channel = String(msg.Canal);
  return {
    mensajeId: String(msg.MensajeID),
    memberId: String(msg.MemberID),
    nombre: (memberNames && memberNames[msg.MemberID]) || '',
    tipo: String(msg.Tipo),
    canal: channel,
    para: String(msg.Para),
    asunto: String(msg.Asunto || ''),
    texto: String(msg.Texto || ''),
    enlace: String(msg.EnlaceReporte || ''),
    estado: String(msg.Estado),
    creadoEn: gbFmtDateTime_(msg.CreadoEn),
    enviadoPor: String(msg.EnviadoPor || ''),
    enviadoEn: gbFmtDateTime_(msg.EnviadoEn),
    waUrl: channel === 'WhatsApp' ? gbWaLink_(msg.Para, msg.Texto) : ''
  };
}

/** Días desde su última visita (o desde que se registró). '' si no hay datos. */
function gbInactivityDays_(member) {
  var rows = gbListTail_('attendance', 2000, function (a) { return a.MemberID === member.MemberID; });
  var last = gbLastAttendanceMap_(rows)[member.MemberID] || gbParseDate_(member.FechaRegistro);
  return last ? gbDaysBetween_(last, gbParseDate_(gbToday_())) : '';
}

/**
 * Arma el contexto (enlace, variables y clave de no-repetición) de un tipo de mensaje.
 * @return {{ref:string, link:string, vars:Object}}
 */
function gbMessageContext_(req, member) {
  var today = gbToday_();
  var vars = {
    nombre: String(member.Nombres || '').split(' ')[0],
    gym: gbConfigGet_('nombre_gym', 'Gymbars'),
    monto: Number(member.Mensualidad) || '',
    fecha: gbHumanDate_(today),
    proximoPago: '', enlace: '', dias: ''
  };
  var extra = req.extra || {};
  var type = req.type;
  var link = '', ref = today;

  if (type === 'boleta') {
    var payment = req.paymentId
      ? gbFind_('payments', 'PagoID', req.paymentId)
      : gbSortDesc_(gbList_('payments', function (p) { return p.MemberID === member.MemberID; }), 'Fecha')[0];
    if (!payment) throw new Error('El miembro no tiene pagos registrados.');
    ref = payment.PagoID;
    link = gbVoucherLink_(payment);
    vars.fecha = gbHumanDate_(payment.Fecha);
    vars.monto = Number(payment.Monto);
    vars.proximoPago = gbHumanDate_(gbNextPaymentDate_(payment.Fecha, member.DiaPago));
  } else if (type === 'medidas') {
    var meas = req.measurementId
      ? gbFind_('measurements', 'MedidaID', req.measurementId)
      : gbSortDesc_(gbList_('measurements', function (x) { return x.MemberID === member.MemberID; }), 'Fecha')[0];
    if (!meas) throw new Error('El miembro no tiene medidas registradas.');
    ref = meas.MedidaID;
    link = gbReportLink_('medidas', member.MemberID, meas.MedidaID);
  } else if (type === 'evaluacion') {
    var ev = req.evalId
      ? gbFind_('evaluations', 'EvalID', req.evalId)
      : gbSortDesc_(gbList_('evaluations', function (x) { return x.MemberID === member.MemberID; }), 'Fecha')[0];
    if (!ev) throw new Error('El miembro no tiene evaluaciones registradas.');
    ref = ev.EvalID;
    link = gbReportLink_('evaluacion', member.MemberID, ev.EvalID);
  } else if (type === 'carnet') {
    link = gbCarnetLink_(member);
    ref = 'carnet';
  } else if (type === 'recordatorio_pago' || type === 'pago_vencido') {
    var last = gbLastPaymentMap_()[member.MemberID];
    var status = gbPaymentStatus_(member, last, today, gbPaymentOptions_());
    vars.proximoPago = gbHumanDate_(status.nextDue);
    ref = status.nextDue || today;
  } else if (type === 'inactividad') {
    vars.dias = extra.dias || gbInactivityDays_(member) || 'varios';
    ref = gbWeekKey_(today);
  } else if (type === 'progreso') {
    var lastMeas = gbSortDesc_(gbList_('measurements', function (x) { return x.MemberID === member.MemberID; }), 'Fecha')[0];
    link = lastMeas ? gbReportLink_('medidas', member.MemberID, lastMeas.MedidaID) : '';
    ref = today.substring(0, 7);
  } else {
    throw new Error('Tipo de mensaje no válido: ' + String(type).substring(0, 30));
  }

  vars.enlace = link;
  return { ref: String(ref), link: link, vars: vars };
}

/**
 * Deja un mensaje en la bandeja (uno por canal disponible).
 *
 * @param {{type:string, memberId:string, paymentId?:string, measurementId?:string, evalId?:string,
 *          extra?:Object, force?:boolean}} req
 *   force: crear aunque ya exista uno igual (reenviar un reporte).
 * @return {{ok:boolean, whatsapp:Object|null, email:Object|null, existing:number, warnings:string[]}}
 */
function gbQueueMessage_(req) {
  req = req || {};
  return gbWithLock_(function () {
    var member = gbMemberOrThrow_(req.memberId);
    var context = gbMessageContext_(req, member);
    var warnings = [];
    var out = { ok: true, whatsapp: null, email: null, existing: 0, warnings: warnings };
    var names = {}; names[member.MemberID] = gbFullName_(member);

    ['WhatsApp', 'Email'].forEach(function (channel) {
      var to = '';
      if (channel === 'WhatsApp') {
        to = gbWaPhone_(member.Telefono, gbConfigGet_('pais_codigo', GB_DEFAULT_COUNTRY_CODE));
        if (!to) { warnings.push('El teléfono de ' + gbFullName_(member) + ' no es válido para WhatsApp.'); return; }
      } else {
        if (!gbConfigFlag_('email_activo') || !gbIsEmail_(member.Correo)) return;
        to = String(member.Correo).trim().toLowerCase();
      }

      var template = gbTemplateFor_(req.type, channel);
      if (!template) { if (channel === 'WhatsApp') warnings.push('No hay plantilla para ' + req.type + '.'); return; }
      if ((req.type === 'medidas' || req.type === 'evaluacion' || req.type === 'boleta' || req.type === 'carnet') && !context.link) {
        warnings.push('Falta la URL pública del sitio para armar el enlace (Script Properties: GB_REPORT_BASE_URL).');
      }

      var key = [req.type, member.MemberID, context.ref, channel].join('|');
      if (req.force) key += '|' + Date.now();
      var duplicate = gbList_('messages', function (m) { return m.ClaveDedup === key && m.Estado !== 'Descartado'; })[0];
      if (duplicate) { out.existing++; out[channel === 'WhatsApp' ? 'whatsapp' : 'email'] = gbMessageView_(duplicate, names); return; }

      var saved = gbAppend_('messages', {
        MemberID: member.MemberID, Tipo: req.type, Canal: channel, Para: to,
        Asunto: gbRenderTemplate_(template.asunto, context.vars),
        Texto: gbRenderTemplate_(template.texto, context.vars),
        EnlaceReporte: context.link, Estado: 'Pendiente', CreadoEn: new Date(), ClaveDedup: key
      });
      out[channel === 'WhatsApp' ? 'whatsapp' : 'email'] = gbMessageView_(saved, names);
    });

    if (!out.whatsapp && !out.email && !out.existing) out.ok = false;
    return out;
  });
}

/** Acción del panel: crea un mensaje a mano (reenviar boleta, reporte, carnet…). */
function gbMessageQueueApi_(req) {
  req = req || {};
  if (gbManualMessageTypes_().indexOf(req.type) === -1) throw new Error('Tipo de mensaje no válido.');
  var request = { type: req.type, memberId: req.memberId, paymentId: req.paymentId,
                  measurementId: req.measurementId, evalId: req.evalId, force: !!req.force };
  var result = gbQueueMessage_(request);
  // El correo no necesita que nadie lo toque: sale solo.
  if (result.email && result.email.estado === 'Pendiente') {
    try { gbSendPendingEmails_(3); } catch (e) { log_('mensajes', 'ERROR', 'envío de correo: ' + e); }
  }
  return result;
}


// ============================================================
// ===  Bandeja: listar, marcar, descartar  ===================
// ============================================================

/**
 * @param {{estado?:string, tipo?:string, canal?:string, memberId?:string, limit?:number}} [filters]
 *   estado por defecto: Pendiente.
 */
function gbMessagesList_(filters) {
  filters = filters || {};
  var estado = filters.estado === undefined ? 'Pendiente' : filters.estado;
  var names = {};
  gbList_('members').forEach(function (m) { names[m.MemberID] = gbFullName_(m); });

  var all = gbList_('messages');
  var counts = { Pendiente: 0, Enviado: 0, Descartado: 0, Error: 0 };
  all.forEach(function (m) { if (counts[m.Estado] !== undefined) counts[m.Estado]++; });

  var rows = all.filter(function (m) {
    return (!estado || m.Estado === estado) && (!filters.tipo || m.Tipo === filters.tipo) &&
           (!filters.canal || m.Canal === filters.canal) && (!filters.memberId || m.MemberID === filters.memberId);
  });
  rows = gbSortDesc_(rows, 'CreadoEn');
  var limit = Math.min(Number(filters.limit) || 200, 500);
  return {
    items: rows.slice(0, limit).map(function (m) { return gbMessageView_(m, names); }),
    total: rows.length,
    counts: counts
  };
}

function gbMessageMarkSent_(mensajeId) {
  var msg = gbFind_('messages', 'MensajeID', mensajeId);
  if (!msg) throw new Error('No se encontró el mensaje.');
  var updated = gbUpdate_('messages', msg.MensajeID,
    { Estado: 'Enviado', EnviadoPor: gbCtx_().email, EnviadoEn: new Date() });
  return { ok: true, mensaje: gbMessageView_(updated) };
}

function gbMessageDiscard_(mensajeId) {
  var msg = gbFind_('messages', 'MensajeID', mensajeId);
  if (!msg) throw new Error('No se encontró el mensaje.');
  var updated = gbUpdate_('messages', msg.MensajeID, { Estado: 'Descartado' });
  return { ok: true, mensaje: gbMessageView_(updated) };
}


// ============================================================
// ===  Email  ================================================
// ============================================================

/** Envía UN correo pendiente. @return {{ok:boolean, error?:string}} */
function gbSendEmailMessage_(msg) {
  try {
    MailApp.sendEmail({
      to: msg.Para,
      subject: String(msg.Asunto || gbConfigGet_('nombre_gym', 'Gymbars')),
      body: String(msg.Texto || ''),
      name: gbConfigGet_('nombre_gym', 'Gymbars')
    });
    gbUpdate_('messages', msg.MensajeID, { Estado: 'Enviado', EnviadoPor: 'automático', EnviadoEn: new Date() });
    return { ok: true };
  } catch (e) {
    gbUpdate_('messages', msg.MensajeID, { Estado: 'Error' });
    log_('mensajes', 'ERROR', { correo: msg.MensajeID, error: String(e.message || e).substring(0, 200) });
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Envía los correos pendientes respetando la cuota diaria de Google.
 * @param {number} [limit] Máximo por llamada.
 * @return {{sent:number, errors:number, pending:number, quota:number}}
 */
function gbSendPendingEmails_(limit) {
  if (!gbConfigFlag_('email_activo')) return { sent: 0, errors: 0, pending: 0, quota: 0, disabled: true };
  var quota = MailApp.getRemainingDailyQuota();
  var pending = gbList_('messages', function (m) { return m.Canal === 'Email' && m.Estado === 'Pendiente'; });
  var batch = pending.slice(0, Math.max(0, Math.min(Number(limit) || 20, quota)));
  var sent = 0, errors = 0;
  batch.forEach(function (msg) {
    if (gbSendEmailMessage_(msg).ok) sent++; else errors++;
  });
  return { sent: sent, errors: errors, pending: pending.length - sent, quota: quota - sent };
}

/** Reintenta manualmente los correos con error. */
function gbMessageRetryEmail_(mensajeId) {
  var msg = gbFind_('messages', 'MensajeID', mensajeId);
  if (!msg || msg.Canal !== 'Email') throw new Error('No se encontró el correo.');
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Se alcanzó la cuota diaria de correos de Google.');
  var result = gbSendEmailMessage_(msg);
  return { ok: result.ok, error: result.error || '' };
}


// ============================================================
// ===  Plantillas (edición)  =================================
// ============================================================

function gbTemplatesList_() {
  var rows = gbList_('templates');
  var byKey = {};
  rows.forEach(function (r) { byKey[r.Tipo + '|' + r.Canal] = r; });
  // Incluye las que falten (por si borraron filas) desde las iniciales.
  var out = [];
  var seen = {};
  rows.concat(gbTemplateSeed_().map(function (r) { return { Tipo: r[0], Canal: r[1], Asunto: r[2], Texto: r[3] }; }))
    .forEach(function (r) {
      var key = r.Tipo + '|' + r.Canal;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ tipo: String(r.Tipo), canal: String(r.Canal), asunto: String(r.Asunto || ''), texto: String(r.Texto || '') });
    });
  return { ok: true, items: out, variables: ['{nombre}', '{gym}', '{fecha}', '{monto}', '{proximoPago}', '{enlace}', '{dias}'] };
}

/** Guarda (o crea) la plantilla de un tipo y canal. */
function gbTemplateSave_(input) {
  input = input || {};
  var type = String(input.tipo || '').trim();
  var channel = String(input.canal || '').trim();
  if (!type || ['WhatsApp', 'Email'].indexOf(channel) === -1) throw new Error('Tipo o canal no válido.');
  var text = String(input.texto || '').trim();
  if (!text) throw new Error('El texto no puede estar vacío.');

  return gbWithLock_(function () {
    var sheet = gbSheet_('templates');
    var spec = gbSpec_('templates');
    var map = gbHeaderMap_(sheet, spec);
    var existing = gbList_('templates', function (r) { return r.Tipo === type && r.Canal === channel; })[0];
    var row = existing ? existing._row : Math.max(sheet.getLastRow(), 1) + 1;
    gbEnsureRows_(sheet, spec, row);
    var width = Math.max(sheet.getLastColumn(), spec.headers.length);
    sheet.getRange(row, 1, 1, width).setValues([gbRowArray_(spec, map, width,
      { Tipo: type, Canal: channel, Asunto: String(input.asunto || '').trim(), Texto: text })]);
    return { ok: true, tipo: type, canal: channel };
  });
}
