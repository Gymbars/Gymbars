/**
 * Evaluations.gs — Evaluación física por niveles (Nivel 0 a 3, 7 ejercicios cada uno).
 *
 * Reemplaza RegisterTest / USER_TESTS y las fórmulas de EVALUACIONES. Las metas de
 * cada ejercicio viven en la pestaña EjerciciosEvaluacion, no en fórmulas.
 * Puntaje de nivel: ver gbEvaluationScores_ (Rules.gs).
 */

/** Catálogo como filas [Codigo, Nivel, Nombre, Meta, Unidad] (hoja o, si está vacía, el inicial). */
function gbEvaluationCatalogRows_() {
  var rows = [];
  try {
    gbList_('exercises').forEach(function (e) {
      rows.push([String(e.Codigo), Number(e.Nivel), String(e.Nombre), Number(e.Meta), String(e.Unidad)]);
    });
  } catch (_) { /* pestaña todavía no creada */ }
  return rows.length ? rows : gbExerciseSeed_();
}

/** Catálogo para armar el formulario. */
function gbEvaluationCatalog_() {
  return {
    ok: true,
    ejercicios: gbEvaluationCatalogRows_().map(function (r) {
      return { codigo: r[0], nivel: r[1], nombre: r[2], meta: r[3], unidad: r[4] };
    })
  };
}

function gbEvaluationView_(e, catalog) {
  var values = {};
  gbExerciseCodes_().forEach(function (code) {
    values[code] = e[code] === '' || e[code] == null ? '' : Number(e[code]);
  });
  var scores = gbEvaluationScores_(e, catalog || gbEvaluationCatalogRows_());
  return {
    evalId: String(e.EvalID), memberId: String(e.MemberID), fecha: gbFmtDate_(e.Fecha),
    valores: values, puntajes: scores
  };
}

/**
 * Registra una evaluación. Debe haber al menos un resultado (como en el Excel).
 * @param {{memberId:string, fecha?:string, valores:Object<string,number>}} input
 */
function gbEvaluationRegister_(input) {
  input = input || {};
  return gbWithLock_(function () {
    var m = gbMemberOrThrow_(input.memberId);
    var catalog = gbEvaluationCatalogRows_();
    var valid = {};
    catalog.forEach(function (r) { valid[r[0]] = r; });

    var date = gbParseDate_(input.fecha || gbToday_());
    var today = gbParseDate_(gbToday_());
    if (!date) return { ok: false, message: 'La fecha no es válida.', errors: { fecha: 'Fecha no válida.' } };
    if (gbDaysBetween_(today, date) > 1) {
      return { ok: false, message: 'La fecha no puede ser futura.', errors: { fecha: 'No puede ser futura.' } };
    }

    var record = { MemberID: m.MemberID, Fecha: date };
    var errors = {};
    var filled = 0;
    Object.keys(input.valores || {}).forEach(function (code) {
      var raw = input.valores[code];
      if (raw === '' || raw == null) return;
      if (!valid[code]) { errors[code] = 'Ejercicio desconocido.'; return; }
      var n = Number(String(raw).replace(',', '.'));
      if (isNaN(n) || n < 0 || n > 100000) { errors[code] = valid[code][2] + ': valor no válido.'; return; }
      record[code] = n;
      filled++;
    });

    if (Object.keys(errors).length) return { ok: false, errors: errors, message: 'Revisa los campos marcados.' };
    if (!filled) return { ok: false, message: 'Debes ingresar al menos un valor para registrar la evaluación.' };

    var saved = gbAppend_('evaluations', record);
    log_('evaluaciones', 'OK', { evaluacion: saved.EvalID, miembro: m.MemberID, por: gbCtx_().email });
    return { ok: true, evaluacion: gbEvaluationView_(saved, catalog) };
  });
}

function gbEvaluationRemove_(evalId) {
  var existing = gbFind_('evaluations', 'EvalID', evalId);
  if (!existing) throw new Error('No se encontró la evaluación.');
  gbRemove_('evaluations', existing.EvalID);
  log_('evaluaciones', 'ANULADO', { evaluacion: existing.EvalID, miembro: existing.MemberID, por: gbCtx_().email });
  return { ok: true, removed: existing.EvalID };
}
