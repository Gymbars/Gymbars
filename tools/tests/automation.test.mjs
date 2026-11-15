/**
 * Pruebas de mensajería, automatización diaria, asistencia con QR, Wallet y páginas públicas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadGas, memSheet } from './gas-sandbox.mjs';

const FILES = ['Auth.gs', 'Api.gs', 'Schema.gs', 'Repo.gs', 'Rules.gs', 'Members.gs', 'Payments.gs', 'Measurements.gs',
  'Evaluations.gs', 'Messaging.gs', 'Attendance.gs', 'Triggers.gs', 'Wallet.gs', 'Pages.gs', 'Progress.gs', 'Modules.gs'];
const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COACH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BASE = 'https://script.google.com/macros/s/TEST/exec';

const SITE_STUBS = `
  ['cpGetData_','cpSaveSite_','cpSaveImages_','cpSaveCarousel_','cpSaveFeatures_','cpSavePrograms_','cpSaveSchedule_',
   'cpSaveSocial_','cpListImages_','cpUploadImage_','cpCheckImages_','cpRefreshCache_','cpSetupSheets_','cpBackup_']
    .forEach(function (n) { this[n] = function () { return n; }; }, this);`;

function env(opts = {}) {
  const sheets = {};
  const g = loadGas(FILES, { owner: 'owner@gym.test', sheets, extra: SITE_STUBS, baseUrl: BASE, ...opts });
  Object.values(g.ctx.gbSchema_()).forEach(spec => { sheets[spec.name] = memSheet([[...spec.headers]]); });
  sheets['Usuarios'].data.push(['coach@gym.test', 'Coach', 'Si']);
  g.addSession(ADMIN, 'owner@gym.test');
  g.addSession(COACH, 'coach@gym.test');
  const api = (token, action, ...args) => g.ctx.gbApi(token, action, args);
  const plain = v => JSON.parse(JSON.stringify(v));
  let n = 0;
  const ctx = g.ctx;

  const helpers = {
    g, ctx, sheets, plain, props: g.props,
    admin: (a, ...args) => api(ADMIN, a, ...args),
    coach: (a, ...args) => api(COACH, a, ...args),
    api,
    addMember(over = {}) {
      n++;
      return ctx.gbAppend_('members', {
        DPI: String(3000000000000 + n), Nombres: 'Ana' + n, Apellidos: 'Pérez', FechaNacimiento: new Date(1990, 0, 15, 12),
        Telefono: String(47990000 + n), Correo: '', Genero: 'Femenino', Mensualidad: 150, DiaPago: 5, Estado: 'Activo',
        TokenQR: crypto.randomBytes(12).toString('hex'), FechaRegistro: new Date(2026, 0, 5, 12), Notas: '', ...over
      });
    },
    addPayment: (memberId, date, amount = 150) => ctx.gbAppend_('payments',
      { MemberID: memberId, Fecha: ctx.gbParseDate_(date), Monto: amount, ComprobanteToken: crypto.randomBytes(12).toString('hex') }),
    setConfig: (k, v) => ctx.gbConfigSet_(k, v)
  };
  return helpers;
}

// ---- fechas relativas a "hoy"
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, 12);
const today = () => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12);
/** Pago y día de pago para que la próxima fecha caiga a `k` días de hoy (k<0 = ya venció). */
function dueIn(k) {
  const due = addDays(today(), k);
  const y = due.getMonth() === 0 ? due.getFullYear() - 1 : due.getFullYear();
  const m = due.getMonth() === 0 ? 11 : due.getMonth() - 1;
  const day = Math.min(due.getDate(), new Date(y, m + 1, 0).getDate());
  return { fecha: ymd(new Date(y, m, day, 12)), diaPago: due.getDate() };
}
const memberDue = (h, k, over = {}) => {
  const { fecha, diaPago } = dueIn(k);
  const m = h.addMember({ DiaPago: diaPago, ...over });
  h.addPayment(m.MemberID, fecha);
  return m;
};


// ============================================================ Mensajería

test('mensajes: la boleta se arma con el texto del Excel, enlace propio y teléfono con código de país', () => {
  const h = env();
  const m = h.addMember({ Nombres: 'María José', Telefono: '47993217' });
  const p = h.addPayment(m.MemberID, '2026-11-05', 150);
  const r = h.plain(h.ctx.gbQueueMessage_({ type: 'boleta', memberId: m.MemberID, paymentId: p.PagoID }));
  assert.equal(r.ok, true);
  const wa = r.whatsapp;
  assert.equal(wa.canal, 'WhatsApp');
  assert.equal(wa.para, '50247993217');
  assert.equal(wa.estado, 'Pendiente');
  assert.match(wa.texto, /Hola María 🙌/, 'usa solo el primer nombre');
  assert.match(wa.texto, /Pagaste el: 05\/11\/2026/);
  assert.match(wa.texto, /Total: Q150/);
  assert.match(wa.texto, /Próximo pago: 05\/12\/2026/);
  assert.ok(wa.texto.includes(`${BASE}?comprobante=${p.ComprobanteToken}`));
  assert.ok(!/\{[a-zA-Z]+\}/.test(wa.texto), 'sin variables sin reemplazar');
  assert.ok(wa.waUrl.startsWith('https://wa.me/50247993217?text='));
  assert.equal(r.email, null, 'sin correo no hay mensaje de email');
});

