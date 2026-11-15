/**
 * Members.gs — Miembros: búsqueda, ficha, alta/edición, estado y baja.
 *
 * Reemplaza las macros BUSCAR / GYMBARS del Excel (LoadUserList, SaveUserData,
 * EditUser, DeleteUser). Las usa tanto el panel web como la barra lateral de la
 * hoja de cálculo.
 *
 * Privacidad: el DPI completo solo lo ve un Admin; el resto ve los últimos 4 dígitos.
 */

var GB_ESTADOS = ['Activo', 'Inactivo', 'Suspendido'];
var GB_GENEROS = ['Masculino', 'Femenino'];

function gbIsAdmin_() {
  return gbCtx_().role === GB_ROLES.ADMIN;
}

/** Opciones de estado de pago desde ConfigGym. */
function gbPaymentOptions_() {
  return {
    antes: gbConfigNumber_('recordatorio_dias_antes', 3),
    gracia: gbConfigNumber_('dias_gracia', 3)
  };
}

/** Mapa MemberID → fecha del último pago. */
function gbLastPaymentMap_(payments) {
  var map = {};
  (payments || gbList_('payments')).forEach(function (p) {
    var d = gbParseDate_(p.Fecha);
    if (!d) return;
    if (!map[p.MemberID] || d > map[p.MemberID]) map[p.MemberID] = d;
  });
  return map;
}

/** Datos de un miembro listos para el navegador (sin token QR). */
function gbMemberView_(m) {
  var full = gbIsAdmin_();
  return {
    memberId: String(m.MemberID),
    dpi: full ? String(m.DPI) : '',
    dpiMasked: gbMaskDpi_(m.DPI),
    nombres: String(m.Nombres),
    apellidos: String(m.Apellidos),
    nombre: gbFullName_(m),
    fechaNacimiento: gbFmtDate_(m.FechaNacimiento),
    edad: gbAge_(m.FechaNacimiento, gbToday_()),
    telefono: String(m.Telefono),
    telefonoWa: gbWaPhone_(m.Telefono, gbConfigGet_('pais_codigo', GB_DEFAULT_COUNTRY_CODE)),
    correo: String(m.Correo || ''),
    genero: String(m.Genero),
    mensualidad: Number(m.Mensualidad) || 0,
    diaPago: m.DiaPago === '' || m.DiaPago == null ? '' : Number(m.DiaPago),
    estado: String(m.Estado),
    fechaRegistro: gbFmtDate_(m.FechaRegistro),
    notas: String(m.Notas || '')
  };
}

function gbMemberOrThrow_(memberId) {
  var m = gbFind_('members', 'MemberID', memberId);
  if (!m) throw new Error('No se encontró el miembro ' + String(memberId || '').substring(0, 20) + '.');
  return m;
}


// ============================================================
// ===  Búsqueda y ficha  =====================================
// ============================================================

/**
 * Lista de miembros con su estado de pago.
 *
 * @param {string} [query] Texto: cada palabra debe aparecer en nombre, ID, DPI o teléfono.
 * @param {{estado?:string, pago?:string}} [filters]
 */
function gbMembersSearch_(query, filters) {
  filters = filters || {};
  var options = gbPaymentOptions_();
  var today = gbToday_();
  var members = gbList_('members');
  var lastPay = gbLastPaymentMap_();
  var words = gbSearchText_(query).split(/\s+/).filter(Boolean);

  var items = [];
  members.forEach(function (m) {
    if (filters.estado && m.Estado !== filters.estado) return;

    if (words.length) {
      var haystack = gbSearchText_([m.MemberID, gbFullName_(m), m.DPI, m.Telefono].join(' '));
      for (var i = 0; i < words.length; i++) if (haystack.indexOf(words[i]) === -1) return;
    }

    var status = gbPaymentStatus_(m, lastPay[m.MemberID], today, options);
    if (filters.pago && status.code !== filters.pago) return;

    var view = gbMemberView_(m);
    view.pago = status;
    view.ultimoPago = lastPay[m.MemberID] ? gbFmtDate_(lastPay[m.MemberID]) : '';
    items.push(view);
  });

  items.sort(function (a, b) {
    return (a.apellidos + ' ' + a.nombres).localeCompare(b.apellidos + ' ' + b.nombres, 'es');
  });
  return { items: items, total: items.length, totalMiembros: members.length };
}

