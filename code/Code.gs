/**
 * Gymbars — Google Apps Script Web App
 *
 * Migración de gymbarsgt.com (Firebase Hosting + Cloud Firestore) a
 * Google Sheets + Google Apps Script.
 *
 * La hoja de cálculo es la base de datos: cada pestaña es una "tabla" y el
 * sitio se arma en el servidor (getWebsiteData) antes de entregar el HTML.
 *
 * Pestañas usadas:
 *   Sitio            Clave | Valor                    (configuración general)
 *   Imágenes         Referencia | URL | Posición      (mapa de imágenes)
 *   Carrusel         Título | Descripción | Imagen | Orden
 *   Características  Título | Descripción | Imagen | Orden
 *   Programas        Título | Imagen | Orden
 *   ProgramaDetalle  Programa | Tipo | Orden | Texto  (instrucciones/ejercicios)
 *   Horario          Día | Turno | Horario | Color | Orden
 *   Redes            Nombre | Icono | URL | Orden
 *   Bitácora         Fecha | Tipo de evento | Estado | JSON
 */

/** ID de la hoja. Vacío = usar la hoja a la que está vinculado el script. */
var SPREADSHEET_ID = '';

/** Segundos de caché para los datos del sitio (0 = sin caché). */
var CACHE_SECONDS = 300;

/** Nombres de pestaña, en un solo lugar para no repetir strings. */
var SHEETS = {
  site: 'Sitio',
  images: 'Imágenes',
  carousel: 'Carrusel',
  features: 'Características',
  programs: 'Programas',
  programDetail: 'ProgramaDetalle',
  schedule: 'Horario',
  social: 'Redes',
  log: 'Bitácora'
};

var GOOGLE_AUTH_START_URL = 'https://script.google.com/macros/s/AKfycbylsbf7neFjN-jheFeWqCT8ihfLZFj5OiQI-NSgfGnGaT5y97HZVkjohbseppM1yRnO/exec';
var GOOGLE_AUTH_SHARED_SECRET = '38a01d228ceae777bba05516096f9e2f24131f0f5c7d42f00b03aeb00c6aff1c';


// ============================================================
// ===  BITÁCORA (logger compartido)  =========================
// ============================================================

/**
 * Agrega una fila a la pestaña "Bitácora".
 * Columnas: Fecha | Tipo de evento | Estado | JSON
 *
 * @param {string} tipoEvento Etiqueta corta: 'doGet', 'error', 'setup'...
 * @param {string} estado     'INFO', 'OK', 'ERROR'...
 * @param {string|Object} jsonData Mensaje u objeto a serializar.
 */
function log_(tipoEvento, estado, jsonData) {
  try {
    var sheet = ss_().getSheetByName(SHEETS.log);
    if (!sheet) return; // La pestaña debe existir; no la creamos para no ensuciar.
    var msg = (typeof jsonData === 'string') ? jsonData : JSON.stringify(jsonData);
    sheet.appendRow([
      Utilities.formatDate(new Date(), 'America/Guatemala', 'dd/MM/yyyy HH:mm:ss'),
      tipoEvento || '',
      estado || '',
      (msg || '').substring(0, 49999)
    ]);
  } catch (_) { /* el logger nunca debe romper el sitio */ }
}


// ============================================================
// ===  doGet  ================================================
// ============================================================