test('mensajes: con correo se crea también el email; el interruptor de email lo apaga', () => {
  const h = env();
  const m = h.addMember({ Correo: 'ana@mail.test' });
  const p = h.addPayment(m.MemberID, '2026-11-05');
  const r = h.plain(h.ctx.gbQueueMessage_({ type: 'boleta', memberId: m.MemberID, paymentId: p.PagoID }));
  assert.equal(r.email.canal, 'Email');
  assert.equal(r.email.para, 'ana@mail.test');
  assert.match(r.email.asunto, /boleta de pago de Gymbars/i);

  const h2 = env();
  h2.setConfig('email_activo', 'NO');
  const m2 = h2.addMember({ Correo: 'ana@mail.test' });
  const p2 = h2.addPayment(m2.MemberID, '2026-11-05');
  assert.equal(h2.ctx.gbQueueMessage_({ type: 'boleta', memberId: m2.MemberID, paymentId: p2.PagoID }).email, null);
});

test('mensajes: no se duplica; "force" permite reenviar; descartado deja volver a crear', () => {
  const h = env();
  const m = h.addMember({ Correo: 'a@b.co' });
  const p = h.addPayment(m.MemberID, '2026-11-05');
  const req = { type: 'boleta', memberId: m.MemberID, paymentId: p.PagoID };
  h.ctx.gbQueueMessage_(req);
  const again = h.plain(h.ctx.gbQueueMessage_(req));
  assert.equal(again.existing, 2);
  assert.equal(h.sheets['Mensajes'].data.length, 3, 'solo WhatsApp + Email');

  h.ctx.gbQueueMessage_({ ...req, force: true });
  assert.equal(h.sheets['Mensajes'].data.length, 5);

  const id = h.sheets['Mensajes'].data[1][0];
  h.admin('messages.discard', id);
  const afterDiscard = h.plain(h.ctx.gbQueueMessage_(req));
  assert.equal(afterDiscard.whatsapp.estado, 'Pendiente', 'se crea uno nuevo (el descartado no cuenta)');
});

test('mensajes: teléfono inválido o sin URL pública generan avisos claros', () => {
  const h = env();
  const m = h.addMember({ Telefono: '123' });
  const p = h.addPayment(m.MemberID, '2026-11-05');
  const r = h.plain(h.ctx.gbQueueMessage_({ type: 'boleta', memberId: m.MemberID, paymentId: p.PagoID }));
  assert.equal(r.ok, false);
  assert.ok(r.warnings.some(w => w.includes('no es válido para WhatsApp')));

  const noUrl = env({ baseUrl: '' });
  const m2 = noUrl.addMember();
  const p2 = noUrl.addPayment(m2.MemberID, '2026-11-05');
  const r2 = noUrl.plain(noUrl.ctx.gbQueueMessage_({ type: 'boleta', memberId: m2.MemberID, paymentId: p2.PagoID }));
  assert.ok(r2.warnings.some(w => w.includes('GB_REPORT_BASE_URL')));
});

test('mensajes: reportes sin datos fallan con mensaje claro', () => {
  const h = env();
  const m = h.addMember();
  assert.throws(() => h.ctx.gbQueueMessage_({ type: 'boleta', memberId: m.MemberID }), /no tiene pagos/);
  assert.throws(() => h.ctx.gbQueueMessage_({ type: 'medidas', memberId: m.MemberID }), /no tiene medidas/);
  assert.throws(() => h.ctx.gbQueueMessage_({ type: 'evaluacion', memberId: m.MemberID }), /no tiene evaluaciones/);
  assert.throws(() => h.admin('messages.queue', { type: 'hackeo', memberId: m.MemberID }), /Tipo de mensaje no válido/);
});

test('bandeja: listar con filtros y contadores, marcar enviado y descartar', () => {
  const h = env();
  const a = h.addMember(), b = h.addMember();
  h.ctx.gbQueueMessage_({ type: 'carnet', memberId: a.MemberID });
  h.ctx.gbQueueMessage_({ type: 'carnet', memberId: b.MemberID });
  const list = h.plain(h.coach('messages.list'));
  assert.equal(list.total, 2);
  assert.equal(list.counts.Pendiente, 2);
  assert.ok(list.items[0].nombre.startsWith('Ana'));

  const id = list.items[0].mensajeId;
  const sent = h.plain(h.coach('messages.markSent', id));
  assert.equal(sent.mensaje.estado, 'Enviado');
  assert.equal(sent.mensaje.enviadoPor, 'coach@gym.test');
  assert.ok(sent.mensaje.enviadoEn);
  assert.equal(h.plain(h.coach('messages.list')).total, 1, 'por defecto solo pendientes');
  assert.equal(h.plain(h.coach('messages.list', { estado: 'Enviado' })).total, 1);
  assert.equal(h.plain(h.coach('messages.list', { estado: '' })).total, 2, 'estado vacío = todos');
  assert.throws(() => h.coach('messages.markSent', 'MS-999999'), /No se encontró/);
});

test('correo: se envía solo, marca Enviado y respeta la cuota diaria', () => {
  const h = env({ mailQuota: 1 });
  for (let i = 0; i < 2; i++) {
    const m = h.addMember({ Correo: `m${i}@mail.test` });
    h.ctx.gbQueueMessage_({ type: 'carnet', memberId: m.MemberID });
  }
  const r = h.plain(h.ctx.gbSendPendingEmails_(10));
  assert.equal(r.sent, 1, 'solo alcanza la cuota');
  assert.equal(r.pending, 1);
  assert.equal(h.ctx.MailApp.sent.length, 1);
  assert.equal(h.ctx.MailApp.sent[0].to, 'm0@mail.test');
  const states = h.sheets['Mensajes'].data.slice(1).filter(row => row[3] === 'Email').map(row => row[8]);
  assert.deepEqual(states.sort(), ['Enviado', 'Pendiente']);
});

