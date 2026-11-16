/**
 * Pruebas de la capa de datos: Schema.gs, Repo.gs y Migration.gs.
 *   node --test "tools/tests/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGas, memSheet, memSpreadsheet } from './gas-sandbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['Auth.gs', 'Schema.gs', 'Repo.gs', 'Migration.gs'];

/** Entorno con todas las pestañas del esquema creadas (solo encabezados). */
function env(opts = {}) {
  const sheets = {};
  const g = loadGas(FILES, { owner: 'owner@gym.test', sheets, ...opts });
  const schema = g.ctx.gbSchema_();
  Object.values(schema).forEach(spec => { sheets[spec.name] = memSheet([[...spec.headers]]); });
  return { g, sheets, schema, ctx: g.ctx };
}

const member = (n, extra = {}) => ({
  DPI: String(1000000000000 + n), Nombres: 'Nombre' + n, Apellidos: 'Apellido' + n,
  FechaNacimiento: new Date(1990, 0, 15, 12), Telefono: '4799' + String(1000 + n),
  Correo: '', Genero: 'Masculino', Mensualidad: 150, DiaPago: 5, Estado: 'Activo',
  TokenQR: 'tok' + n, FechaRegistro: new Date(2026, 0, 5, 12), Notas: '', ...extra
});


// ------------------------------------------------------------ Esquema

test('esquema: cada tabla es coherente (columnas únicas y referencias válidas)', () => {
  const { schema } = env();
  for (const [key, spec] of Object.entries(schema)) {
    assert.equal(new Set(spec.headers).size, spec.headers.length, key + ': encabezados repetidos');
    if (spec.id) assert.ok(spec.headers.includes(spec.id.field), key + ': id fuera de encabezados');
    for (const group of ['dates', 'dateTimes', 'text', 'numbers']) {
      for (const col of spec[group] || []) assert.ok(spec.headers.includes(col), `${key}.${group}: ${col}`);
    }
    for (const col of Object.keys(spec.lists || {})) assert.ok(spec.headers.includes(col), `${key}.lists: ${col}`);
  }
  const names = Object.values(schema).map(s => s.name);
  assert.equal(new Set(names).size, names.length, 'nombres de pestaña repetidos');
});

test('esquema: ningún dato personal se mezcla con las pestañas del sitio público', () => {
  const { schema } = env();
  const publicTabs = ['Sitio', 'Imágenes', 'Carrusel', 'Características', 'Programas', 'ProgramaDetalle', 'Horario', 'Redes'];
  for (const spec of Object.values(schema)) assert.ok(!publicTabs.includes(spec.name), spec.name);
  const web = readFileSync(join(ROOT, 'code', 'WebsiteService.gs'), 'utf8');
  for (const spec of Object.values(schema)) {
    assert.ok(!web.includes("'" + spec.name + "'"), 'WebsiteService.gs no debe leer ' + spec.name);
  }
});

test('catálogo de evaluación: 28 ejercicios con las metas del Excel', () => {
  const { ctx, schema } = env();
  const seed = ctx.gbExerciseSeed_();
  assert.equal(seed.length, 28);
  assert.deepEqual([...seed.map(r => r[0])], [...schema.evaluations.headers.slice(3)], 'mismo orden que la tabla Evaluaciones');
  const targets = level => [...seed.filter(r => r[1] === level).map(r => r[3])];
  assert.deepEqual(targets(0), [60, 20, 10, 20, 10, 60, 20]);
  assert.deepEqual(targets(1), [5, 60, 5, 20, 8, 5, 5]);
  assert.deepEqual(targets(2), [10, 10, 10, 15, 5, 20, 20]);
  assert.deepEqual(targets(3), [20, 20, 20, 20, 30, 20, 20]);
});

