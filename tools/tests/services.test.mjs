/**
 * Pruebas de reglas de negocio y servicios (Rules, Members, Payments,
 * Measurements, Evaluations) a través de gbApi, con roles reales.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGas, memSheet } from './gas-sandbox.mjs';

const FILES = ['Auth.gs', 'Api.gs', 'Schema.gs', 'Repo.gs', 'Rules.gs', 'Members.gs', 'Payments.gs',
  'Measurements.gs', 'Evaluations.gs', 'Messaging.gs', 'Attendance.gs', 'Triggers.gs', 'Wallet.gs', 'Pages.gs', 'Progress.gs', 'Modules.gs'];
const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COACH = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// Funciones del panel del sitio web (ConfigPanelService.gs) que el registro de acciones referencia.
const SITE_STUBS = `
  ['cpGetData_','cpSaveSite_','cpSaveImages_','cpSaveCarousel_','cpSaveFeatures_','cpSavePrograms_','cpSaveSchedule_',
   'cpSaveSocial_','cpListImages_','cpUploadImage_','cpCheckImages_','cpRefreshCache_','cpSetupSheets_','cpBackup_']
    .forEach(function (n) { this[n] = function () { return n; }; }, this);`;

function env(opts = {}) {
  const sheets = {};
  const g = loadGas(FILES, {
    owner: 'owner@gym.test', sheets,
    extra: SITE_STUBS + (opts.queueStub ? `
      var queued = [];
      function gbQueueMessage_(req) { queued.push(req); return { id: 'MS-' + queued.length, type: req.type }; }` : ''),
    ...opts
  });
  const schema = g.ctx.gbSchema_();
  Object.values(schema).forEach(spec => { sheets[spec.name] = memSheet([[...spec.headers]]); });
  sheets['Usuarios'].data.push(['coach@gym.test', 'Coach', 'Si']);
  g.addSession(ADMIN, 'owner@gym.test');
  g.addSession(COACH, 'coach@gym.test');
  const api = (token, action, ...args) => g.ctx.gbApi(token, action, args);
  const admin = (action, ...args) => api(ADMIN, action, ...args);
  const coach = (action, ...args) => api(COACH, action, ...args);
  // Los objetos de la sandbox tienen otro prototipo: se pasan por JSON para comparar.
  const plain = v => JSON.parse(JSON.stringify(v));
  return { g, ctx: g.ctx, sheets, admin, coach, api, plain };
}

const form = (n, over = {}) => ({
  nombres: 'Ana', apellidos: 'Pérez ' + n, dpi: String(2000000000000 + n), fechaNacimiento: '1990-03-15',
  telefono: '4799' + String(1000 + n), correo: '', genero: 'Femenino', mensualidad: 150, fechaPago: '2026-01-05', ...over
});

// ------------------------------------------------------------ Reglas puras

test('próxima fecha de pago: mismo día del mes siguiente, con cambio de año y fin de mes', () => {
  const { ctx } = env();
  const next = (d, day) => ctx.gbFmtDate_(ctx.gbNextPaymentDate_(d, day));
  assert.equal(next('2026-11-05', 5), '2026-12-05');
  assert.equal(next('2026-12-20', 20), '2027-01-20');
  assert.equal(next('2026-01-31', 31), '2026-02-28', 'febrero no tiene 31: último día del mes');
  assert.equal(next('2028-01-31', 31), '2028-02-29', 'año bisiesto');
  assert.equal(next('2026-11-09', ''), '2026-12-09', 'sin día de pago usa el día del pago');
  assert.equal(next('2026-11-09', 5), '2026-12-05', 'el día de pago del miembro manda sobre el del pago');
  assert.equal(ctx.gbNextPaymentDate_('basura', 5), null);
});

test('estado de pago: al día, por vencer, gracia, vencido y sin pagos', () => {
  const { ctx } = env();
  const st = (today, last = '2026-10-05', day = 5) =>
    ctx.gbPaymentStatus_({ DiaPago: day }, last, today, { antes: 3, gracia: 3 });
  assert.equal(st('2026-10-20').code, 'al_dia');
  assert.equal(st('2026-11-02').code, 'por_vencer');
  assert.equal(st('2026-11-05').code, 'por_vencer');
  assert.equal(st('2026-11-05').daysToDue, 0);
  assert.equal(st('2026-11-08').code, 'gracia');
  assert.equal(st('2026-11-08').daysOverdue, 3);
  assert.equal(st('2026-11-09').code, 'vencido');
  assert.equal(st('2026-11-09').nextDue, '2026-11-05');
  assert.equal(ctx.gbPaymentStatus_({ DiaPago: 5 }, null, '2026-11-09').code, 'sin_pagos');
});

test('puntaje de evaluación: misma regla que el Excel (suma de resultado/meta ÷ 7, vacíos = 0, sin tope)', () => {
  const { ctx, plain } = env();
  const catalog = ctx.gbExerciseSeed_();
  const perfect = { N01: 60, N02: 20, N03: 10, N04: 20, N05: 10, N06: 60, N07: 20 };
  assert.deepEqual(plain(ctx.gbEvaluationScores_(perfect, catalog)), { n0: 1, n1: '', n2: '', n3: '' });
  // solo plancha a la mitad: 0.5 / 7
  assert.equal(ctx.gbEvaluationScores_({ N01: 30 }, catalog).n0, Math.round((0.5 / 7) * 10000) / 10000);
  // superar la meta no tiene tope
  assert.equal(ctx.gbEvaluationScores_({ N01: 120 }, catalog).n0, Math.round((2 / 7) * 10000) / 10000);
  // nivel 1 con metas 5,60,5,20,8,5,5 completas = 100 %
  const l1 = { N11: 5, N12: 60, N13: 5, N14: 20, N15: 8, N16: 5, N17: 5 };
  assert.equal(ctx.gbEvaluationScores_(l1, catalog).n1, 1);
  // sin resultados, o con ceros, el nivel queda vacío
  assert.equal(ctx.gbEvaluationScores_({}, catalog).n0, '');
  assert.equal(ctx.gbEvaluationScores_({ N01: 0, N02: '' }, catalog).n0, '');
});

test('teléfonos y WhatsApp: se agrega el código de país a los 8 dígitos', () => {
  const { ctx } = env();
  assert.equal(ctx.gbNormPhone_('+502 4799-3217'), '47993217');
  assert.equal(ctx.gbWaPhone_('47993217'), '50247993217');
  assert.equal(ctx.gbWaPhone_('50247993217'), '50247993217');
  assert.equal(ctx.gbWaPhone_('123'), '');
  assert.equal(ctx.gbWaPhone_('47993217', '503'), '50347993217');
  const link = ctx.gbWaLink_('47993217', 'Hola 🙌\nTotal: Q150');
  assert.equal(link, 'https://wa.me/50247993217?text=' + encodeURIComponent('Hola 🙌\nTotal: Q150'));
  assert.equal(ctx.gbWaLink_('1', 'x'), '');
});

test('utilidades: DPI enmascarado, búsqueda sin tildes, edad y plantillas', () => {
  const { ctx } = env();
  assert.equal(ctx.gbMaskDpi_('2000000000123'), '•••• •••• 0123');
  assert.equal(ctx.gbSearchText_('PÉREZ Ñandú'), 'perez nandu');
  assert.equal(ctx.gbAge_('1990-03-15', '2026-03-14'), 35);
  assert.equal(ctx.gbAge_('1990-03-15', '2026-03-15'), 36);
  assert.equal(ctx.gbAge_('', '2026-03-15'), '');
  assert.equal(ctx.gbRenderTemplate_('Hola {nombre}, Q{monto} {nada}!', { nombre: 'Ana', monto: 150 }), 'Hola Ana, Q150 !');
});

// ------------------------------------------------------------ Miembros

test('miembros: el alta valida todos los campos como el formulario del Excel', () => {
  const { admin, plain } = env();
  const r = plain(admin('members.save', { nombres: '', apellidos: '', dpi: '123', fechaNacimiento: '', telefono: '12',
    correo: 'mal', genero: '', mensualidad: 0 }));
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(),
    ['apellidos', 'correo', 'dpi', 'fechaNacimiento', 'fechaPago', 'genero', 'mensualidad', 'nombres', 'telefono']);
});

test('miembros: alta correcta genera ID, token y estado Activo; DPI repetido se rechaza', () => {
  const { admin, sheets, plain } = env();
  const r = plain(admin('members.save', form(1, { fechaPago: '2026-01-17' })));
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.member.memberId, 'GB-0001');
  assert.equal(r.member.estado, 'Activo');
  assert.equal(r.member.diaPago, 17);
  assert.equal(r.member.dpi, '2000000000001');
  const row = sheets['Miembros'].data[1];
  assert.match(String(row[11]), /^[0-9a-f]{24}$/, 'TokenQR aleatorio');
  assert.ok(!JSON.stringify(r).includes(String(row[11])), 'el token QR no viaja al navegador');

  const dup = plain(admin('members.save', form(1, { nombres: 'Otra' })));
  assert.equal(dup.ok, false);
  assert.match(dup.errors.dpi, /Ya existe un miembro con ese DPI \(GB-0001\)/);
});

test('miembros: editar cambia datos; el DPI puede conservarse y no se duplica', () => {
  const { admin, plain } = env();
  admin('members.save', form(1));
  admin('members.save', form(2));
  const ok = plain(admin('members.save', { ...form(1, { telefono: '55512345' }), memberId: 'GB-0001', mensualidad: 140 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.created, false);
  assert.equal(ok.member.telefono, '55512345');
  assert.equal(ok.member.mensualidad, 140);
  const clash = plain(admin('members.save', { ...form(1), memberId: 'GB-0001', dpi: form(2).dpi }));
  assert.match(clash.errors.dpi, /GB-0002/);
});

test('miembros: el entrenador ve el DPI enmascarado; el administrador lo ve completo', () => {
  const { admin, coach, plain } = env();
  admin('members.save', form(1));
  const asAdmin = plain(admin('members.get', 'GB-0001'));
  const asCoach = plain(coach('members.get', 'GB-0001'));
  assert.equal(asAdmin.member.dpi, '2000000000001');
  assert.equal(asCoach.member.dpi, '');
  assert.equal(asCoach.member.dpiMasked, '•••• •••• 0001');
  const list = plain(coach('members.search', ''));
  assert.equal(list.items[0].dpi, '');
});

test('miembros: un entrenador edita sin ver ni cambiar el DPI; crear sí exige el DPI', () => {
  const { admin, coach, plain } = env();
  admin('members.save', form(1));
  const { dpi, ...withoutDpi } = form(1, { telefono: '55512345' });
  const edited = plain(coach('members.save', { ...withoutDpi, memberId: 'GB-0001' }));
  assert.equal(edited.ok, true, JSON.stringify(edited.errors));
  assert.equal(edited.member.telefono, '55512345');
  assert.equal(plain(admin('members.get', 'GB-0001')).member.dpi, form(1).dpi, 'el DPI quedó igual');
  const tamper = plain(coach('members.save', { ...form(1), dpi: '1111111111111', memberId: 'GB-0001' }));
  assert.equal(tamper.ok, true);
  assert.equal(plain(admin('members.get', 'GB-0001')).member.dpi, form(1).dpi, 'un entrenador no puede cambiar el DPI');
  const create = plain(coach('members.save', { ...withoutDpi, nombres: 'Nuevo' }));
  assert.equal(create.ok, false);
  assert.match(create.errors.dpi, /13 dígitos/);
});

test('miembros: la búsqueda combina palabras, ignora tildes y filtra por estado de pago', () => {
  const { admin, plain } = env();
  admin('members.save', form(1, { nombres: 'María José', apellidos: 'Pérez' }));
  admin('members.save', form(2, { nombres: 'Luis', apellidos: 'Álvarez' }));
  admin('members.save', form(3, { nombres: 'Zoe', apellidos: 'Díaz' }));
  assert.deepEqual(plain(admin('members.search', 'maria perez')).items.map(i => i.memberId), ['GB-0001']);
  assert.deepEqual(plain(admin('members.search', '4799')).items.length, 3, 'por teléfono');
  assert.deepEqual(plain(admin('members.search', 'GB-0002')).items.map(i => i.nombres), ['Luis']);
  assert.deepEqual(plain(admin('members.search', '')).items.map(i => i.apellidos), ['Álvarez', 'Díaz', 'Pérez'], 'orden alfabético en español');
  assert.equal(plain(admin('members.search', '', { pago: 'sin_pagos' })).total, 3);
  assert.equal(plain(admin('members.search', '', { pago: 'al_dia' })).total, 0);
  admin('members.setStatus', 'GB-0003', 'Inactivo');
  assert.equal(plain(admin('members.search', '', { estado: 'Inactivo' })).total, 1);
});

test('miembros: cambiar estado valida el valor; eliminar con historial exige confirmar', () => {
  const { admin, coach, plain, sheets } = env();
  admin('members.save', form(1));
  assert.throws(() => admin('members.setStatus', 'GB-0001', 'Raro'), /Estado no válido/);
  assert.throws(() => admin('members.setStatus', 'GB-9999', 'Activo'), /No se encontró/);

  admin('payments.register', { memberId: 'GB-0001', monto: 150 });
  admin('measurements.register', { memberId: 'GB-0001', cuello: 37, pecho: 96, brazoDer: 30, brazoIzq: 29, cintura: 87, cadera: 95, piernaDer: 53, piernaIzq: 53, pesoLb: 160 });
  const blocked = plain(admin('members.delete', 'GB-0001'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needsCascade, true);
  assert.equal(blocked.counts.pagos, 1);
  assert.equal(sheets['Miembros'].data.length, 2, 'no se borró');

  assert.throws(() => coach('members.delete', 'GB-0001', true), /PERM: Tu rol \(Coach\)/);
  const done = plain(admin('members.delete', 'GB-0001', true));
  assert.equal(done.ok, true);
  assert.equal(sheets['Miembros'].data.length, 1);
  assert.equal(sheets['Pagos'].data.length, 1);
  assert.equal(sheets['Medidas'].data.length, 1);
});

// ------------------------------------------------------------ Pagos

test('pagos: solo Admin registra; el entrenador no puede', () => {
  const { admin, coach } = env();
  admin('members.save', form(1));
  assert.throws(() => coach('payments.register', { memberId: 'GB-0001', monto: 150 }), /PERM: Tu rol \(Coach\)/);
  assert.throws(() => coach('payments.void', 'PG-00001'), /PERM:/);
});

test('pagos: registrar guarda el pago con token, calcula la próxima fecha y deja la boleta en cola', () => {
  const { admin, ctx, sheets, plain } = env({ queueStub: true });
  admin('members.save', form(1, { fechaPago: '2026-01-05' }));
  const today = ctx.gbToday_();
  const r = plain(admin('payments.register', { memberId: 'GB-0001', fecha: today, monto: 150 }));
  assert.equal(r.ok, true);
  assert.equal(r.payment.pagoId, 'PG-00001');
  assert.equal(r.payment.monto, 150);
  assert.match(String(sheets['Pagos'].data[1][5]), /^[0-9a-f]{24}$/, 'ComprobanteToken');
  assert.equal(r.pago.nextDue, ctx.gbFmtDate_(ctx.gbNextPaymentDate_(today, 5)));
  assert.deepEqual(plain(ctx.queued), [{ type: 'boleta', memberId: 'GB-0001', paymentId: 'PG-00001' }]);
  assert.equal(r.mensaje.type, 'boleta');
});

test('pagos: todo el registro usa UN solo bloqueo (sin interbloqueo por anidamiento)', () => {
  const { g, admin } = env();
  admin('members.save', form(1));
  const before = g.lock.lockCount;
  admin('payments.register', { memberId: 'GB-0001', monto: 150 });
  assert.equal(g.lock.lockCount - before, 1);
  assert.equal(g.lock.lockHeld, 0);
});

test('pagos: reactiva a un miembro inactivo y fija el día de pago si no lo tenía', () => {
  const { admin, ctx, sheets, plain } = env();
  admin('members.save', form(1));
  admin('members.setStatus', 'GB-0001', 'Inactivo');
  sheets['Miembros'].data[1][9] = '';                     // sin día de pago
  const r = plain(admin('payments.register', { memberId: 'GB-0001', fecha: ctx.gbToday_(), monto: 150 }));
  assert.equal(r.reactivated, true);
  assert.equal(r.member.estado, 'Activo');
  assert.equal(r.member.diaPago, Number(ctx.gbToday_().slice(8)));
});

test('pagos: protección de doble clic, fecha futura y monto inválido', () => {
  const { admin, ctx, sheets, plain } = env();
  admin('members.save', form(1));
  const today = ctx.gbToday_();
  assert.equal(plain(admin('payments.register', { memberId: 'GB-0001', fecha: today, monto: 150 })).ok, true);
  const dup = plain(admin('payments.register', { memberId: 'GB-0001', fecha: today, monto: 150 }));
  assert.equal(dup.ok, false);
  assert.equal(dup.duplicate, true);
  assert.equal(sheets['Pagos'].data.length, 2);
  assert.equal(plain(admin('payments.register', { memberId: 'GB-0001', fecha: today, monto: 150, force: true })).ok, true);
  assert.equal(sheets['Pagos'].data.length, 3);

  const future = plain(admin('payments.register', { memberId: 'GB-0001', fecha: '2999-01-01', monto: 150 }));
  assert.match(future.message, /futura/);
  assert.equal(plain(admin('payments.register', { memberId: 'GB-0001', monto: 0 })).ok, false);
  assert.equal(plain(admin('payments.register', { memberId: 'GB-0001', monto: 'abc' })).ok, false);
  assert.throws(() => admin('payments.register', { memberId: 'GB-9999', monto: 150 }), /No se encontró/);
});

test('pagos: el estado pasa de sin_pagos a al día; anular un pago lo revierte', () => {
  const { admin, ctx, plain } = env();
  admin('members.save', form(1));
  assert.equal(plain(admin('members.get', 'GB-0001')).pago.code, 'sin_pagos');
  const r = plain(admin('payments.register', { memberId: 'GB-0001', fecha: ctx.gbToday_(), monto: 150 }));
  assert.ok(['al_dia', 'por_vencer'].includes(plain(admin('members.get', 'GB-0001')).pago.code));
  admin('payments.void', r.payment.pagoId);
  assert.equal(plain(admin('members.get', 'GB-0001')).pago.code, 'sin_pagos');
});

test('ficha: los pagos con montos solo los ve el Admin', () => {
  const { admin, coach, ctx, plain } = env();
  admin('members.save', form(1));
  admin('payments.register', { memberId: 'GB-0001', fecha: ctx.gbToday_(), monto: 150 });
  assert.equal(plain(admin('members.get', 'GB-0001')).pagos.length, 1);
  const asCoach = plain(coach('members.get', 'GB-0001'));
  assert.equal(asCoach.pagos, null);
  assert.ok(asCoach.pago.code, 'el entrenador sí ve el estado (al día / vencido)');
});

// ------------------------------------------------------------ Medidas y evaluaciones

const measures = (over = {}) => ({ memberId: 'GB-0001', cuello: 37, pecho: 96, brazoDer: 30, brazoIzq: 29.5, cintura: 87,
  cadera: 95, piernaDer: 53, piernaIzq: 53.5, pesoLb: 162, ...over });

test('medidas: todos los campos son obligatorios, como en el Excel', () => {
  const { coach, admin, plain } = env();
  admin('members.save', form(1));
  const r = plain(coach('measurements.register', { memberId: 'GB-0001', cuello: 37 }));
  assert.equal(r.ok, false);
  assert.equal(Object.keys(r.errors).length, 8);
  assert.equal(plain(coach('measurements.register', measures({ pesoLb: -5 }))).ok, false);
});

test('medidas: se guardan, se precargan las últimas y aparecen en la ficha; el entrenador puede usarlas', () => {
  const { coach, admin, plain, ctx } = env();
  admin('members.save', form(1));
  assert.equal(plain(coach('measurements.prefill', 'GB-0001')).ultima, null);
  const first = plain(coach('measurements.register', measures({ fecha: '2026-10-01', pesoLb: 165 })));
  assert.equal(first.ok, true);
  coach('measurements.register', measures({ fecha: '2026-11-01', pesoLb: 162, cuello: '37,5' }));
  const prefill = plain(coach('measurements.prefill', 'GB-0001')).ultima;
  assert.equal(prefill.fecha, '2026-11-01');
  assert.equal(prefill.pesoLb, 162);
  assert.equal(prefill.cuello, 37.5, 'acepta coma decimal');
  const ficha = plain(coach('members.get', 'GB-0001'));
  assert.deepEqual(ficha.medidas.map(m => m.fecha), ['2026-11-01', '2026-10-01'], 'más reciente primero');
  coach('measurements.remove', first.medida.medidaId);
  assert.equal(plain(coach('members.get', 'GB-0001')).medidas.length, 1);
  assert.equal(ctx.gbMeasureFields_().length, 9);
});

test('evaluaciones: requiere al menos un resultado, valida códigos y devuelve el puntaje', () => {
  const { coach, admin, plain } = env();
  admin('members.save', form(1));
  assert.match(plain(coach('evaluations.register', { memberId: 'GB-0001', valores: {} })).message, /al menos un valor/);
  assert.equal(plain(coach('evaluations.register', { memberId: 'GB-0001', valores: { N99: 5 } })).errors.N99, 'Ejercicio desconocido.');
  assert.match(plain(coach('evaluations.register', { memberId: 'GB-0001', valores: { N01: -3 } })).errors.N01, /no válido/);

  const r = plain(coach('evaluations.register', { memberId: 'GB-0001', fecha: '2026-10-10',
    valores: { N01: 60, N02: 20, N03: 10, N04: 20, N05: 10, N06: 60, N07: 20, N11: 5 } }));
  assert.equal(r.ok, true);
  assert.equal(r.evaluacion.puntajes.n0, 1);
  assert.equal(r.evaluacion.puntajes.n1, Math.round((1 / 7) * 10000) / 10000);
  const ficha = plain(coach('members.get', 'GB-0001'));
  assert.equal(ficha.evaluaciones.length, 1);
  assert.equal(ficha.evaluaciones[0].valores.N01, 60);
  coach('evaluations.remove', r.evaluacion.evalId);
  assert.equal(plain(coach('members.get', 'GB-0001')).evaluaciones.length, 0);
});

test('evaluaciones: el catálogo llega completo (28 ejercicios, 4 niveles)', () => {
  const { coach, plain } = env();
  const cat = plain(coach('evaluations.catalog'));
  assert.equal(cat.ejercicios.length, 28);
  assert.deepEqual([...new Set(cat.ejercicios.map(e => e.nivel))], [0, 1, 2, 3]);
});

// ------------------------------------------------------------ Registro de acciones

test('registro de acciones: ningún módulo queda abierto sin rol y todas las funciones son privadas', () => {
  const { ctx, plain } = env();
  const registry = ctx.gbActions_();
  const names = Object.keys(registry);
  for (const expected of ['members.search', 'members.save', 'payments.register', 'measurements.register', 'evaluations.register', 'cpGetData']) {
    assert.ok(names.includes(expected), 'falta ' + expected);
  }
  for (const name of names) assert.ok(plain(registry[name].roles).length > 0, name + ' sin roles');
  assert.deepEqual(plain(registry['payments.register'].roles), ['Admin']);
  assert.deepEqual(plain(registry['members.delete'].roles), ['Admin']);
  assert.deepEqual(plain(registry['members.search'].roles).sort(), ['Admin', 'Coach']);
});

test('sin sesión no se puede usar ningún módulo', () => {
  const { api } = env();
  for (const action of ['members.search', 'members.get', 'payments.register', 'measurements.register', 'evaluations.register']) {
    assert.throws(() => api('', action, {}), /AUTH:/, action);
  }
});