test('correo: un fallo marca Error, no rompe el resto y el log no lleva el correo del miembro', () => {
  const h = env();
  const m = h.addMember({ Correo: 'secreto@mail.test' });
  h.ctx.gbQueueMessage_({ type: 'carnet', memberId: m.MemberID });
  h.ctx.MailApp.failNext = true;
  const r = h.plain(h.ctx.gbSendPendingEmails_(5));
  assert.equal(r.errors, 1);
  assert.equal(h.sheets['Mensajes'].data.find(row => row[3] === 'Email')[8], 'Error');
  assert.ok(!JSON.stringify(h.g.logs).includes('secreto@mail.test'));
  assert.equal(h.plain(h.coach('messages.retryEmail', h.sheets['Mensajes'].data.find(row => row[3] === 'Email')[0])).ok, true);
});

test('correo: con email_activo en NO no se envía nada', () => {
  const h = env();
  const m = h.addMember({ Correo: 'a@b.co' });
  h.ctx.gbQueueMessage_({ type: 'carnet', memberId: m.MemberID });
  h.setConfig('email_activo', 'NO');
  assert.equal(h.plain(h.ctx.gbSendPendingEmails_(5)).disabled, true);
  assert.equal(h.ctx.MailApp.sent.length, 0);
});

test('plantillas: el Admin edita y el siguiente mensaje usa el texto nuevo; el entrenador no puede', () => {
  const h = env();
  assert.throws(() => h.coach('templates.save', { tipo: 'carnet', canal: 'WhatsApp', texto: 'x' }), /PERM:/);
  assert.throws(() => h.admin('templates.save', { tipo: 'carnet', canal: 'Telegram', texto: 'x' }), /no válido/);
  assert.throws(() => h.admin('templates.save', { tipo: 'carnet', canal: 'WhatsApp', texto: '  ' }), /vacío/);
  h.admin('templates.save', { tipo: 'carnet', canal: 'WhatsApp', texto: 'Hola {nombre}, tu QR: {enlace}' });
  h.admin('templates.save', { tipo: 'carnet', canal: 'WhatsApp', texto: 'Hola {nombre}! QR: {enlace}' }); // actualizar, no duplicar
  assert.equal(h.sheets['Plantillas'].data.filter(r => r[0] === 'carnet' && r[1] === 'WhatsApp').length, 1);
  const m = h.addMember({ Nombres: 'Luis' });
  const r = h.plain(h.ctx.gbQueueMessage_({ type: 'carnet', memberId: m.MemberID }));
  assert.ok(r.whatsapp.texto.startsWith('Hola Luis! QR: ' + BASE + '?carnet='));
  const list = h.plain(h.admin('templates.list'));
  assert.ok(list.items.length >= 14, 'incluye las iniciales que no estén en la hoja');
});

test('enlaces firmados: válidos solo para ese miembro y registro', () => {
  const h = env();
  const link = h.ctx.gbReportLink_('medidas', 'GB-0001', 'MD-00001');
  const q = Object.fromEntries(new URL(link).searchParams);
  assert.equal(q.reporte, 'medidas');
  assert.equal(h.ctx.gbVerifyReportLink_(q.reporte, q.m, q.r, q.s), true);
  assert.equal(h.ctx.gbVerifyReportLink_('medidas', 'GB-0002', q.r, q.s), false, 'otro miembro');
  assert.equal(h.ctx.gbVerifyReportLink_('medidas', q.m, 'MD-00002', q.s), false, 'otro registro');
  assert.equal(h.ctx.gbVerifyReportLink_('evaluacion', q.m, q.r, q.s), false, 'otro tipo');
  assert.equal(h.ctx.gbVerifyReportLink_('medidas', q.m, q.r, ''), false);
  assert.ok(h.props.get('GB_LINK_SECRET').length >= 32, 'el secreto se crea y se guarda');
});


// ============================================================ Páginas públicas

test('páginas: boleta, reporte de medidas y carnet muestran lo correcto y nunca el DPI', () => {
  const h = env();
  const m = h.addMember({ Nombres: 'Sofía', Apellidos: 'Díaz' });
  const p = h.addPayment(m.MemberID, '2026-11-05', 140);
  const dpi = String(m.DPI);

  const voucher = h.ctx.gbVoucherPage_(p.ComprobanteToken).html;
  assert.match(voucher, /Boleta de pago/);
  assert.match(voucher, /Q140/);
  assert.match(voucher, /Sofía Díaz/);
  assert.ok(!voucher.includes(dpi));

  h.admin('measurements.register', { memberId: m.MemberID, fecha: '2026-10-01', cuello: 37, pecho: 96, brazoDer: 30, brazoIzq: 29, cintura: 87, cadera: 95, piernaDer: 53, piernaIzq: 53, pesoLb: 165 });
  const second = h.plain(h.admin('measurements.register', { memberId: m.MemberID, fecha: '2026-11-01', cuello: 37, pecho: 96, brazoDer: 30, brazoIzq: 29, cintura: 85, cadera: 95, piernaDer: 53, piernaIzq: 53, pesoLb: 162 }));
  const q = Object.fromEntries(new URL(h.ctx.gbReportLink_('medidas', m.MemberID, second.medida.medidaId)).searchParams);
  const report = h.ctx.gbReportPage_(q.reporte, q.m, q.r, q.s).html;
  assert.match(report, /Reporte de medidas/);
  assert.match(report, /162 lb/);
  assert.match(report, /−3 lb/, 'cambio contra el registro anterior');
  assert.match(report, /<svg/);
  assert.ok(!report.includes(dpi));

  const carnet = h.ctx.gbCarnetPage_(m.TokenQR).html;
  assert.ok(carnet.includes('GB1:' + m.TokenQR));
  assert.ok(!carnet.includes(dpi));
  assert.ok(!carnet.includes(String(m.Telefono)));
});