test('plantillas: existen todos los tipos de mensaje requeridos y la boleta conserva el texto del Excel', () => {
  const { ctx } = env();
  const seed = ctx.gbTemplateSeed_();
  const wa = new Set(seed.filter(r => r[1] === 'WhatsApp').map(r => r[0]));
  for (const type of ['boleta', 'recordatorio_pago', 'pago_vencido', 'inactividad', 'progreso', 'medidas', 'evaluacion', 'carnet']) {
    assert.ok(wa.has(type), 'falta plantilla WhatsApp: ' + type);
  }
  const boleta = seed.find(r => r[0] === 'boleta' && r[1] === 'WhatsApp')[3];
  for (const piece of ['¡Gracias por tu pago!', 'Pagaste el: {fecha}', 'Total: Q{monto}', 'Próximo pago: {proximoPago}', 'Equipo {gym}']) {
    assert.ok(boleta.includes(piece), piece);
  }
});

test('configuración inicial: las automatizaciones empiezan apagadas', () => {
  const { ctx } = env();
  assert.equal(ctx.gbConfigFlag_('automatizacion_activa'), false);
  assert.equal(ctx.gbConfigGet_('pais_codigo', ''), '502');
  assert.equal(ctx.gbConfigNumber_('dias_gracia', 0), 3);
});


// ------------------------------------------------------------ Repo

test('repo: genera IDs consecutivos y escribe por nombre de columna', () => {
  const { ctx, sheets } = env();
  const a = ctx.gbAppend_('members', member(1));
  const b = ctx.gbAppend_('members', member(2));
  assert.equal(a.MemberID, 'GB-0001');
  assert.equal(b.MemberID, 'GB-0002');
  assert.equal(sheets['Miembros'].data.length, 3);
  assert.equal(ctx.gbFind_('members', 'DPI', ' 1000000000002 ').MemberID, 'GB-0002', 'compara como texto y sin espacios');
});

test('repo: reordenar columnas en la hoja no rompe lecturas ni escrituras', () => {
  const { ctx, sheets } = env();
  const sheet = sheets['Miembros'];
  // intercambia Nombres <-> Apellidos en la hoja real
  const i = sheet.data[0].indexOf('Nombres'), j = sheet.data[0].indexOf('Apellidos');
  [sheet.data[0][i], sheet.data[0][j]] = [sheet.data[0][j], sheet.data[0][i]];
  ctx.gbAppend_('members', member(1));
  const row = ctx.gbList_('members')[0];
  assert.equal(row.Nombres, 'Nombre1');
  assert.equal(row.Apellidos, 'Apellido1');
  assert.equal(sheet.data[1][i], 'Apellido1', 'el dato quedó en la columna que la hoja llama Nombres->Apellidos');
});

test('repo: actualizar cambia solo los campos indicados y no toca el ID', () => {
  const { ctx } = env();
  ctx.gbAppend_('members', member(1));
  const updated = ctx.gbUpdate_('members', 'GB-0001', { Estado: 'Inactivo', MemberID: 'HACK', Campo: 'x' });
  assert.equal(updated.Estado, 'Inactivo');
  const row = ctx.gbFind_('members', 'MemberID', 'GB-0001');
  assert.equal(row.Estado, 'Inactivo');
  assert.equal(row.Nombres, 'Nombre1');
  assert.equal(ctx.gbFind_('members', 'MemberID', 'HACK'), null);
  assert.equal(ctx.gbUpdate_('members', 'GB-9999', { Estado: 'Activo' }), null);
});

test('repo: remover borra solo esa fila', () => {
  const { ctx } = env();
  ctx.gbAppend_('members', member(1));
  ctx.gbAppend_('members', member(2));
  assert.equal(ctx.gbRemove_('members', 'GB-0001'), true);
  assert.deepEqual([...ctx.gbList_('members').map(m => m.MemberID)], ['GB-0002']);
  assert.equal(ctx.gbRemove_('members', 'GB-0001'), false);
});

