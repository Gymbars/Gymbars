/**
 * Pages.gs — Páginas públicas que se comparten por enlace (sin iniciar sesión):
 *   ?comprobante=<token>               Boleta de pago
 *   ?reporte=medidas|evaluacion&m=&r=&s=  Reporte firmado (medidas o evaluación)
 *   ?carnet=<token>                    Carnet con el QR del miembro
 *
 * Cada enlace lleva un token aleatorio o una firma HMAC (Messaging.gs), así que solo
 * lo ve quien lo recibió. Nunca muestran el DPI. Un exceso de enlaces inválidos
 * bloquea temporalmente las consultas.
 *
 * Las páginas se arman como texto HTML con estilos propios (sin depender del sitio).
 */

function gbEsc_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function gbPageCss_() {
  return '<style>' +
    ':root{color-scheme:dark;--bg:#0b0c0e;--panel:#14161a;--line:rgba(242,240,235,.14);--text:#f2f0eb;--muted:#a9adb5;--acc:#a9afba;--ok:#7bd88f;--warn:#f0c060;--bad:#f08080}' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;padding:20px 16px 48px}' +
    '.wrap{max-width:560px;margin:0 auto}' +
    'h1{font-size:30px;font-weight:800;letter-spacing:-.01em;text-transform:uppercase;line-height:1.05;margin-bottom:6px}' +
    'h2{font-size:15px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px}' +
    '.brand{font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:14px;color:var(--muted);margin-bottom:18px}' +
    '.card{background:var(--panel);border:1px solid var(--line);padding:18px 18px;margin-top:14px}' +
    '.row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid var(--line)}' +
    '.row:first-child{border-top:0}.row span:first-child{color:var(--muted)}.row b{font-variant-numeric:tabular-nums}' +
    '.big{font-size:42px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05}' +
    '.muted{color:var(--muted);font-size:14px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
    '.spark{background:var(--panel);border:1px solid var(--line);padding:12px}' +
    '.spark small{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}' +
    '.spark b{font-size:20px;font-variant-numeric:tabular-nums}' +
    '.bar{height:10px;background:rgba(242,240,235,.1);margin:6px 0 2px}.bar i{display:block;height:100%;background:var(--acc)}' +
    'table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--line)}' +
    'th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}td.n{text-align:right;font-variant-numeric:tabular-nums}' +
    '.btn{display:block;text-align:center;background:var(--acc);color:#0b0c0e;font-weight:800;letter-spacing:.04em;text-transform:uppercase;text-decoration:none;padding:15px;margin-top:14px;border:0;width:100%;font-size:15px;cursor:pointer}' +
    '.btn.ghost{background:transparent;color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}' +
    '.qrbox{background:#fff;padding:14px;display:flex;justify-content:center;margin:18px 0}.qrbox img{width:min(100%,300px);height:auto;image-rendering:pixelated}' +
    '.foot{margin-top:28px;color:var(--muted);font-size:13px}' +
    '</style>';
}

/** Arma una página completa lista para devolver desde doGet. */
function gbPage_(title, bodyHtml, extraHead) {
  var gym = gbConfigGet_('nombre_gym', 'Gymbars');
  var html = '<!DOCTYPE html><html lang="es"><head><base target="_blank"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + gbEsc_(title) + ' · ' + gbEsc_(gym) + '</title>' + gbPageCss_() + (extraHead || '') + '</head><body>' +
    '<div class="wrap"><div class="brand">' + gbEsc_(gym) + '</div>' + bodyHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title + ' · ' + gym)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function gbPublicBlocked_() { return gbCounterPeek_('GB_BADLINK') >= 60; }

function gbInvalidLinkPage_() {
  gbCounter_('GB_BADLINK', 600);
  return gbPage_('Enlace no válido',
    '<h1>Enlace no válido</h1><p class="muted" style="margin-top:10px">Este enlace no existe o ya no está disponible. ' +
    'Pide uno nuevo al gimnasio.</p>');
}

function gbBlockedPage_() {
  return gbPage_('Intenta más tarde', '<h1>Demasiados intentos</h1><p class="muted" style="margin-top:10px">Espera unos minutos e inténtalo de nuevo.</p>');
}

function gbMoney_(n) {
  var v = Number(n) || 0;
  return 'Q' + (Math.round(v * 100) % 100 === 0 ? String(Math.round(v)) : v.toFixed(2));
}


// ============================================================
// ===  Boleta de pago  =======================================
// ============================================================