test('páginas: enlaces falsos o manipulados dan "no válido" y demasiados intentos bloquean', () => {
  const h = env();
  const m = h.addMember();
  assert.match(h.ctx.gbVoucherPage_('x').html, /Enlace no válido/);
  assert.match(h.ctx.gbCarnetPage_('f'.repeat(24)).html, /Enlace no válido/);
  const q = Object.fromEntries(new URL(h.ctx.gbReportLink_('medidas', m.MemberID, 'MD-00001')).searchParams);
  assert.match(h.ctx.gbReportPage_('medidas', m.MemberID, 'MD-00001', 'a'.repeat(32)).html, /Enlace no válido/);
  assert.match(h.ctx.gbReportPage_('medidas', m.MemberID, 'MD-00009', q.s).html, /Enlace no válido/);
  for (let i = 0; i < 60; i++) h.ctx.gbVoucherPage_('bad' + i);
  assert.match(h.ctx.gbVoucherPage_('x').html, /Demasiados intentos/);
});

test('páginas: el texto de los miembros se escapa (sin inyección de HTML)', () => {
  const h = env();
  const m = h.addMember({ Nombres: '<script>alert(1)</script>', Apellidos: '"><img src=x>' });
  const html = h.ctx.gbCarnetPage_(m.TokenQR).html;
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;script&gt;'));
});


// ============================================================ Automatización diaria

test('plan diario: recordatorio por vencer y aviso de vencido; ignora al día, en gracia, sin pagos e inactivos', () => {
  const h = env();
  const porVencer = memberDue(h, 2);
  memberDue(h, 20);                                  // al día
  memberDue(h, -2);                                  // en gracia
  const vencido = memberDue(h, -10);
  h.addMember();                                     // sin pagos
  memberDue(h, -10, { Estado: 'Inactivo' });         // inactivo con deuda
  const plan = h.plain(h.ctx.gbDailyPlan_(ymd(today())));
  assert.deepEqual(plan.map(p => [p.type, p.memberId]), [
    ['pago_vencido', vencido.MemberID], ['recordatorio_pago', porVencer.MemberID]
  ]);
});

test('ejecución: apagada no hace nada; encendida crea mensajes una sola vez por ciclo', () => {
  const h = env();
  memberDue(h, 2);
  memberDue(h, -10);
  assert.equal(h.plain(h.ctx.gbRunDailyJob_({})).skipped, true);
  assert.equal(h.sheets['Mensajes'].data.length, 1);

  h.setConfig('automatizacion_activa', 'SI');
  const first = h.plain(h.ctx.gbRunDailyJob_({}));
  assert.equal(first.ok, true);
  assert.deepEqual(first.creados, { pago_vencido: 1, recordatorio_pago: 1 });
  assert.equal(h.sheets['Mensajes'].data.length, 3);

  const second = h.plain(h.ctx.gbRunDailyJob_({}));
  assert.deepEqual(second.creados, {}, 'no repite el mismo aviso');
  assert.equal(second.yaExistian, 2);
  assert.equal(h.sheets['Mensajes'].data.length, 3);
});

test('simulacro: muestra el plan sin escribir y respeta el máximo', () => {
  const h = env();
  for (let i = 0; i < 5; i++) memberDue(h, -10);
  const dry = h.plain(h.admin('automation.run', true));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 5);
  assert.deepEqual(dry.porTipo, { pago_vencido: 5 });
  assert.equal(h.sheets['Mensajes'].data.length, 1, 'no escribió nada');
  const capped = h.plain(h.ctx.gbRunDailyJob_({ dryRun: true, force: true, max: 2 }));
  assert.equal(capped.mostrados, 2);
  assert.equal(capped.total, 5);
});

test('inactividad: solo con control de asistencia en uso, desde la última visita o desde que empezó', () => {
  const h = env();
  const m = memberDue(h, 20);                         // membresía vigente
  const noStart = h.plain(h.ctx.gbDailyPlan_(ymd(today())));
  assert.equal(noStart.length, 0, 'sin control de asistencia no se avisa de inactividad');

  h.setConfig('asistencia_desde', ymd(addDays(today(), -20)));
  const plan = h.plain(h.ctx.gbDailyPlan_(ymd(today())));
  assert.deepEqual(plan.map(p => [p.type, p.extra.dias]), [['inactividad', 20]]);

  // visita hace 3 días: ya no es inactivo
  h.ctx.gbAppend_('attendance', { MemberID: m.MemberID, FechaHora: addDays(today(), -3), Fecha: addDays(today(), -3), Origen: 'QR' });
  assert.equal(h.plain(h.ctx.gbDailyPlan_(ymd(today()))).length, 0);

  // visita hace 15 días (≥ 10): vuelve a aparecer contado desde esa visita
  h.sheets['Asistencia'].data.length = 1;
  h.ctx.gbAppend_('attendance', { MemberID: m.MemberID, FechaHora: addDays(today(), -15), Fecha: addDays(today(), -15), Origen: 'QR' });
  assert.equal(h.plain(h.ctx.gbDailyPlan_(ymd(today())))[0].extra.dias, 15);
});