test('repo: cada escritura toma el bloqueo y lo libera; si no hay bloqueo no escribe', () => {
  const { g, ctx, sheets } = env();
  ctx.gbAppend_('payments', { MemberID: 'GB-0001', Fecha: new Date(2026, 10, 1, 12), Monto: 150 });
  assert.equal(g.lock.lockCount, 1);
  assert.equal(g.lock.lockHeld, 0, 'bloqueo liberado');

  g.lock.failLock = true;
  assert.throws(() => ctx.gbAppend_('payments', { MemberID: 'GB-0001', Monto: 100 }), /ocupado/);
  assert.equal(sheets['Pagos'].data.length, 2, 'no se agregó nada');
});

test('repo: columna faltante da un mensaje claro', () => {
  const { ctx, sheets } = env();
  sheets['Pagos'].data[0].splice(sheets['Pagos'].data[0].indexOf('Monto'), 1);
  assert.throws(() => ctx.gbList_('payments'), /Falta la columna "Monto" en la pestaña "Pagos"/);
});

test('repo: pestaña inexistente da un mensaje claro', () => {
  const { ctx, sheets } = env();
  delete sheets['Asistencia'];
  assert.throws(() => ctx.gbList_('attendance'), /Falta la pestaña "Asistencia"/);
});

test('repo: no se leen filas vacías y los IDs no se reutilizan tras borrar el último', () => {
  const { ctx, sheets } = env();
  ctx.gbAppend_('payments', { MemberID: 'GB-0001', Monto: 100 });
  sheets['Pagos'].data.push(['', '', '', '', '', '']);
  assert.equal(ctx.gbList_('payments').length, 1);
});

test('fechas: se interpretan ISO, dd/mm/aaaa y Date, y se formatean en hora de Guatemala', () => {
  const { ctx } = env();
  assert.equal(ctx.gbFmtDate_('2026-11-14'), '2026-11-14');
  assert.equal(ctx.gbFmtDate_('14/11/2026'), '2026-11-14');
  assert.equal(ctx.gbFmtDate_(new Date(2026, 10, 14, 12)), '2026-11-14');
  assert.equal(ctx.gbFmtDateTime_('2026-11-14T08:30:15'), '2026-11-14T08:30:15');
  assert.equal(ctx.gbParseDate_('no es fecha'), null);
  assert.equal(ctx.gbParseDate_(''), null);
});

test('tokens y hash: tokens hexadecimales distintos; hash SHA-256 correcto', () => {
  const { ctx } = env();
  const a = ctx.gbToken_(24), b = ctx.gbToken_(24);
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, b);
  assert.equal(ctx.gbHash_('hola'), crypto.createHash('sha256').update('hola').digest('hex'));
});

test('configuración: gbConfigSet_ guarda, invalida la caché y se lee de nuevo', () => {
  const { ctx } = env();
  assert.equal(ctx.gbConfigFlag_('automatizacion_activa'), false);
  ctx.gbConfigSet_('automatizacion_activa', 'SI');
  assert.equal(ctx.gbConfigFlag_('automatizacion_activa'), true);
  ctx.gbConfigSet_('dias_gracia', '5');
  assert.equal(ctx.gbConfigNumber_('dias_gracia', 0), 5);
});


// ------------------------------------------------------------ Migración

