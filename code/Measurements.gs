/**
 * Measurements.gs — Control físico (medidas corporales y peso).
 *
 * Reemplaza RegisterMeasurement / ControlUser del Excel. Igual que allá, todos los
 * campos son obligatorios (cm y libras) y al abrir el formulario se precargan las
 * últimas medidas del miembro.
 */

/** [clave del formulario, columna de la hoja, etiqueta] en el orden del Excel. */
function gbMeasureFields_() {
  return [
    ['cuello', 'Cuello', 'Cuello'],
    ['pecho', 'Pecho', 'Pecho'],
    ['brazoDer', 'BrazoDer', 'Brazo derecho'],
    ['brazoIzq', 'BrazoIzq', 'Brazo izquierdo'],
    ['cintura', 'Cintura', 'Cintura'],
    ['cadera', 'Cadera', 'Cadera'],
    ['piernaDer', 'PiernaDer', 'Pierna derecha'],
    ['piernaIzq', 'PiernaIzq', 'Pierna izquierda'],
    ['pesoLb', 'PesoLb', 'Peso (libras)']
  ];
}

function gbMeasurementView_(r) {
  var out = { medidaId: String(r.MedidaID), memberId: String(r.MemberID), fecha: gbFmtDate_(r.Fecha) };
  gbMeasureFields_().forEach(function (f) {
    out[f[0]] = r[f[1]] === '' || r[f[1]] == null ? '' : Number(r[f[1]]);
  });
  return out;
}

/** Últimas medidas registradas del miembro (para precargar el formulario). */
function gbMeasurementPrefill_(memberId) {
  var m = gbMemberOrThrow_(memberId);
  var rows = gbSortDesc_(gbList_('measurements', function (x) { return x.MemberID === m.MemberID; }), 'Fecha');
  return { ok: true, ultima: rows.length ? gbMeasurementView_(rows[0]) : null };
}

/**
 * Registra medidas.
 * @param {{memberId:string, fecha?:string, cuello:number, pecho:number, brazoDer:number, brazoIzq:number,
 *          cintura:number, cadera:number, piernaDer:number, piernaIzq:number, pesoLb:number}} input
 */
function gbMeasurementRegister_(input) {
  input = input || {};
  return gbWithLock_(function () {
    var m = gbMemberOrThrow_(input.memberId);
    var errors = {};

    var date = gbParseDate_(input.fecha || gbToday_());
    var today = gbParseDate_(gbToday_());
    if (!date) errors.fecha = 'Fecha no válida.';
    else if (gbDaysBetween_(today, date) > 1) errors.fecha = 'No puede ser futura.';

    var record = { MemberID: m.MemberID, Fecha: date };
    gbMeasureFields_().forEach(function (f) {
      var n = Number(String(input[f[0]] == null ? '' : input[f[0]]).replace(',', '.'));
      if (input[f[0]] === '' || input[f[0]] == null) errors[f[0]] = 'Completa el campo ' + f[2] + '.';
      else if (!(n > 0) || n >= 1000) errors[f[0]] = f[2] + ': valor no válido.';
      else record[f[1]] = n;
    });

    if (Object.keys(errors).length) {
      return { ok: false, errors: errors, message: 'Revisa los campos marcados.' };
    }

    var saved = gbAppend_('measurements', record);
    log_('medidas', 'OK', { medida: saved.MedidaID, miembro: m.MemberID, por: gbCtx_().email });
    return { ok: true, medida: gbMeasurementView_(saved) };
  });
}

function gbMeasurementRemove_(medidaId) {
  var existing = gbFind_('measurements', 'MedidaID', medidaId);
  if (!existing) throw new Error('No se encontró el registro de medidas.');
  gbRemove_('measurements', existing.MedidaID);
  log_('medidas', 'ANULADO', { medida: existing.MedidaID, miembro: existing.MemberID, por: gbCtx_().email });
  return { ok: true, removed: existing.MedidaID };
}