test('inactividad: no se repite durante 14 días y quien ya venció se trata como pago, no como inactivo', () => {
  const h = env();
  h.setConfig('asistencia_desde', ymd(addDays(today(), -30)));
  h.setConfig('automatizacion_activa', 'SI');
  const m = memberDue(h, 20);
  memberDue(h, -10);                                   // vencido: recibe aviso de pago, no de inactividad
  const first = h.plain(h.ctx.gbRunDailyJob_({}));
  assert.deepEqual(first.creados, { pago_vencido: 1, inactividad: 1 });
  // una semana después sigue inactivo, pero el aviso anterior fue hace < 14 días
  h.sheets['Mensajes'].data.forEach((row, i) => { if (i && row[2] === 'inactividad') row[9] = addDays(today(), -7); });
  assert.equal(h.plain(h.ctx.gbDailyPlan_(ymd(today()))).filter(p => p.type === 'inactividad').length, 0);
  h.sheets['Mensajes'].data.forEach((row, i) => { if (i && row[2] === 'inactividad') row[9] = addDays(today(), -15); });
  assert.equal(h.plain(h.ctx.gbDailyPlan_(ymd(today()))).filter(p => p.type === 'inactividad').length, 1);
  assert.ok(m.MemberID);
});

test('progreso: solo para quienes ya tienen medidas y llevan ≥ 30 días sin medirse', () => {
  const h = env();
  const medido = memberDue(h, 20);
  memberDue(h, 20);                                   // nunca medido: no se le avisa
  h.ctx.gbAppend_('measurements', { MemberID: medido.MemberID, Fecha: addDays(today(), -40), PesoLb: 160 });
  const plan = h.plain(h.ctx.gbDailyPlan_(ymd(today())));
  assert.deepEqual(plan.map(p => [p.type, p.memberId]), [['progreso', medido.MemberID]]);
  h.ctx.gbAppend_('measurements', { MemberID: medido.MemberID, Fecha: addDays(today(), -5), PesoLb: 158 });
  assert.equal(h.plain(h.ctx.gbDailyPlan_(ymd(today()))).length, 0);
});

test('disparador: gbDailyJob solo actúa con el identificador de un disparador real; instalar reemplaza el anterior', () => {
  const h = env();
  memberDue(h, -10);
  h.setConfig('automatizacion_activa', 'SI');
  h.ctx.gbDailyJob({});                                   // alguien lo llama desde el navegador
  h.ctx.gbDailyJob({ triggerUid: 'inventado' });
  assert.equal(h.sheets['Mensajes'].data.length, 1, 'no hizo nada');

  h.setConfig('hora_diaria', '6');
  h.admin('automation.install');
  h.admin('automation.install');
  assert.equal(h.ctx.ScriptApp.triggers.length, 1, 'un solo disparador');
  assert.equal(h.ctx.ScriptApp.triggers[0].hour, 6);
  const uid = h.ctx.ScriptApp.triggers[0].uid;
  h.ctx.gbDailyJob({ triggerUid: uid });
  assert.equal(h.sheets['Mensajes'].data.length, 2, 'ahora sí se ejecutó');
});

test('revisión de estados: lista a los activos vencidos o sin pagos y permite inactivarlos en bloque', () => {
  const h = env();
  const al = memberDue(h, 10);
  const v1 = memberDue(h, -40), v2 = memberDue(h, -10);
  const sin = h.addMember();
  const review = h.plain(h.admin('automation.review'));
  assert.deepEqual(review.items.map(i => i.memberId), [v1.MemberID, v2.MemberID, sin.MemberID], 'más atrasado primero, sin pagos al final');
  assert.ok(!review.items.some(i => i.memberId === al.MemberID));

  assert.throws(() => h.coach('members.bulkStatus', [v1.MemberID], 'Inactivo'), /PERM:/);
  assert.equal(h.plain(h.admin('members.bulkStatus', [v1.MemberID, sin.MemberID], 'Inactivo')).cambiados, 2);
  assert.equal(h.plain(h.admin('automation.review')).total, 1);
  assert.throws(() => h.admin('members.bulkStatus', [], 'Inactivo'), /No hay miembros/);
  assert.throws(() => h.admin('members.bulkStatus', ['x'], 'Raro'), /Estado no válido/);
});

test('encender la automatización instala el disparador; el estado resume lo pendiente', () => {
  const h = env();
  memberDue(h, -10);
  assert.equal(h.plain(h.admin('automation.status')).activa, false);
  const on = h.plain(h.admin('automation.setEnabled', true));
  assert.equal(on.activa, true);
  assert.equal(on.disparador, true);
  assert.equal(on.porRevisar, 1);
  assert.equal(h.plain(h.admin('automation.setEnabled', false)).activa, false);
});

test('configuración: solo claves permitidas y valores válidos', () => {
  const h = env();
  assert.throws(() => h.admin('config.set', 'automatizacion_activa', 'SI'), /no se puede cambiar/);
  assert.throws(() => h.admin('config.set', 'dias_gracia', '-1'), /no válido/);
  assert.throws(() => h.admin('config.set', 'dias_gracia', 'abc'), /no válido/);
  assert.throws(() => h.admin('config.set', 'pais_codigo', '50A'), /no válido/);
  assert.throws(() => h.admin('config.set', 'scanner_url', 'http://inseguro'), /https/);
  assert.throws(() => h.coach('config.set', 'dias_gracia', '5'), /PERM:/);
  assert.equal(h.plain(h.admin('config.set', 'email_activo', 'no')).valor, 'NO');
  h.admin('config.set', 'dias_gracia', '5');
  assert.equal(h.ctx.gbConfigNumber_('dias_gracia', 0), 5);
  h.admin('config.set', 'scanner_url', 'https://checkin.example.com');
  assert.equal(h.plain(h.admin('config.get')).valores.scanner_url, 'https://checkin.example.com');
});


// ============================================================ Asistencia con QR

/** Empareja un tablet y devuelve su token. */
function pair(h, name = 'Recepción') {
  const code = h.plain(h.admin('devices.createPairing', name)).code;
  const r = h.plain(h.ctx.gbScanApi_({ action: 'pair', code }));
  assert.equal(r.ok, true, r.error);
  return r.device;
}

