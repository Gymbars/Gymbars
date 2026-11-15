/**
 * Payments.gs — Pagos de mensualidades.
 *
 * Reemplaza la macro RegisterPayment del Excel. Al registrar un pago:
 *   - se guarda con un token propio para su boleta (enlace que se envía al miembro),
 *   - si el miembro estaba Inactivo/Suspendido pasa a Activo,
 *   - si no tenía día de pago, se toma el día de este pago,
 *   - se calcula la próxima fecha de pago (mismo día del mes siguiente),
 *   - se deja en la bandeja de mensajes la boleta lista para enviar por WhatsApp.
 */

function gbPaymentView_(p) {
  return {
    pagoId: String(p.PagoID),
    memberId: String(p.MemberID),
    fecha: gbFmtDate_(p.Fecha),
    monto: Number(p.Monto) || 0,
    nota: String(p.Nota || '')
  };
}

/**
 * Registra un pago.
 *
 * @param {{memberId:string, fecha?:string, monto:number, nota?:string, force?:boolean}} input
 *   force: registrar aunque ya exista un pago igual ese día (por ejemplo, dos meses seguidos).
 * @return {{ok:boolean, message?:string, duplicate?:boolean, payment?:Object, pago?:Object,
 *           member?:Object, reactivated?:boolean, mensaje?:Object}}
 */
function gbPaymentRegister_(input) {
  input = input || {};
  return gbWithLock_(function () {
    var m = gbMemberOrThrow_(input.memberId);

    var amount = Number(input.monto);
    if (!(amount > 0) || amount > 100000) {
      return { ok: false, message: 'Completa el campo Monto.', errors: { monto: 'Indica el monto.' } };
    }

    var today = gbParseDate_(gbToday_());
    var paidOn = gbParseDate_(input.fecha || gbToday_());
    if (!paidOn) return { ok: false, message: 'La fecha no es válida.', errors: { fecha: 'Fecha no válida.' } };
    if (gbDaysBetween_(today, paidOn) > 1) {
      return { ok: false, message: 'La fecha del pago no puede ser futura.', errors: { fecha: 'No puede ser futura.' } };
    }

    // Protección contra doble clic: mismo miembro, misma fecha y mismo monto.
    var paidText = gbFmtDate_(paidOn);
    var duplicate = gbList_('payments', function (p) {
      return p.MemberID === m.MemberID && gbFmtDate_(p.Fecha) === paidText && Number(p.Monto) === amount;
    })[0];
    if (duplicate && !input.force) {
      return { ok: false, duplicate: true, payment: gbPaymentView_(duplicate),
               message: 'Ya hay un pago de Q' + amount + ' registrado ese día para este miembro.' };
    }

    var token = gbToken_(24);
    var saved = gbAppend_('payments', {
      MemberID: m.MemberID, Fecha: paidOn, Monto: amount,
      Nota: String(input.nota || '').trim().substring(0, 200), ComprobanteToken: token
    });

    var patch = {};
    var reactivated = false;
    if (m.DiaPago === '' || m.DiaPago == null) patch.DiaPago = paidOn.getDate();
    if (m.Estado !== 'Activo') { patch.Estado = 'Activo'; reactivated = true; }
    var member = Object.keys(patch).length ? gbUpdate_('members', m.MemberID, patch) : m;

    var lastPaid = gbLastPaymentMap_()[m.MemberID];
    var status = gbPaymentStatus_(member, lastPaid, gbToday_(), gbPaymentOptions_());

    var queued = null;
    if (typeof gbQueueMessage_ === 'function') {
      try {
        queued = gbQueueMessage_({ type: 'boleta', memberId: m.MemberID, paymentId: saved.PagoID });
      } catch (e) {
        log_('mensajes', 'ERROR', 'No se pudo preparar la boleta de ' + saved.PagoID + ': ' + e);
      }
    }

    log_('pagos', 'OK', { pago: saved.PagoID, miembro: m.MemberID, monto: amount, por: gbCtx_().email });
    return {
      ok: true, payment: gbPaymentView_(saved), pago: status,
      member: gbMemberView_(member), reactivated: reactivated, mensaje: queued
    };
  });
}

/** Anula (borra) un pago registrado por error. Solo Admin (ver Modules.gs). */
function gbPaymentVoid_(pagoId) {
  var existing = gbFind_('payments', 'PagoID', pagoId);
  if (!existing) throw new Error('No se encontró el pago.');
  gbRemove_('payments', existing.PagoID);
  log_('pagos', 'ANULADO', { pago: existing.PagoID, miembro: existing.MemberID, monto: existing.Monto, por: gbCtx_().email });
  return { ok: true, voided: existing.PagoID };
}

/**
 * Acción del panel: registra el pago y, si el miembro tiene correo, envía la boleta
 * por email en seguida (WhatsApp queda en la bandeja para enviarse con un toque).
 */
function gbPaymentRegisterApi_(input) {
  var result = gbPaymentRegister_(input);
  var queued = result && result.mensaje;
  if (result && result.ok && queued && queued.email && queued.email.estado === 'Pendiente') {
    try { gbSendPendingEmails_(3); } catch (e) { log_('mensajes', 'ERROR', 'envío de boleta por correo: ' + e); }
  }
  return result;
}