function gbVoucherPage_(token) {
  if (gbPublicBlocked_()) return gbBlockedPage_();
  token = String(token || '');
  if (!/^[0-9a-f]{24}$/.test(token)) return gbInvalidLinkPage_();

  var payment = gbFind_('payments', 'ComprobanteToken', token);
  var member = payment ? gbFind_('members', 'MemberID', payment.MemberID) : null;
  if (!payment || !member) return gbInvalidLinkPage_();

  var next = gbNextPaymentDate_(payment.Fecha, member.DiaPago);
  var body =
    '<h1>Boleta de pago</h1><p class="muted">Gracias por tu pago, ' + gbEsc_(String(member.Nombres).split(' ')[0]) + '.</p>' +
    '<div class="card"><div class="muted">Total pagado</div><div class="big">' + gbEsc_(gbMoney_(payment.Monto)) + '</div></div>' +
    '<div class="card">' +
      '<div class="row"><span>Atleta</span><b>' + gbEsc_(gbFullName_(member)) + '</b></div>' +
      '<div class="row"><span>Fecha de pago</span><b>' + gbEsc_(gbHumanDate_(payment.Fecha)) + '</b></div>' +
      '<div class="row"><span>Próximo pago</span><b>' + gbEsc_(gbHumanDate_(next)) + '</b></div>' +
      '<div class="row"><span>Boleta</span><b>' + gbEsc_(payment.PagoID) + '</b></div>' +
    '</div>' +
    '<p class="foot">Equipo ' + gbEsc_(gbConfigGet_('nombre_gym', 'Gymbars')) + '</p>';
  return gbPage_('Boleta de pago', body);
}


// ============================================================
// ===  Reportes (medidas / evaluación)  ======================
// ============================================================

function gbReportPage_(type, memberId, recordId, signature) {
  if (gbPublicBlocked_()) return gbBlockedPage_();
  if (['medidas', 'evaluacion'].indexOf(type) === -1 || !gbVerifyReportLink_(type, memberId, recordId, signature)) {
    return gbInvalidLinkPage_();
  }
  var member = gbFind_('members', 'MemberID', memberId);
  if (!member) return gbInvalidLinkPage_();
  return type === 'medidas' ? gbMeasurementsPage_(member, recordId) : gbEvaluationPage_(member, recordId);
}