test('emparejar: el código sirve una vez, el token no se guarda en la hoja y se puede revocar', () => {
  const h = env();
  const created = h.plain(h.admin('devices.createPairing', ' Recepción  '));
  assert.match(created.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const first = h.plain(h.ctx.gbScanApi_({ action: 'pair', code: created.code.toLowerCase() }));
  assert.equal(first.ok, true);
  assert.match(first.device, /^[0-9a-f]{40}$/);
  assert.equal(first.nombre, 'Recepción');
  assert.equal(h.plain(h.ctx.gbScanApi_({ action: 'pair', code: created.code })).ok, false, 'un solo uso');

  const row = h.sheets['Dispositivos'].data[1];
  assert.equal(row[2], h.ctx.gbHash_(first.device));
  assert.ok(!JSON.stringify(h.sheets['Dispositivos'].data).includes(first.device), 'solo se guarda el hash');
  assert.equal(h.plain(h.ctx.gbScanApi_({ action: 'ping', device: first.device })).ok, true);

  h.admin('devices.revoke', row[0]);
  assert.equal(h.plain(h.ctx.gbScanApi_({ action: 'ping', device: first.device })).ok, false);
  assert.throws(() => h.coach('devices.createPairing', 'x'), /PERM:/);
  assert.throws(() => h.admin('devices.createPairing', ''), /nombre/);
});

test('emparejar: demasiados intentos con códigos falsos bloquean unos minutos', () => {
  const h = env();
  for (let i = 0; i < 10; i++) assert.equal(h.plain(h.ctx.gbScanApi_({ action: 'pair', code: 'ZZZZ' + i + 'AAA' })).status, 'codigo_invalido');
  const blocked = h.plain(h.ctx.gbScanApi_({ action: 'pair', code: 'ABCDEFGH' }));
  assert.equal(blocked.status, 'limite');
});

test('escaneo: registra la visita con QR y responde solo nombre de pila y estado', () => {
  const h = env();
  const device = pair(h);
  const m = memberDue(h, 20, { Nombres: 'María José', Apellidos: 'Reyes', Correo: 'm@x.co' });
  const r = h.plain(h.ctx.gbScanApi_({ action: 'scan', device, code: 'GB1:' + m.TokenQR }));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.nombre, 'María');
  assert.equal(r.pago.code, 'al_dia');
  assert.match(r.hora, /^\d{2}:\d{2}$/);
  const text = JSON.stringify(r);
  for (const secret of [String(m.DPI), String(m.Telefono), 'Reyes', 'm@x.co', m.TokenQR, m.MemberID]) {
    assert.ok(!text.includes(secret), 'la respuesta no debe incluir ' + secret);
  }

  const row = h.sheets['Asistencia'].data[1];
  assert.equal(row[1], m.MemberID);
  assert.equal(row[4], 'QR');
  assert.equal(row[6], 'al_dia');
  assert.equal(h.ctx.gbConfigGet_('asistencia_desde', ''), ymd(today()), 'el primer registro inicia el control de asistencia');
});

test('escaneo: un segundo QR dentro de la ventana no duplica; fuera de la ventana sí registra', () => {
  const h = env();
  const device = pair(h);
  const m = memberDue(h, 20);
  const scan = () => h.plain(h.ctx.gbScanApi_({ action: 'scan', device, code: 'GB1:' + m.TokenQR }));
  assert.equal(scan().status, 'ok');
  assert.equal(scan().status, 'duplicado');
  assert.equal(h.sheets['Asistencia'].data.length, 2);

  h.sheets['Asistencia'].data[1][2] = new Date(Date.now() - 5 * 60 * 60 * 1000); // hace 5 h (ventana 4 h)
  assert.equal(scan().status, 'ok');
  assert.equal(h.sheets['Asistencia'].data.length, 3);
});

test('escaneo: código desconocido, mal formado, miembro inactivo y dispositivo no autorizado', () => {
  const h = env();
  const device = pair(h);
  const inactive = memberDue(h, 20, { Estado: 'Inactivo' });
  const call = (code, dev = device) => h.plain(h.ctx.gbScanApi_({ action: 'scan', device: dev, code }));

  assert.equal(call('GB1:' + 'a'.repeat(24)).status, 'desconocido');
  assert.equal(call('hola').status, 'desconocido');
  assert.equal(call("GB1:' OR 1=1").status, 'desconocido');
  assert.equal(call('GB1:' + inactive.TokenQR).status, 'sin_membresia');
  assert.equal(h.sheets['Asistencia'].data.length, 1, 'nada de lo anterior registra asistencia');
  assert.equal(call('GB1:' + inactive.TokenQR, 'f'.repeat(40)).status, 'no_autorizado');
  assert.equal(call('GB1:' + inactive.TokenQR, '').status, 'no_autorizado');
  assert.equal(h.plain(h.ctx.gbScanApi_({ action: 'otra' })).ok, false);
});

test('escaneo: muchos tokens de dispositivo falsos activan el bloqueo temporal', () => {
  const h = env();
  const device = pair(h);
  const m = memberDue(h, 20);
  for (let i = 0; i < 30; i++) h.ctx.gbScanApi_({ action: 'scan', device: 'e'.repeat(40), code: 'GB1:' + m.TokenQR });
  const blocked = h.plain(h.ctx.gbScanApi_({ action: 'scan', device, code: 'GB1:' + m.TokenQR }));
  assert.equal(blocked.status, 'limite');
});