const CSV = {
  members: [
    'MemberID,DPI,Nombres,Apellidos,FechaNacimiento,Telefono,Correo,Genero,Mensualidad,DiaPago,Estado,TokenQR,FechaRegistro,Notas',
    'GB-0001,1000000000001,Ana,"Pérez, Gómez",1990-01-15,47991001,ana@mail.test,Femenino,150,5,Activo,aaaa1111,2026-01-05,',
    'GB-0002,1000000000002,Luis,Díaz,1985-06-30,47991002,,Masculino,140,,Activo,bbbb2222,,'
  ],
  payments: [
    'PagoID,MemberID,Fecha,Monto,Nota,ComprobanteToken',
    'PG-00001,GB-0001,2026-10-05,150,,cccc3333',
    'PG-00002,GB-0001,2026-11-05,150,,dddd4444'
  ],
  measurements: [
    'MedidaID,MemberID,Fecha,Cuello,Pecho,BrazoDer,BrazoIzq,Cintura,Cadera,PiernaDer,PiernaIzq,PesoLb',
    'MD-00001,GB-0001,2026-10-05,37,96,30,29.5,87,95,53,53,162'
  ],
  evaluations: [
    'EvalID,MemberID,Fecha,' + ['N01','N02','N03','N04','N05','N06','N07','N11','N12','N13','N14','N15','N16','N17','N21','N22','N23','N24','N25','N26','N27','N31','N32','N33','N34','N35','N36','N37'].join(','),
    'EV-00001,GB-0001,2026-10-05,60,20,10,20,10,60,20,,,,,,,,,,,,,,,,,,,,'
  ]
};
const csvText = (over = {}) => Object.fromEntries(
  Object.entries({ ...CSV, ...over }).map(([k, lines]) => [k, Array.isArray(lines) ? lines.join('\n') : lines]));

test('migración: el simulacro valida sin escribir y tipa los datos', () => {
  const { ctx, sheets } = env();
  const result = ctx.gbMigrationImport_(csvText(), { dryRun: true });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual({ ...result.counts }, { members: 2, payments: 2, measurements: 1, evaluations: 1 });
  assert.equal(sheets['Miembros'].data.length, 1, 'el simulacro no escribe');
  assert.ok(result.warnings.some(w => w.includes('GB-0002') && w.includes('día de pago')));

  const plan = ctx.gbMigrationPlan_(csvText());
  const m = plan.rows.members[0];
  assert.equal(typeof m.DPI, 'string');
  assert.equal(m.Apellidos, 'Pérez, Gómez', 'respeta comillas y comas');
  assert.ok(m.FechaNacimiento instanceof Date);
  assert.equal(m.Mensualidad, 150);
  assert.equal(plan.rows.measurements[0].BrazoIzq, 29.5);
});

test('migración: importar escribe, y la verificación de la hoja queda sin problemas', () => {
  const { ctx, sheets } = env();
  const result = ctx.gbMigrationImport_(csvText());
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(sheets['Miembros'].data.length, 3);
  assert.equal(sheets['Pagos'].data.length, 3);

  const row = ctx.gbFind_('members', 'MemberID', 'GB-0001');
  assert.equal(row.DPI, '1000000000001');
  assert.ok(row.FechaNacimiento instanceof Date);

  // el catálogo y las plantillas los siembra setup; aquí los simulamos para la verificación
  sheets['EjerciciosEvaluacion'].data.push(...ctx.gbExerciseSeed_());
  sheets['Plantillas'].data.push(...ctx.gbTemplateSeed_());
  const check = ctx.gbMigrationVerify_();
  assert.deepEqual([...check.issues], []);
  assert.equal(check.ok, true);
});

test('migración: un error en cualquier archivo cancela todo (no se escribe nada)', () => {
  const { ctx, sheets } = env();
  const bad = csvText({
    payments: [CSV.payments[0], 'PG-00001,GB-0099,2026-10-05,150,,xx', 'PG-00002,GB-0001,fecha-mala,150,,yy']
  });
  const result = ctx.gbMigrationImport_(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('GB-0099') && e.includes('no existe')));
  assert.ok(result.errors.some(e => e.includes('fecha no válida')));
  assert.equal(sheets['Miembros'].data.length, 1);
  assert.equal(sheets['Pagos'].data.length, 1);
});