function doGet(e) {
  // Google Sign-In callback desde la app compañera (google-auth/).
  if (e && e.parameter && e.parameter.googleAuth) {
    var googleAuthResult = cpCompleteGoogleAuth_(
      e.parameter.googleAuth,
      e.parameter.sig,
      e.parameter.nonce
    );
    return cpGoogleAuthResultPage_(googleAuthResult);
  }

  // Diagnóstico: ¿funciona la cámara dentro de una página de Apps Script? (no usa datos)
  if (e && e.parameter && e.parameter.page === 'camera') return gbCameraTestPage_();

  // Comprobación de la instalación (la usa el despliegue): solo dice si faltan pestañas. No lee datos.
  if (e && e.parameter && e.parameter.api === 'health') return json_(gbHealth_());

  // Páginas que se comparten por enlace (comprobante, reporte, carnet): ver gbPublicRoute_ en Pages.gs.
  var shared = gbPublicRoute_(e);
  if (shared) return shared;

  // Endpoint JSON opcional: ?api=data (útil para depurar o consumir desde otro cliente).
  // Solo publica el contenido del sitio web; nunca datos de miembros.
  if (e && e.parameter && e.parameter.api === 'data') {
    return json_(getWebsiteData());
  }

  // Acceso al panel de administración desde la web: ?page=admin o ?admin
  if (e && e.parameter && (e.parameter.page === 'admin' || e.parameter.admin !== undefined)) {
    var adminTemplate = HtmlService.createTemplateFromFile('ConfigPanel/ConfigPanel');
    adminTemplate.activeTab = e.parameter.tab || 'progreso';
    adminTemplate.webAppUrl = getWebsiteUrl();
    adminTemplate.isWebApp = true;
    adminTemplate.googleAuthStartUrl = GOOGLE_AUTH_START_URL;
    try { adminTemplate.authCallbackUrl = ScriptApp.getService().getUrl(); } catch (_) { adminTemplate.authCallbackUrl = ''; }

    var siteTitle = 'Gymbars';
    try {
      var d = getWebsiteData();
      if (d && d.site && (d.site.tituloSEO || d.site.nombre)) {
        siteTitle = d.site.tituloSEO || d.site.nombre;
      }
    } catch (_) {}

    return adminTemplate.evaluate()
      .setTitle('Panel de Administración — ' + siteTitle)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  }

  var data = getWebsiteData();

  var template = HtmlService.createTemplateFromFile('Index');
  template.siteDataJson = safeJson_(data);
  template.webAppUrl = getWebsiteUrl();

  var output = template.evaluate()
    .setTitle(data.site.tituloSEO || data.site.nombre || 'Gymbars')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');

  // Favicon desde la hoja (si hay logo configurado en Imágenes > logo).
  var logo = data.images.logo && data.images.logo.url;
  if (logo) {
    try { output.setFaviconUrl(logo); } catch (_) {}
  }

  return output;
}

/**
 * Escáner de asistencia (tablet). Recibe JSON como texto: { action, device, code }.
 * El cliente envía "text/plain" para evitar la petición previa (preflight) de CORS.
 * Todo se valida en gbScanApi_ (token de dispositivo, límites de intentos).
 */
function doPost(e) {
  var payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (_) {
    return json_({ ok: false, error: 'Solicitud no válida.' });
  }
  return json_(gbScanApi_(payload));
}

/**
 * Serializa datos para incrustarlos en el HTML sin romper el <script>.
 */
function safeJson_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Respuesta JSON para ContentService.
 */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// ===  Helpers de plantillas  ================================
// ============================================================

/**
 * Incluye un archivo HTML dentro de otro (partials).
 *
 * @param {string} filename Ruta sin extensión, ej. 'Navbar/Navbar'.
 * @param {Object} [args] Variables extra para la plantilla.
 * @return {string} HTML renderizado.
 */
function include(filename, args) {
  var template = HtmlService.createTemplateFromFile(filename);
  if (args) {
    for (var key in args) {
      if (Object.prototype.hasOwnProperty.call(args, key)) template[key] = args[key];
    }
  }
  return template.evaluate().getContent();
}


// ============================================================
// ===  Utilidades del proyecto  ==============================
// ============================================================

/**
 * Devuelve la hoja de cálculo del proyecto.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function ss_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * URL pública del Web App (para compartir o poner en el dominio propio).
 * @return {string}
 */
function getWebsiteUrl() {
  try {
    var d = getWebsiteData();
    if (d && d.site && d.site.dominio) {
      return String(d.site.dominio).trim().replace(/\/+$/, '');
    }
  } catch (_) {}
  try {
    var prop = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
    if (prop) return prop.replace(/\/+$/, '');
  } catch (_) {}
  try {
    var url = ScriptApp.getService().getUrl();
    if (url) return url.replace(/\/u\/\d+/, '');
  } catch (_) {}
  return 'https://gymbarsgt.com';
}

