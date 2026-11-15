/**
 * Attendance.gs — Control de asistencia con QR (tablet) y registro manual.
 *
 * Flujo del tablet:
 *   1. Un Admin crea un CÓDIGO DE EMPAREJAMIENTO (válido 15 min) en el panel.
 *   2. En el tablet se abre la página del escáner, se escribe el código y el servidor
 *      entrega un TOKEN DE DISPOSITIVO (se guarda solo su hash). Desde ese momento
 *      solo ese tablet puede registrar asistencia; el Admin puede revocarlo.
 *   3. Cada escaneo llega a `doPost` (Code.gs → gbScanApi_) con { device, code }.
 *      El QR del miembro NO contiene su DPI: es "GB1:" + un token aleatorio.
 *
 * El endpoint es público (es un Web App), por eso: todo exige token de dispositivo,
 * hay límites de intentos, y la respuesta solo incluye nombre de pila y estado.
 */

// ============================================================
// ===  QR y utilidades  ======================================
// ============================================================

/** Texto que va dentro del QR del miembro. */
function gbQrText_(token) {
  return 'GB1:' + token;
}

/** Extrae el token de un texto de QR ('' si no tiene el formato esperado). */
function gbParseQr_(text) {
  var m = String(text == null ? '' : text).trim().match(/^GB1:([0-9a-fA-F]{24})$/);
  return m ? m[1].toLowerCase() : '';
}

/** Suma 1 a un contador en caché (ventana deslizante) y devuelve el total. */
function gbCounter_(key, windowSec) {
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get(key) || '0', 10) + 1;
  cache.put(key, String(n), windowSec);
  return n;
}

function gbCounterPeek_(key) {
  return parseInt(CacheService.getScriptCache().get(key) || '0', 10);
}

/** Fecha desde la que se controla la asistencia ('' = todavía no se usa). */
function gbAttendanceStart_() {
  return gbParseDate_(gbConfigGet_('asistencia_desde', ''));
}

/** Última visita por miembro: { MemberID: Date }. */
function gbLastAttendanceMap_(rows) {
  var map = {};
  (rows || gbList_('attendance')).forEach(function (a) {
    var d = gbParseDate_(a.FechaHora) || gbParseDate_(a.Fecha);
    if (d && (!map[a.MemberID] || d > map[a.MemberID])) map[a.MemberID] = d;
  });
  return map;
}

function gbHourText_(value) {
  var d = gbParseDate_(value);
  return d ? Utilities.formatDate(d, GB_TZ, 'HH:mm') : '';
}

function gbAttendanceView_(a, names) {
  return {
    asistenciaId: String(a.AsistenciaID), memberId: String(a.MemberID),
    nombre: (names && names[a.MemberID]) || '', fecha: gbFmtDate_(a.Fecha),
    hora: gbHourText_(a.FechaHora), origen: String(a.Origen),
    dispositivo: String(a.DispositivoID || ''), estado: String(a.EstadoAlMomento || '')
  };
}


// ============================================================
// ===  Registrar asistencia  =================================
// ============================================================

/**
 * Registra una visita. Si ya hubo una dentro de la ventana (ventana_scan_minutos)
 * no la duplica y devuelve status 'duplicado'.
 *
 * @return {{status:string, record:Object|null, pago:Object, at?:Date}}
 */
function gbAttendanceRecord_(member, origin, deviceId, force) {
  return gbWithLock_(function () {
    var windowMinutes = gbConfigNumber_('ventana_scan_minutos', 240);
    var now = new Date();

    var recent = gbListTail_('attendance', 400, function (a) { return a.MemberID === member.MemberID; });
    var latest = null;
    recent.forEach(function (a) {
      var d = gbParseDate_(a.FechaHora);
      if (d && (!latest || d > latest)) latest = d;
    });

    var last = gbLastPaymentMap_()[member.MemberID];
    var pago = gbPaymentStatus_(member, last, gbToday_(), gbPaymentOptions_());

    if (latest && !force && (now.getTime() - latest.getTime()) / 60000 < windowMinutes) {
      return { status: 'duplicado', record: null, pago: pago, at: latest };
    }

    var saved = gbAppend_('attendance', {
      MemberID: member.MemberID, FechaHora: now, Fecha: gbParseDate_(gbToday_()),
      Origen: origin, DispositivoID: deviceId || '', EstadoAlMomento: pago.code
    });
    // Primer registro real: desde hoy se puede medir la inactividad.
    if (!gbAttendanceStart_()) gbConfigSet_('asistencia_desde', gbToday_());
    return { status: 'ok', record: saved, pago: pago };
  });
}