test('escaneo: el estado de pago viaja para avisar, pero nunca se bloquea la entrada', () => {
  const h = env();
  const device = pair(h);
  const vencido = memberDue(h, -10);
  const r = h.plain(h.ctx.gbScanApi_({ action: 'scan', device, code: 'GB1:' + vencido.TokenQR }));
  assert.equal(r.status, 'ok');
  assert.equal(r.pago.code, 'vencido');
  assert.equal(h.sheets['Asistencia'].data[1][6], 'vencido');
});

test('escaneo: dos escaneos simultáneos del mismo QR dejan una sola visita (el bloqueo serializa)', () => {
  const h = env();
  const device = pair(h);
  const m = memberDue(h, 20);
  const before = h.g.lock.lockCount;
  h.ctx.gbScanApi_({ action: 'scan', device, code: 'GB1:' + m.TokenQR });
  h.ctx.gbScanApi_({ action: 'scan', device, code: 'GB1:' + m.TokenQR });
  assert.equal(h.sheets['Asistencia'].data.length, 2);
  assert.ok(h.g.lock.lockCount > before);
  assert.equal(h.g.lock.lockHeld, 0);
});

test('asistencia manual, lista de hoy e historial; el entrenador puede usarlos', () => {
  const h = env();
  const a = memberDue(h, 20), b = memberDue(h, 20);
  const first = h.plain(h.coach('attendance.manual', a.MemberID));
  assert.equal(first.status, 'ok');
  assert.equal(h.plain(h.coach('attendance.manual', a.MemberID)).status, 'duplicado');
  assert.equal(h.plain(h.coach('attendance.manual', a.MemberID, true)).status, 'ok', 'force permite una segunda visita');
  h.coach('attendance.manual', b.MemberID);

  const today_ = h.plain(h.coach('attendance.today'));
  assert.equal(today_.total, 3);
  assert.equal(today_.personas, 2);
  assert.equal(today_.items[0].origen, 'Manual');
  const hist = h.plain(h.coach('attendance.history', a.MemberID));
  assert.equal(hist.total, 2);
  const ficha = h.plain(h.coach('members.get', a.MemberID));
  assert.equal(ficha.asistencia.total, 2);
  assert.equal(ficha.asistencia.ultimos30dias, 2);
  assert.throws(() => h.coach('attendance.setStart', '2026-01-01'), /PERM:/);
  assert.equal(h.plain(h.admin('attendance.setStart', '2026-01-01')).desde, '2026-01-01');
  assert.throws(() => h.admin('attendance.setStart', 'mañana'), /no válida/);
});


// ============================================================ Google Wallet