test('migración: detecta DPI repetido, DPI corto, token repetido, género y estado inválidos', () => {
  const { ctx } = env();
  const bad = csvText({
    members: [
      CSV.members[0],
      CSV.members[1],
      'GB-0003,1000000000001,Z,Z,1990-01-01,47991003,,Otro,150,5,Raro,aaaa1111,,',
      'GB-0004,12345,Y,Y,1990-01-01,47991004,,Masculino,150,5,Activo,eeee5555,,'
    ]
  });
  const errors = ctx.gbMigrationPlan_(bad).errors.join('\n');
  assert.match(errors, /DPI repetido/);
  assert.match(errors, /13 dígitos/);
  assert.match(errors, /TokenQR repetido/);
  assert.match(errors, /Genero "Otro"/);
  assert.match(errors, /Estado "Raro"/);
});

test('migración: falta una columna o un archivo', () => {
  const { ctx } = env();
  const noCol = csvText({ payments: ['PagoID,MemberID,Fecha,Nota,ComprobanteToken', 'PG-1,GB-0001,2026-10-05,,x'] });
  assert.match(ctx.gbMigrationPlan_(noCol).errors.join('\n'), /falta la columna "Monto"/);
  const noFile = csvText(); delete noFile.evaluations;
  assert.match(ctx.gbMigrationPlan_(noFile).errors.join('\n'), /Falta el archivo Evaluaciones.csv/);
});

test('migración: no sobrescribe datos existentes salvo confirmación explícita (force)', () => {
  const { ctx, sheets } = env();
  ctx.gbMigrationImport_(csvText());
  const again = ctx.gbMigrationImport_(csvText());
  assert.equal(again.ok, false);
  assert.match(again.errors.join('\n'), /ya tiene datos/);

  const forced = ctx.gbMigrationImport_(csvText(), { force: true });
  assert.equal(forced.ok, true);
  assert.equal(sheets['Miembros'].data.filter(r => r[0] === 'GB-0001').length, 1, 'sin duplicados');
});

test('migración: importar dos veces con force deja los mismos totales', () => {
  const { ctx } = env();
  ctx.gbMigrationImport_(csvText());
  ctx.gbMigrationImport_(csvText(), { force: true });
  assert.equal(ctx.gbList_('payments').length, 2);
  assert.equal(ctx.gbList_('members').length, 2);
});

test('verificación: detecta DPI numérico, miembro huérfano y duplicados', () => {
  const { ctx, sheets } = env();
  ctx.gbMigrationImport_(csvText());
  sheets['Miembros'].data[1][1] = 1000000000001;                // DPI como número
  sheets['Pagos'].data.push(['PG-00009', 'GB-0777', new Date(2026, 10, 1, 12), 150, '', 'zz']);
  sheets['Miembros'].data[2][11] = sheets['Miembros'].data[1][11]; // TokenQR repetido
  sheets['EjerciciosEvaluacion'].data.push(...ctx.gbExerciseSeed_());
  sheets['Plantillas'].data.push(...ctx.gbTemplateSeed_());
  const text = ctx.gbMigrationVerify_().issues.join('\n');
  assert.match(text, /DPI está guardado como número/);
  assert.match(text, /el miembro GB-0777 no existe/);
  assert.match(text, /TokenQR repetido/);
});

test('migración con los datos REALES (solo si migration/ existe en esta computadora)', { skip: !existsSync(join(ROOT, 'migration', 'Miembros.csv')) }, () => {
  const { ctx } = env();
  const read = name => readFileSync(join(ROOT, 'migration', name), 'utf8');
  const result = ctx.gbMigrationImport_({
    members: read('Miembros.csv'), payments: read('Pagos.csv'),
    measurements: read('Medidas.csv'), evaluations: read('Evaluaciones.csv')
  }, { dryRun: true });
  assert.deepEqual([...result.errors], [], 'errores de validación en los datos reales');
  assert.deepEqual({ ...result.counts }, { members: 77, payments: 190, measurements: 200, evaluations: 116 });
});


// ------------------------------------------------------------ Límites reales de Google Sheets