/** Acción del panel: registrar la asistencia de un miembro a mano. */
function gbAttendanceManual_(memberId, force) {
  var member = gbMemberOrThrow_(memberId);
  var result = gbAttendanceRecord_(member, 'Manual', '', !!force);
  return {
    ok: true, status: result.status, nombre: gbFullName_(member),
    pago: result.pago, hora: result.record ? gbHourText_(result.record.FechaHora) : gbHourText_(result.at)
  };
}

/** Asistencia de hoy (más reciente primero). */
function gbAttendanceToday_() {
  var today = gbToday_();
  var names = {};
  gbList_('members').forEach(function (m) { names[m.MemberID] = gbFullName_(m); });
  var rows = gbListTail_('attendance', 600, function (a) { return gbFmtDate_(a.Fecha) === today; });
  rows.sort(function (a, b) { return gbParseDate_(b.FechaHora) - gbParseDate_(a.FechaHora); });
  var unique = {};
  rows.forEach(function (a) { unique[a.MemberID] = true; });
  return { ok: true, fecha: today, total: rows.length, personas: Object.keys(unique).length,
           items: rows.map(function (a) { return gbAttendanceView_(a, names); }) };
}

/** Historial de un miembro (últimos `days` días, por defecto 90). */
function gbAttendanceHistory_(memberId, days) {
  var m = gbMemberOrThrow_(memberId);
  var limit = Number(days) > 0 ? Number(days) : 90;
  var today = gbParseDate_(gbToday_());
  var rows = gbList_('attendance', function (a) {
    var d = gbParseDate_(a.Fecha);
    return a.MemberID === m.MemberID && d && gbDaysBetween_(d, today) <= limit;
  });
  rows = gbSortDesc_(rows, 'FechaHora');
  return { ok: true, items: rows.map(function (a) { return gbAttendanceView_(a); }), total: rows.length };
}

/** Define desde qué día se mide la asistencia ('' para apagar). */
function gbAttendanceSetStart_(dateText) {
  var d = String(dateText || '').trim();
  if (d && !gbParseDate_(d)) throw new Error('Fecha no válida.');
  gbConfigSet_('asistencia_desde', d ? gbFmtDate_(d) : '');
  return { ok: true, desde: d ? gbFmtDate_(d) : '' };
}


// ============================================================
// ===  Dispositivos (tablets autorizados)  ===================
// ============================================================

function gbDeviceView_(d) {
  return { id: String(d.DispositivoID), nombre: String(d.Nombre), activo: String(d.Activo) === 'Si',
           creadoEn: gbFmtDateTime_(d.CreadoEn), ultimoUso: gbFmtDateTime_(d.UltimoUso) };
}

function gbDevicesList_() {
  return { ok: true, items: gbList_('devices').map(gbDeviceView_),
           scannerUrl: gbConfigGet_('scanner_url', '') };
}

/** Código corto y legible (sin 0/O/1/I) para emparejar un tablet. */
function gbRandomCode_(length) {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var out = '';
  for (var i = 0; i < length; i++) out += alphabet.charAt(parseInt(raw.substr(i * 2, 2), 16) % alphabet.length);
  return out;
}

/** Crea un código de emparejamiento válido 15 minutos. */
function gbDevicePairingCreate_(name) {
  var clean = String(name || '').replace(/\s+/g, ' ').trim().substring(0, 40);
  if (!clean) throw new Error('Ponle un nombre al tablet (por ejemplo "Recepción").');
  var code = gbRandomCode_(8);
  CacheService.getScriptCache().put('GB_PAIR_' + gbHash_(code).substring(0, 32),
    JSON.stringify({ name: clean, by: gbCtx_().email }), 900);
  return { ok: true, code: code.substring(0, 4) + '-' + code.substring(4), minutos: 15,
           scannerUrl: gbConfigGet_('scanner_url', '') };
}