test('wallet: sin configuración no hay enlace; con configuración el JWT está bien firmado y no lleva el DPI', () => {
  const h = env();
  const m = h.addMember({ Nombres: 'Ana', Apellidos: 'Gómez' });
  assert.equal(h.ctx.gbWalletSaveUrl_(m), '');
  const info = h.plain(h.coach('wallet.carnet', m.MemberID));
  assert.equal(info.walletConfigurado, false);
  assert.equal(info.qrTexto, 'GB1:' + m.TokenQR);
  assert.ok(info.enlace.startsWith(BASE + '?carnet='));

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  h.props.set('GB_WALLET_ISSUER_ID', '3388000000012345');
  h.props.set('GB_WALLET_SA', JSON.stringify({ client_email: 'wallet@proj.iam.gserviceaccount.com', private_key: pem }));

  const url = h.ctx.gbWalletSaveUrl_(m);
  assert.ok(url.startsWith('https://pay.google.com/gp/v/save/'));
  const [head, body, sig] = url.replace('https://pay.google.com/gp/v/save/', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const verify = crypto.createVerify('RSA-SHA256').update(head + '.' + body);
  assert.equal(verify.verify(publicKey, Buffer.from(sig, 'base64url')), true, 'firma RS256 válida');

  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(claims.iss, 'wallet@proj.iam.gserviceaccount.com');
  assert.equal(claims.typ, 'savetowallet');
  const obj = claims.payload.genericObjects[0];
  assert.equal(obj.barcode.type, 'QR_CODE');
  assert.equal(obj.barcode.value, 'GB1:' + m.TokenQR);
  assert.equal(obj.header.defaultValue.value, 'Ana Gómez');
  assert.ok(obj.id.startsWith('3388000000012345.'));
  assert.equal(claims.payload.genericClasses[0].id, '3388000000012345.gymbars_member');
  assert.ok(!JSON.stringify(claims).includes(String(m.DPI)));
  assert.equal(h.plain(h.coach('wallet.carnet', m.MemberID)).walletConfigurado, true);

  h.props.set('GB_WALLET_SA', '{no es json');
  assert.equal(h.ctx.gbWalletSaveUrl_(m), '', 'configuración dañada no rompe el carnet');
});

test('wallet: la página del carnet ofrece el botón de Wallet solo si está configurado', () => {
  const h = env();
  const m = h.addMember();
  assert.ok(!h.ctx.gbCarnetPage_(m.TokenQR).html.includes('Agregar a Google Wallet'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  h.props.set('GB_WALLET_ISSUER_ID', '123');
  h.props.set('GB_WALLET_SA', JSON.stringify({ client_email: 'a@b.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  assert.ok(h.ctx.gbCarnetPage_(m.TokenQR).html.includes('Agregar a Google Wallet'));
});


// ============================================================ Integración con pagos

test('integración: registrar un pago deja la boleta lista (WhatsApp) y envía el correo si hay email', () => {
  const h = env();
  const m = h.addMember({ Correo: 'ana@mail.test', Telefono: '47993217', Nombres: 'Ana' });
  const r = h.plain(h.admin('payments.register', { memberId: m.MemberID, monto: 150 }));
  assert.equal(r.ok, true);
  assert.equal(r.mensaje.whatsapp.canal, 'WhatsApp');
  assert.match(r.mensaje.whatsapp.waUrl, /^https:\/\/wa\.me\/50247993217\?text=/);
  assert.equal(h.ctx.MailApp.sent.length, 1, 'el correo salió solo');
  assert.equal(h.ctx.MailApp.sent[0].to, 'ana@mail.test');
  assert.match(h.ctx.MailApp.sent[0].body, /comprobante=/);
  const estados = h.sheets['Mensajes'].data.slice(1).map(row => [row[3], row[8]]);
  assert.deepEqual(estados.sort(), [['Email', 'Enviado'], ['WhatsApp', 'Pendiente']]);
});

test('integración: si falla el armado del mensaje, el pago igual queda guardado', () => {
  const h = env();
  const m = h.addMember({ Telefono: '1' });
  const r = h.plain(h.admin('payments.register', { memberId: m.MemberID, monto: 150 }));
  assert.equal(r.ok, true);
  assert.equal(h.sheets['Pagos'].data.length, 2);
  assert.equal(r.mensaje.ok, false);
});


// ============================================================ Panorama (progreso)

test('progreso: ordena por urgencia, cuenta estados y no incluye dinero ni inactivos', () => {
  const h = env();
  const vencido = memberDue(h, -10);
  const sinPagos = h.addMember();
  const porVencer = memberDue(h, 2);
  const medidas = memberDue(h, 20);
  memberDue(h, 20);                                       // todo en orden: no aparece
  memberDue(h, -40, { Estado: 'Inactivo' });              // inactivo: no aparece
  h.ctx.gbAppend_('measurements', { MemberID: medidas.MemberID, Fecha: addDays(today(), -45), PesoLb: 160 });

  const o = h.plain(h.coach('progress.overview'));
  assert.equal(o.ok, true);
  assert.deepEqual(o.atencion.map(a => a.memberId), [vencido.MemberID, sinPagos.MemberID, porVencer.MemberID, medidas.MemberID]);
  assert.equal(o.atencion[0].motivos[0].code, 'pago_vencido');
  assert.match(o.atencion[0].motivos[0].texto, /vencida hace 10 días/);
  assert.equal(o.atencion[3].motivos[0].code, 'medidas');
  assert.equal(o.totalAtencion, 4);
  assert.deepEqual(o.miembros, { activos: 5, inactivos: 1, suspendidos: 0,
    pago: { al_dia: 2, por_vencer: 1, gracia: 0, vencido: 1, sin_pagos: 1 } });
  const text = JSON.stringify(o);
  assert.ok(!/"(monto|mensualidad)"\s*:/i.test(text), 'sin campos de dinero');
  assert.ok(!text.includes('150'), 'sin importes');
  assert.equal(o.controlAsistencia, false);
});

test('progreso: la inactividad solo aparece con control de asistencia y la asistencia se cuenta por semana', () => {
  const h = env();
  const a = memberDue(h, 20), b = memberDue(h, 20);
  assert.ok(!h.plain(h.admin('progress.overview')).atencion.some(x => x.motivos.some(m => m.code === 'inactividad')));

  h.setConfig('asistencia_desde', ymd(addDays(today(), -25)));
  h.ctx.gbAppend_('attendance', { MemberID: a.MemberID, FechaHora: addDays(today(), 0), Fecha: today(), Origen: 'QR' });
  h.ctx.gbAppend_('attendance', { MemberID: a.MemberID, FechaHora: addDays(today(), -9), Fecha: addDays(today(), -9), Origen: 'QR' });
  h.ctx.gbAppend_('attendance', { MemberID: b.MemberID, FechaHora: addDays(today(), -9), Fecha: addDays(today(), -9), Origen: 'QR' });

  const o = h.plain(h.admin('progress.overview'));
  assert.equal(o.controlAsistencia, true);
  assert.deepEqual(o.atencion.map(x => [x.memberId, x.motivos[0].code]), [], 'ambos vinieron hace menos de 10 días');
  assert.equal(o.hoy.visitas, 1);
  assert.equal(o.hoy.personas, 1);
  assert.equal(o.semanas.length, 8);
  assert.equal(o.semanas.reduce((s, w) => s + w.visitas, 0), 3);
  assert.equal(o.semanas[7].visitas >= 1, true, 'la visita de hoy cae en la última semana');
  assert.ok(o.semanas.every((w, i, arr) => i === 0 || w.desde > arr[i - 1].desde), 'semanas en orden');

  // quien no ha venido desde que empezó el control (hace 25 días) sí aparece
  const c = memberDue(h, 20);
  const again = h.plain(h.admin('progress.overview'));
  assert.deepEqual(again.atencion.map(x => [x.memberId, x.motivos[0].code]), [[c.MemberID, 'inactividad']]);
  assert.match(again.atencion[0].motivos[0].texto, /25 días sin asistir/);
});

test('mensaje manual de inactividad calcula los días desde la última visita', () => {
  const h = env();
  const m = h.addMember({ FechaRegistro: addDays(today(), -100) });
  h.ctx.gbAppend_('attendance', { MemberID: m.MemberID, FechaHora: addDays(today(), -12), Fecha: addDays(today(), -12), Origen: 'QR' });
  const r = h.plain(h.admin('messages.queue', { type: 'inactividad', memberId: m.MemberID }));
  assert.match(r.whatsapp.texto, /Hace 12 días que no te vemos/);
  const noVisits = h.addMember({ FechaRegistro: addDays(today(), -30) });
  const r2 = h.plain(h.admin('messages.queue', { type: 'inactividad', memberId: noVisits.MemberID }));
  assert.match(r2.whatsapp.texto, /Hace 30 días/);
});