/**
 * Fuerza a releer la hoja en la siguiente carga (borra la caché).
 */
function refreshData_() {
  CacheService.getScriptCache().remove('gymbars:data');
  return 'Caché del sitio eliminada.';
}

/**
 * Menú de la hoja de cálculo.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Gymbars')
    .addItem('Abrir panel de administración', 'showAdminPanel')
    .addItem('Miembros y pagos', 'gbOpenMembersPanel_')
    .addItem('Mensajes pendientes', 'gbOpenMessagesPanel_')
    .addItem('Asistencia de hoy', 'gbOpenAttendancePanel_')
    .addItem('Progreso', 'gbOpenProgressPanel_')
    .addSeparator()
    .addItem('Abrir sitio web', 'showWebsiteUrl_')
    .addItem('Crear pestañas faltantes', 'setupSheets_')
    .addItem('Limpiar caché del sitio', 'refreshData_')
    .addSeparator()
    .addItem('Migración: simulacro (no escribe)', 'gbMigrationDryRunMenu_')
    .addItem('Migración: importar datos del Excel', 'gbMigrationImportMenu_')
    .addItem('Verificar datos migrados', 'gbMigrationVerifyMenu_')
    .addItem('Cargar datos de ejemplo (solo pruebas)', 'gbSeedDemoMenu_')
    .addToUi();
}

// Atajos de la hoja: abren el panel completo (con todas las funciones) en cada sección.
function gbOpenMembersPanel_() { showAdminPanel('miembros'); }
function gbOpenMessagesPanel_() { showAdminPanel('mensajes'); }
function gbOpenAttendancePanel_() { showAdminPanel('asistencia'); }
function gbOpenProgressPanel_() { showAdminPanel('progreso'); }

function showWebsiteUrl_() {
  var url = getWebsiteUrl();
  SpreadsheetApp.getUi().alert('Sitio web', url, SpreadsheetApp.getUi().ButtonSet.OK);
}


// ============================================================
// ===  setupSheets  ==========================================
// ============================================================

/**
 * Crea las pestañas que falten con sus encabezados.
 * No borra ni sobrescribe datos existentes: solo agrega lo que falta.
 * Ejecutar una vez después de crear la hoja (o desde el menú Gymbars).
 */
function setupSheets_() {
  var ss = ss_();
  var specs = [
    { name: SHEETS.site,            headers: ['Clave', 'Valor'] },
    { name: SHEETS.images,          headers: ['Referencia', 'URL', 'Posición', 'ArchivoDrive', 'Ajuste'] },
    { name: SHEETS.carousel,        headers: ['Título', 'Descripción', 'Imagen', 'Orden'] },
    { name: SHEETS.features,        headers: ['Título', 'Descripción', 'Imagen', 'Orden'] },
    { name: SHEETS.programs,        headers: ['Título', 'Imagen', 'Orden'] },
    { name: SHEETS.programDetail,   headers: ['Programa', 'Tipo', 'Orden', 'Texto'] },
    { name: SHEETS.schedule,        headers: ['Día', 'Turno', 'Horario', 'Color', 'Orden'] },
    { name: SHEETS.social,          headers: ['Nombre', 'Icono', 'URL', 'Orden'] },
    { name: SHEETS.log,             headers: ['Fecha', 'Tipo de evento', 'Estado', 'JSON'] }
  ];

  var created = [];
  specs.forEach(function (spec) {
    var sheet = ss.getSheetByName(spec.name);
    if (!sheet) {
      sheet = ss.insertSheet(spec.name);
      created.push(spec.name);
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(spec.headers);
      sheet.getRange(1, 1, 1, spec.headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });

  // Pestañas del sistema de gestión (miembros, pagos, asistencia, mensajes…).
  created = created.concat(gbSetupSchemaSheets_(ss));

  log_('setupSheets', 'OK', created.length ? 'Creadas: ' + created.join(', ') : 'Sin cambios');
  return created.length ? 'Pestañas creadas: ' + created.join(', ') : 'Todo estaba en su lugar.';
}