function gbDeviceRevoke_(deviceId) {
  var d = gbFind_('devices', 'DispositivoID', deviceId);
  if (!d) throw new Error('No se encontró el dispositivo.');
  gbUpdate_('devices', d.DispositivoID, { Activo: 'No' });
  log_('dispositivos', 'REVOCADO', { id: d.DispositivoID, por: gbCtx_().email });
  return { ok: true };
}

/** Canjea un código de emparejamiento por el token del dispositivo (se muestra una sola vez). */
function gbPairDevice_(p) {
  if (gbCounterPeek_('GB_PAIRFAIL') >= 10) {
    return { ok: false, status: 'limite', error: 'Demasiados intentos. Espera unos minutos.' };
  }
  var code = String(p.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var cache = CacheService.getScriptCache();
  var key = 'GB_PAIR_' + gbHash_(code).substring(0, 32);
  var raw = code.length === 8 ? cache.get(key) : null;
  if (!raw) {
    gbCounter_('GB_PAIRFAIL', 600);
    return { ok: false, status: 'codigo_invalido', error: 'Código no válido o vencido.' };
  }
  cache.remove(key);

  var info = JSON.parse(raw);
  var token = gbToken_(40);
  var saved = gbAppend_('devices', { Nombre: info.name, TokenHash: gbHash_(token), Activo: 'Si', CreadoEn: new Date() });
  log_('dispositivos', 'OK', { alta: saved.DispositivoID, nombre: info.name, por: info.by });
  return { ok: true, device: token, nombre: info.name, id: saved.DispositivoID };
}

/** Dispositivo activo que corresponde a un token (o null). */
function gbAuthDevice_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{40}$/.test(token)) return null;
  var hash = gbHash_(token);
  var found = gbList_('devices', function (d) { return d.TokenHash === hash && String(d.Activo) === 'Si'; })[0];
  return found || null;
}


// ============================================================
// ===  Endpoint del tablet (doPost)  =========================
// ============================================================

/**
 * Punto de entrada del escáner. Acciones: ping, pair, scan.
 * Todo error se devuelve como JSON; nunca se lanza al cliente.
 */
function gbScanApi_(p) {
  try {
    p = p || {};
    var action = String(p.action || '');
    if (action === 'pair') return gbPairDevice_(p);
    if (action === 'scan') return gbScan_(p);
    if (action === 'ping') {
      var device = gbAuthDevice_(p.device);
      return device ? { ok: true, nombre: String(device.Nombre) } : { ok: false, status: 'no_autorizado', error: 'Dispositivo no autorizado.' };
    }
    return { ok: false, error: 'Acción no válida.' };
  } catch (e) {
    log_('asistencia', 'ERROR', String(e && e.message || e).substring(0, 200));
    return { ok: false, status: 'error', error: 'No se pudo registrar. Intenta de nuevo.' };
  }
}

function gbScan_(p) {
  if (gbCounterPeek_('GB_BADDEVICE') >= 30) {
    return { ok: false, status: 'limite', error: 'Demasiados intentos. Espera unos minutos.' };
  }
  var device = gbAuthDevice_(p.device);
  if (!device) {
    gbCounter_('GB_BADDEVICE', 600);
    return { ok: false, status: 'no_autorizado', error: 'Dispositivo no autorizado.' };
  }
  if (gbCounter_('GB_SCAN_' + device.DispositivoID, 3600) > 400) {
    return { ok: false, status: 'limite', error: 'Demasiados escaneos en una hora.' };
  }

  var token = gbParseQr_(p.code);
  var member = token ? gbFind_('members', 'TokenQR', token) : null;
  if (!member) return { ok: true, status: 'desconocido', mensaje: 'Código no reconocido.' };

  var firstName = String(member.Nombres || '').split(' ')[0];
  if (member.Estado !== 'Activo') {
    return { ok: true, status: 'sin_membresia', nombre: firstName, mensaje: 'Consulta en recepción.' };
  }

  var result = gbAttendanceRecord_(member, 'QR', device.DispositivoID, false);
  gbUpdate_('devices', device.DispositivoID, { UltimoUso: new Date() });
  return {
    ok: true, status: result.status, nombre: firstName,
    pago: { code: result.pago.code, label: result.pago.label },
    hora: gbHourText_(result.record ? result.record.FechaHora : result.at)
  };
}