/** Gráfica de línea mínima en SVG. @param {Array<{x:Date,y:number}>} points */
function gbSparkSvg_(points) {
  var w = 240, h = 64, pad = 6;
  if (!points.length) return '';
  var ys = points.map(function (p) { return p.y; });
  var min = Math.min.apply(null, ys), max = Math.max.apply(null, ys);
  var span = max - min || 1;
  var t0 = points[0].x.getTime(), t1 = points[points.length - 1].x.getTime(), tspan = t1 - t0 || 1;
  var coords = points.map(function (p, i) {
    var x = points.length === 1 ? w / 2 : pad + ((p.x.getTime() - t0) / tspan) * (w - pad * 2);
    var y = h - pad - ((p.y - min) / span) * (h - pad * 2);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  var line = coords.map(function (c) { return c[0] + ',' + c[1]; }).join(' ');
  var last = coords[coords.length - 1];
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img" aria-hidden="true">' +
    (coords.length > 1 ? '<polyline fill="none" stroke="#a9afba" stroke-width="2" points="' + line + '"/>' : '') +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="#f2f0eb"/></svg>';
}

function gbSignedDelta_(now, before, unit) {
  if (before === undefined || before === null || before === '') return '';
  var d = Math.round((now - before) * 10) / 10;
  if (d === 0) return '<span class="muted">sin cambio</span>';
  return '<span class="muted">' + (d > 0 ? '+' : '−') + Math.abs(d) + ' ' + unit + '</span>';
}

function gbMeasurementsPage_(member, recordId) {
  var current = gbFind_('measurements', 'MedidaID', recordId);
  if (!current || current.MemberID !== member.MemberID) return gbInvalidLinkPage_();
  var upTo = gbParseDate_(current.Fecha);

  var history = gbList_('measurements', function (x) {
    var d = gbParseDate_(x.Fecha);
    return x.MemberID === member.MemberID && d && d <= upTo;
  }).sort(function (a, b) { return gbParseDate_(a.Fecha) - gbParseDate_(b.Fecha); });
  var previous = history.length > 1 ? history[history.length - 2] : null;

  var cards = gbMeasureFields_().map(function (f) {
    var points = history.filter(function (x) { return x[f[1]] !== '' && x[f[1]] != null; })
      .map(function (x) { return { x: gbParseDate_(x.Fecha), y: Number(x[f[1]]) }; });
    var now = Number(current[f[1]]);
    var unit = f[1] === 'PesoLb' ? 'lb' : 'cm';
    return '<div class="spark"><small>' + gbEsc_(f[2]) + '</small><b>' + gbEsc_(now) + ' ' + unit + '</b> ' +
      gbSignedDelta_(now, previous ? Number(previous[f[1]]) : null, unit) + gbSparkSvg_(points) + '</div>';
  }).join('');

  var body =
    '<h1>Reporte de medidas</h1><p class="muted">' + gbEsc_(gbFullName_(member)) + ' · ' + gbEsc_(gbHumanDate_(current.Fecha)) + '</p>' +
    '<div class="grid" style="margin-top:18px">' + cards + '</div>' +
    '<p class="foot">Medidas en centímetros y peso en libras. ' + history.length + ' registro(s) hasta esta fecha. ' +
    'Equipo ' + gbEsc_(gbConfigGet_('nombre_gym', 'Gymbars')) + '</p>';
  return gbPage_('Reporte de medidas', body);
}

function gbEvaluationPage_(member, recordId) {
  var current = gbFind_('evaluations', 'EvalID', recordId);
  if (!current || current.MemberID !== member.MemberID) return gbInvalidLinkPage_();

  var catalog = gbEvaluationCatalogRows_();
  var scores = gbEvaluationScores_(current, catalog);
  var bars = [0, 1, 2, 3].map(function (level) {
    var s = scores['n' + level];
    var pct = s === '' ? 0 : Math.round(s * 100);
    return '<div style="margin-top:12px"><div class="row" style="border:0;padding:0"><span>Nivel ' + level + '</span><b>' +
      (s === '' ? '—' : pct + ' %') + '</b></div><div class="bar"><i style="width:' + Math.min(pct, 100) + '%"></i></div></div>';
  }).join('');

  var tables = [0, 1, 2, 3].map(function (level) {
    var rows = catalog.filter(function (c) { return c[1] === level; }).map(function (c) {
      var v = current[c[0]];
      var has = v !== '' && v != null;
      return '<tr><td>' + gbEsc_(c[2]) + '</td><td class="n">' + (has ? gbEsc_(Number(v)) : '—') + '</td><td class="n">' +
        gbEsc_(c[3]) + ' ' + gbEsc_(c[4]) + '</td></tr>';
    }).join('');
    return '<h2>Nivel ' + level + '</h2><table><tr><th>Ejercicio</th><th style="text-align:right">Resultado</th><th style="text-align:right">Meta</th></tr>' + rows + '</table>';
  }).join('');

  var body =
    '<h1>Evaluación física</h1><p class="muted">' + gbEsc_(gbFullName_(member)) + ' · ' + gbEsc_(gbHumanDate_(current.Fecha)) + '</p>' +
    '<div class="card">' + bars + '</div>' + tables +
    '<p class="foot">El puntaje de cada nivel suma el avance de cada ejercicio respecto a su meta y lo divide entre 7. ' +
    'Equipo ' + gbEsc_(gbConfigGet_('nombre_gym', 'Gymbars')) + '</p>';
  return gbPage_('Evaluación física', body);
}


// ============================================================
// ===  Carnet con QR  ========================================
// ============================================================

function gbCarnetPage_(token) {
  if (gbPublicBlocked_()) return gbBlockedPage_();
  token = String(token || '');
  if (!/^[0-9a-f]{24}$/.test(token)) return gbInvalidLinkPage_();

  var member = gbFind_('members', 'TokenQR', token);
  if (!member) return gbInvalidLinkPage_();

  var status = gbPaymentStatus_(member, gbLastPaymentMap_()[member.MemberID], gbToday_(), gbPaymentOptions_());
  var cls = status.code === 'vencido' ? 'bad' : (status.code === 'gracia' || status.code === 'por_vencer' ? 'warn' : 'ok');
  var wallet = gbWalletSaveUrl_(member);
  var qrText = gbQrText_(member.TokenQR);

  var body =
    '<h1>' + gbEsc_(gbFullName_(member)) + '</h1>' +
    '<p class="muted">Carnet de miembro · ' + gbEsc_(member.MemberID) + '</p>' +
    '<div class="qrbox"><img id="qrimg" alt="Código QR de asistencia" width="300" height="300"></div>' +
    '<div class="card"><div class="row"><span>Mensualidad</span><b class="' + cls + '">' + gbEsc_(status.label) + '</b></div>' +
    (status.nextDue ? '<div class="row"><span>Próximo pago</span><b>' + gbEsc_(gbHumanDate_(status.nextDue)) + '</b></div>' : '') + '</div>' +
    (wallet ? '<a class="btn" href="' + gbEsc_(wallet) + '" target="_blank" rel="noopener">Agregar a Google Wallet</a>' : '') +
    '<a class="btn ghost" id="dl" href="#" download="carnet-gymbars.png">Descargar mi QR</a>' +
    '<div class="card muted" style="font-size:14px"><b style="color:var(--text)">Cómo usarlo</b><br>' +
    'Muestra este código en el tablet de la entrada para registrar tu asistencia. ' +
    'Guárdalo en tu teléfono: mantén presionado el QR y elige guardar imagen. ' +
    'En iPhone 15 Pro o posterior, abre la imagen en Fotos, toca ⓘ y elige «Agregar pase a Wallet».</div>' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>' +
    '<script>(function(){' +
    'try{var qr=qrcode(0,"M");qr.addData(' + JSON.stringify(qrText) + ');qr.make();' +
    'var n=qr.getModuleCount(),cell=10,m=4,size=(n+m*2)*cell,c=document.createElement("canvas");c.width=c.height=size;' +
    'var x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,size,size);x.fillStyle="#000";' +
    'for(var r=0;r<n;r++)for(var k=0;k<n;k++)if(qr.isDark(r,k))x.fillRect((k+m)*cell,(r+m)*cell,cell,cell);' +
    'var url=c.toDataURL("image/png");document.getElementById("qrimg").src=url;document.getElementById("dl").href=url;' +
    '}catch(e){document.getElementById("qrimg").alt="No se pudo generar el código. Recarga la página."}})();</script>';
  return gbPage_('Carnet', body);
}
