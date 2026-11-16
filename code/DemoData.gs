/**
 * DemoData.gs — Datos de ejemplo para el entorno de PRUEBAS (staging).
 *
 * El entorno de pruebas nunca debe tener personas reales. Este archivo llena la hoja con
 * miembros inventados (pagos, medidas, evaluaciones, asistencia y mensajes) para poder
 * probar todo el sistema. Por seguridad:
 *   - solo corre si la propiedad del script GB_ENV es "staging";
 *   - se niega a correr si la pestaña Miembros ya tiene datos;
 *   - es determinista: siempre genera los mismos datos.
 * Menú: Gymbars → Cargar datos de ejemplo (solo pruebas).
 */

function gbSeedDemo_() {
  if (gbEnvironment_() !== 'staging') {
    throw new Error('Los datos de ejemplo solo se pueden cargar en el entorno de pruebas (propiedad del script GB_ENV = staging).');
  }
  if (gbList_('members').length) {
    throw new Error('La pestaña Miembros ya tiene datos. Los datos de ejemplo solo se cargan en una hoja vacía.');
  }

  var seed = 42;
  var rnd = function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  var pick = function (list) { return list[Math.floor(rnd() * list.length)]; };
  var today = gbParseDate_(gbToday_());
  var addDays = function (d, k) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, 12); };

  var names = ['Ana', 'Luis', 'María', 'Carlos', 'Sofía', 'Diego', 'Valeria', 'Jorge', 'Lucía', 'Pedro', 'Camila', 'Andrés',
    'Daniela', 'Mateo', 'Isabel', 'Héctor', 'Paola', 'Rodrigo', 'Fernanda', 'Gabriel', 'Mónica', 'Esteban', 'Claudia', 'Iván'];
  var surnames = ['Pérez', 'López', 'García', 'Morales', 'Ramírez', 'Castillo', 'Méndez', 'Hernández', 'Reyes', 'Cruz', 'Ortiz', 'Díaz'];
  var fees = [100, 130, 135, 140, 150];
  var offsets = [20, 12, 2, -2, -10, -45, null, 25, 8, 1];            // cuándo vence la próxima mensualidad

  var memberRows = names.map(function (name, i) {
    var k = offsets[i % offsets.length];
    var due = k === null ? null : addDays(today, k);
    return {
      DPI: String(2000000000000 + i * 7919), Nombres: name, Apellidos: pick(surnames) + ' ' + pick(surnames),
      FechaNacimiento: new Date(1975 + Math.floor(rnd() * 30), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27), 12),
      Telefono: String(40000000 + Math.floor(rnd() * 9999999)),
      Correo: i % 4 === 0 ? name.toLowerCase().replace(/[^a-z]/g, '') + '@ejemplo.test' : '',
      Genero: i % 3 === 0 ? 'Femenino' : 'Masculino', Mensualidad: pick(fees), DiaPago: due ? due.getDate() : '',
      Estado: i === 9 ? 'Inactivo' : 'Activo', TokenQR: gbToken_(24), FechaRegistro: addDays(today, -200), Notas: '', _due: due
    };
  });
  var members = gbBulkAppend_('members', memberRows);

  var payments = [], measurements = [], evaluations = [], attendance = [];
  members.forEach(function (m, i) {
    var due = memberRows[i]._due;
    if (due) {
      var prev = new Date(due.getFullYear(), due.getMonth() - 1, Math.min(due.getDate(), 28), 12);
      for (var p = 0; p < 3; p++) {
        payments.push({ MemberID: m.MemberID, Fecha: new Date(prev.getFullYear(), prev.getMonth() - p, prev.getDate(), 12),
          Monto: m.Mensualidad, ComprobanteToken: gbToken_(24) });
      }
    }
    for (var t = 0; t < 4; t++) {
      measurements.push({ MemberID: m.MemberID, Fecha: addDays(today, -t * 30 - (i % 12)), Cuello: 37 - t * 0.2, Pecho: 96 + t * 0.3,
        BrazoDer: 30 + t * 0.2, BrazoIzq: 29.5 + t * 0.2, Cintura: 88 - t, Cadera: 95, PiernaDer: 53, PiernaIzq: 53,
        PesoLb: Math.round((160 - t * 1.5 + rnd()) * 10) / 10 });
    }
    var ev = { MemberID: m.MemberID, Fecha: addDays(today, -40) };
    ['N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07'].forEach(function (c, j) { ev[c] = [45, 15, 8, 14, 7, 50, 12][j] + Math.floor(rnd() * 8); });
    if (i % 2 === 0) ['N11', 'N12', 'N13'].forEach(function (c, j) { ev[c] = [3, 40, 3][j]; });
    evaluations.push(ev);

    if (i % 4 !== 3) {                                                // algunos no vienen
      for (var d = 0; d < 20; d++) {
        if (rnd() < 0.55) {
          var day = addDays(today, -d - (i % 3));
          attendance.push({ MemberID: m.MemberID, FechaHora: day, Fecha: day, Origen: 'QR', DispositivoID: 'DV-DEMO', EstadoAlMomento: 'al_dia' });
        }
      }
    }
  });
  gbBulkAppend_('payments', payments);
  gbBulkAppend_('measurements', measurements);
  gbBulkAppend_('evaluations', evaluations);
  gbBulkAppend_('attendance', attendance);

  // El control de asistencia "empezó" hace 25 días y quedan algunos mensajes por enviar.
  gbConfigSet_('asistencia_desde', gbFmtDate_(addDays(today, -25)));
  var queued = 0;
  ['recordatorio_pago', 'pago_vencido', 'inactividad'].forEach(function (type, i) {
    try { gbQueueMessage_({ type: type, memberId: members[i * 2 + 2].MemberID, extra: { dias: 12 } }); queued++; } catch (_) { /* miembro sin pagos */ }
  });

  log_('demo', 'OK', { miembros: members.length, pagos: payments.length, medidas: measurements.length, asistencia: attendance.length });
  return { miembros: members.length, pagos: payments.length, medidas: measurements.length,
           evaluaciones: evaluations.length, asistencia: attendance.length, mensajes: queued };
}

/** Menú de la hoja (solo Admin): pide confirmación y muestra el resultado. */
function gbSeedDemoMenu_() {
  gbRequireAdminForMenu_();
  var ui = SpreadsheetApp.getUi();
  if (gbEnvironment_() !== 'staging') {
    ui.alert('Solo para pruebas', 'Esta hoja no es el entorno de pruebas (propiedad del script GB_ENV = staging). No se cargó nada.', ui.ButtonSet.OK);
    return;
  }
  var answer = ui.alert('Cargar datos de ejemplo', 'Se agregarán 24 miembros inventados con pagos, medidas, evaluaciones y asistencia. ¿Continuar?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  try {
    var r = gbSeedDemo_();
    ui.alert('Listo', 'Miembros: ' + r.miembros + ' · Pagos: ' + r.pagos + ' · Medidas: ' + r.medidas + ' · Evaluaciones: ' + r.evaluaciones +
      ' · Asistencia: ' + r.asistencia + ' · Mensajes: ' + r.mensajes, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('No se cargó nada', String(e.message || e), ui.ButtonSet.OK);
  }
}