function gbSortDesc_(rows, field) {
  return rows.slice().sort(function (a, b) {
    var da = gbParseDate_(a[field]), db = gbParseDate_(b[field]);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
}

/**
 * Ficha completa de un miembro: datos, pagos (solo Admin), medidas, evaluaciones
 * con puntaje, asistencia reciente y estado de pago.
 */
function gbMemberGet_(memberId) {
  var m = gbMemberOrThrow_(memberId);
  var options = gbPaymentOptions_();
  var payments = gbList_('payments', function (p) { return p.MemberID === m.MemberID; });
  var lastPay = gbLastPaymentMap_(payments)[m.MemberID];

  var catalog = gbEvaluationCatalogRows_();
  var evaluations = gbSortDesc_(gbList_('evaluations', function (e) { return e.MemberID === m.MemberID; }), 'Fecha')
    .map(function (e) { return gbEvaluationView_(e, catalog); });

  var measurements = gbSortDesc_(gbList_('measurements', function (x) { return x.MemberID === m.MemberID; }), 'Fecha')
    .map(gbMeasurementView_);

  var out = {
    member: gbMemberView_(m),
    pago: gbPaymentStatus_(m, lastPay, gbToday_(), options),
    medidas: measurements,
    evaluaciones: evaluations,
    asistencia: gbAttendanceSummary_(m.MemberID)
  };
  // El detalle de pagos (montos) es solo para Admin.
  out.pagos = gbIsAdmin_() ? gbSortDesc_(payments, 'Fecha').map(gbPaymentView_) : null;
  return out;
}

/** Resumen de asistencia (la tabla se llena con el tablet de QR). */
function gbAttendanceSummary_(memberId) {
  var rows = gbList_('attendance', function (a) { return a.MemberID === memberId; });
  var today = gbParseDate_(gbToday_());
  var last = '', last30 = 0;
  rows.forEach(function (a) {
    var d = gbParseDate_(a.Fecha);
    if (!d) return;
    if (!last || d > gbParseDate_(last)) last = gbFmtDate_(d);
    if (gbDaysBetween_(d, today) <= 30 && gbDaysBetween_(d, today) >= 0) last30++;
  });
  return { ultima: last, ultimos30dias: last30, total: rows.length };
}


// ============================================================
// ===  Alta / edición  =======================================
// ============================================================

/**
 * Valida los datos de un formulario de miembro.
 * @return {{errors:Object<string,string>, clean:Object}}
 */
function gbValidateMember_(input, existing, allMembers) {
  var errors = {};
  var clean = {};
  var today = gbParseDate_(gbToday_());

  clean.Nombres = String(input.nombres == null ? '' : input.nombres).replace(/\s+/g, ' ').trim();
  if (!clean.Nombres) errors.nombres = 'Completa el campo Nombres.';
  clean.Apellidos = String(input.apellidos == null ? '' : input.apellidos).replace(/\s+/g, ' ').trim();
  if (!clean.Apellidos) errors.apellidos = 'Completa el campo Apellidos.';

  if (existing && !gbIsAdmin_()) {
    // Un entrenador no ve el DPI completo: al editar se conserva el que ya está guardado.
    clean.DPI = String(existing.DPI);
  } else {
    clean.DPI = gbNormDpi_(input.dpi);
  }
  if (!(existing && !gbIsAdmin_()) && clean.DPI.length !== 13) {
    errors.dpi = 'El DPI debe tener 13 dígitos.';
  } else if (!(existing && !gbIsAdmin_())) {
    var dup = allMembers.filter(function (m) {
      return String(m.DPI) === clean.DPI && (!existing || m.MemberID !== existing.MemberID);
    })[0];
    if (dup) errors.dpi = 'Ya existe un miembro con ese DPI (' + dup.MemberID + ').';
  }

  var birth = gbParseDate_(input.fechaNacimiento);
  if (!birth) errors.fechaNacimiento = 'Indica la fecha de nacimiento.';
  else if (birth > today || birth.getFullYear() < 1900) errors.fechaNacimiento = 'La fecha de nacimiento no es válida.';
  clean.FechaNacimiento = birth || '';

  clean.Telefono = gbNormPhone_(input.telefono);
  if (clean.Telefono.length !== 8) errors.telefono = 'El teléfono debe tener 8 dígitos.';

  clean.Correo = String(input.correo == null ? '' : input.correo).trim().toLowerCase();
  if (clean.Correo && !gbIsEmail_(clean.Correo)) errors.correo = 'El correo no es válido.';

  clean.Genero = String(input.genero || '');
  if (GB_GENEROS.indexOf(clean.Genero) === -1) errors.genero = 'Selecciona el género.';

  var fee = Number(input.mensualidad);
  if (!(fee > 0) || fee > 100000) errors.mensualidad = 'Indica la mensualidad.';
  clean.Mensualidad = fee > 0 ? fee : '';

  var payDay = parseInt(input.diaPago, 10);
  var payDate = gbParseDate_(input.fechaPago);
  if (payDate) payDay = payDate.getDate();
  if (payDay >= 1 && payDay <= 31) {
    clean.DiaPago = payDay;
  } else if (!existing) {
    errors.fechaPago = 'Indica la fecha de pago.';
  } else {
    clean.DiaPago = existing.DiaPago;
  }

  if (input.estado != null && input.estado !== '') {
    if (GB_ESTADOS.indexOf(input.estado) === -1) errors.estado = 'Estado no válido.';
    else clean.Estado = input.estado;
  }
  clean.Notas = String(input.notas == null ? '' : input.notas).trim().substring(0, 500);
  clean._payDate = payDate;
  return { errors: errors, clean: clean };
}

/**
 * Crea o actualiza un miembro.
 * Con `memberId` actualiza; sin él crea uno nuevo.
 *
 * @return {{ok:boolean, errors?:Object, member?:Object, created?:boolean}}
 */
function gbMemberSave_(input) {
  input = input || {};
  return gbWithLock_(function () {
    var existing = input.memberId ? gbMemberOrThrow_(input.memberId) : null;
    var all = gbList_('members');
    var check = gbValidateMember_(input, existing, all);
    if (Object.keys(check.errors).length) {
      return { ok: false, errors: check.errors, message: 'Revisa los campos marcados.' };
    }

    var clean = check.clean;
    var payDate = clean._payDate;
    delete clean._payDate;

    if (existing) {
      var patch = {};
      ['DPI', 'Nombres', 'Apellidos', 'FechaNacimiento', 'Telefono', 'Correo', 'Genero', 'Mensualidad', 'DiaPago', 'Notas']
        .forEach(function (f) { patch[f] = clean[f]; });
      if (clean.Estado) patch.Estado = clean.Estado;
      var updated = gbUpdate_('members', existing.MemberID, patch);
      return { ok: true, created: false, member: gbMemberView_(updated) };
    }

    var tokens = {};
    all.forEach(function (m) { tokens[m.TokenQR] = true; });
    var token = gbToken_(24);
    while (tokens[token]) token = gbToken_(24);

    clean.Estado = clean.Estado || 'Activo';
    clean.TokenQR = token;
    clean.FechaRegistro = payDate || gbParseDate_(gbToday_());
    var created = gbAppend_('members', clean);
    log_('miembros', 'OK', { alta: created.MemberID, por: gbCtx_().email });
    return { ok: true, created: true, member: gbMemberView_(created) };
  });
}

/** Cambia el estado (Activo / Inactivo / Suspendido). */
function gbMemberSetStatus_(memberId, estado) {
  if (GB_ESTADOS.indexOf(estado) === -1) throw new Error('Estado no válido.');
  var m = gbMemberOrThrow_(memberId);
  var updated = gbUpdate_('members', m.MemberID, { Estado: estado });
  log_('miembros', 'OK', { estado: m.MemberID + ' → ' + estado, por: gbCtx_().email });
  return { ok: true, member: gbMemberView_(updated) };
}

/**
 * Elimina un miembro. Si tiene pagos, medidas, evaluaciones, asistencia o mensajes
 * NO lo borra salvo que se confirme `cascade` (se borra también todo su historial).
 * Recomendado: marcar "Inactivo" en vez de eliminar.
 */
function gbMemberDelete_(memberId, cascade) {
  var m = gbMemberOrThrow_(memberId);
  return gbWithLock_(function () {
    var counts = {
      pagos: gbList_('payments', function (r) { return r.MemberID === m.MemberID; }).length,
      medidas: gbList_('measurements', function (r) { return r.MemberID === m.MemberID; }).length,
      evaluaciones: gbList_('evaluations', function (r) { return r.MemberID === m.MemberID; }).length,
      asistencia: gbList_('attendance', function (r) { return r.MemberID === m.MemberID; }).length,
      mensajes: gbList_('messages', function (r) { return r.MemberID === m.MemberID; }).length
    };
    var total = counts.pagos + counts.medidas + counts.evaluaciones + counts.asistencia + counts.mensajes;

    if (total > 0 && !cascade) {
      return { ok: false, needsCascade: true, counts: counts,
               message: 'Este miembro tiene historial. Márcalo como Inactivo o confirma que quieres borrar también su historial.' };
    }
    if (cascade) {
      gbRemoveWhere_('payments', 'MemberID', m.MemberID);
      gbRemoveWhere_('measurements', 'MemberID', m.MemberID);
      gbRemoveWhere_('evaluations', 'MemberID', m.MemberID);
      gbRemoveWhere_('attendance', 'MemberID', m.MemberID);
      gbRemoveWhere_('messages', 'MemberID', m.MemberID);
    }
    gbRemove_('members', m.MemberID);
    log_('miembros', 'OK', { baja: m.MemberID, historial: counts, por: gbCtx_().email });
    return { ok: true, deleted: m.MemberID, counts: counts };
  });
}