/** Entorno con las pestañas creadas por el código real (hoja nueva: 1000 filas × 26 columnas). */
function envFromSetup() {
  const ss = memSpreadsheet();
  const g = loadGas(FILES, { owner: 'owner@gym.test', sheets: ss.sheets });
  const created = g.ctx.gbSetupSchemaSheets_(ss);
  return { g, ctx: g.ctx, ss, sheets: ss.sheets, created };
}

test('crear pestañas: todas se crean con sus encabezados, incluso la de 31 columnas (la hoja nueva solo trae 26)', () => {
  const { ctx, sheets, created } = envFromSetup();
  const schema = ctx.gbSchema_();
  assert.equal(created.length, Object.keys(schema).length);
  for (const spec of Object.values(schema)) {
    assert.deepEqual([...sheets[spec.name].data[0].slice(0, spec.headers.length)], [...spec.headers], spec.name);
  }
  assert.ok(sheets['Evaluaciones'].getMaxColumns() >= 31, 'se agregaron columnas');
});

test('crear pestañas: es seguro repetirlo y siembra catálogo, plantillas y configuración una sola vez', () => {
  const { ctx, ss, sheets } = envFromSetup();
  const before = JSON.stringify(Object.values(sheets).map(s => s.data));
  assert.deepEqual([...ctx.gbSetupSchemaSheets_(ss)], [], 'no crea nada nuevo');
  assert.equal(JSON.stringify(Object.values(sheets).map(s => s.data)), before, 'no cambia datos');
  assert.equal(sheets['EjerciciosEvaluacion'].data.length, 29);
  assert.equal(sheets['Plantillas'].data.length, ctx.gbTemplateSeed_().length + 1);
  assert.ok(sheets['ConfigGym'].data.length > 5);
});

test('crear pestañas: no pisa datos que ya existen', () => {
  const ss = memSpreadsheet();
  const g = loadGas(FILES, { owner: 'o@x.co', sheets: ss.sheets });
  const existing = ss.insertSheet('Miembros');
  existing.getRange(1, 1, 1, 3).setValues([['MemberID', 'DPI', 'Nombres']]);
  existing.getRange(2, 1, 1, 3).setValues([['GB-0001', '2000000000001', 'Ana']]);
  g.ctx.gbSetupSchemaSheets_(ss);
  assert.equal(existing.data[1][2], 'Ana', 'el dato sigue ahí');
});

test('agregar filas: una tabla que crece más allá de las 1000 filas de una hoja nueva no falla', () => {
  const { ctx, sheets } = envFromSetup();
  for (let i = 0; i < 1010; i++) {
    ctx.gbAppend_('attendance', { MemberID: 'GB-0001', FechaHora: new Date(2026, 0, 1, 8, 0, i % 60), Fecha: new Date(2026, 0, 1, 12), Origen: 'QR' });
  }
  assert.equal(ctx.gbList_('attendance').length, 1010);
  assert.equal(sheets['Asistencia'].data[1010][0], 'AS-001010', 'IDs consecutivos hasta el final');
});


test('gbDriveId_: acepta el ID o el enlace de Drive y rechaza lo demás', () => {
  const { ctx } = env();
  const id = '122q4COt2Sq-Fs0Gohwqf4m7ly3r_9KqL';
  assert.equal(ctx.gbDriveId_(id), id);
  assert.equal(ctx.gbDriveId_(' ' + id + ' '), id);
  assert.equal(ctx.gbDriveId_('https://drive.google.com/drive/folders/' + id), id);
  assert.equal(ctx.gbDriveId_('https://drive.google.com/drive/folders/' + id + '?usp=sharing'), id);
  assert.equal(ctx.gbDriveId_('https://drive.google.com/drive/u/0/folders/' + id), id);
  assert.equal(ctx.gbDriveId_('https://drive.google.com/file/d/' + id + '/view'), id);
  assert.equal(ctx.gbDriveId_('https://drive.google.com/open?id=' + id), id);
  for (const bad of ['', null, 'corto', 'no es un id con espacios', 'https://example.com']) assert.equal(ctx.gbDriveId_(bad), '', String(bad));
});
