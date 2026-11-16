/**
 * Auth.gs — Autenticación y roles del panel (verificación SIEMPRE en el servidor).
 *
 * Problema que resuelve: el Web App se ejecuta como el propietario y es público,
 * así que cualquiera que abra el sitio puede llamar funciones globales con
 * `google.script.run`. Por eso:
 *
 *   1. Todo lo sensible vive en funciones privadas (terminan en `_`), que el
 *      navegador no puede invocar.
 *   2. La única puerta es `gbApi(token, acción, args)` (Api.gs), que valida la
 *      sesión y el rol en cada llamada.
 *
 * Roles (pestaña "Usuarios": Email | Rol | Activo):
 *   Admin  Todo: sitio web, miembros, pagos, mensajes, dispositivos, usuarios.
 *   Coach  Miembros, medidas, evaluaciones, asistencia, mensajes, progreso.
 *
 * El propietario de la hoja siempre es Admin. Mientras la pestaña "Usuarios" no
 * tenga filas activas, los editores de la hoja son Admin (compatibilidad con el
 * comportamiento anterior). Los LECTORES de la hoja ya no tienen acceso.
 */

var GB_ROLES = { ADMIN: 'Admin', COACH: 'Coach' };

/** Prefijo de las sesiones guardadas en Script Properties. */
var GB_SESSION_PREFIX = 'CP_SESSION_';

/**
 * Entorno de este proyecto: 'staging' (pruebas) o 'produccion'.
 * Se lee de la propiedad del script GB_ENV; sin ella es producción. Es una propiedad (no una
 * celda de la hoja) para que una COPIA de la hoja no herede el entorno por error.
 */
function gbEnvironment_() {
  var value = '';
  try { value = String(PropertiesService.getScriptProperties().getProperty('GB_ENV') || '').trim().toLowerCase(); } catch (_) {}
  return value === 'staging' ? 'staging' : 'produccion';
}

/** Contexto de la llamada en curso (lo fija gbApi). Solo lectura para handlers. */
var GB_CTX_ = null;

function gbCtx_() {
  return GB_CTX_ || { email: '', role: '' };
}

/**
 * Secreto compartido con la app de inicio de sesión (gymbars-auth).
 * Se lee de Script Properties (GOOGLE_AUTH_SHARED_SECRET); si no existe usa el
 * valor histórico de Code.gs para no romper el acceso. Rotación: ver README.
 */
function gbAuthSecret_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('GOOGLE_AUTH_SHARED_SECRET');
  if (fromProps) return fromProps;
  gbWarnOnce_('legacy-secret', 'El secreto de inicio de sesión sigue siendo el valor guardado en el código. Rótalo (README, "Seguridad").');
  return GOOGLE_AUTH_SHARED_SECRET;
}

/** Escribe una advertencia en Bitácora como máximo una vez por hora. */
function gbWarnOnce_(key, message) {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('GB_WARN_' + key)) return;
    cache.put('GB_WARN_' + key, '1', 3600);
    log_('seguridad', 'WARN', message);
  } catch (_) {}
}


// ============================================================
// ===  Roles  ================================================
// ============================================================

function gbNormEmail_(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

function gbNormRole_(value) {
  var v = String(value == null ? '' : value).trim().toLowerCase();
  if (v === 'admin' || v === 'administrador') return GB_ROLES.ADMIN;
  if (v === 'coach' || v === 'entrenador') return GB_ROLES.COACH;
  return '';
}

/** Filas de la pestaña "Usuarios" ([] si no existe o está vacía). */
function gbUsuarios_() {
  var sheet = ss_().getSheetByName('Usuarios');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var out = [];
  values.forEach(function (row) {
    var email = gbNormEmail_(row[0]);
    if (!email) return;
    var activeText = String(row[2] == null ? '' : row[2]).trim().toLowerCase();
    var active = !(activeText === 'no' || activeText === 'false' || activeText === '0' || activeText === 'inactivo');
    out.push({ email: email, role: gbNormRole_(row[1]), active: active });
  });
  return out;
}

/**
 * Rol de un correo ('Admin', 'Coach' o '' si no tiene acceso).
 * Resultado en caché 60 s para no consultar permisos de Drive en cada llamada.
 */
function gbResolveRole_(email) {
  email = gbNormEmail_(email);
  if (!email) return '';

  var cache = CacheService.getScriptCache();
  var key = 'GB_ROLE_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email)).substring(0, 24);
  var cached = cache.get(key);
  if (cached !== null) return cached === '-' ? '' : cached;

  var role = gbResolveRoleUncached_(email);
  cache.put(key, role || '-', 60);
  return role;
}

function gbResolveRoleUncached_(email) {
  var ss = ss_();

  // 1. Propietario de la hoja: siempre Admin.
  try {
    var owner = ss.getOwner();
    if (owner && gbNormEmail_(owner.getEmail()) === email) return GB_ROLES.ADMIN;
  } catch (e1) {
    log_('auth', 'WARN', 'getOwner: ' + e1);
  }

  // 2. Lista de usuarios autorizados.
  var rows = gbUsuarios_();
  var activeRows = rows.filter(function (r) { return r.active && r.role; });
  for (var i = 0; i < activeRows.length; i++) {
    if (activeRows[i].email === email) return activeRows[i].role;
  }
  if (activeRows.length) return ''; // hay lista: lo que no esté en ella no entra

  // 3. Sin lista todavía: los editores de la hoja son Admin (no los lectores).
  try {
    var editors = ss.getEditors();
    for (var j = 0; j < editors.length; j++) {
      if (gbNormEmail_(editors[j].getEmail()) === email) return GB_ROLES.ADMIN;
    }
  } catch (e2) {
    log_('auth', 'WARN', 'getEditors: ' + e2);
  }
  return '';
}


// ============================================================
// ===  Sesión  ===============================================
// ============================================================

/**
 * Valida al usuario de la llamada actual.
 *
 * @param {string} [token] Token de sesión (Google Sign-In).
 * @return {{ok:boolean, email?:string, role?:string, method?:string,
 *           needLogin?:boolean, unauthorized?:boolean, error?:string}}
 */
function gbAuth_(token) {
  // 1. Usuario activo de Google (diálogo dentro de la hoja o mismo dominio).
  try {
    var activeEmail = gbNormEmail_(Session.getActiveUser().getEmail());
    if (activeEmail) {
      var activeRole = gbResolveRole_(activeEmail);
      if (activeRole) return { ok: true, email: activeEmail, role: activeRole, method: 'activeUser' };
    }
  } catch (_) {}

  // 2. Token de sesión.
  token = String(token || '');
  if (!token) {
    return { ok: false, needLogin: true, error: 'Inicia sesión con tu cuenta de Google.' };
  }
  if (!/^[A-Za-z0-9-]{20,64}$/.test(token)) {
    return { ok: false, needLogin: true, error: 'Sesión no válida. Inicia sesión con Google.' };
  }

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(GB_SESSION_PREFIX + token);
  if (!raw) {
    return { ok: false, needLogin: true, error: 'Sesión expirada o no válida. Inicia sesión con Google.' };
  }

  var session;
  try { session = JSON.parse(raw); } catch (_) {
    return { ok: false, needLogin: true, error: 'Error al validar la sesión.' };
  }

  if (!session || Date.now() > Number(session.expiry)) {
    props.deleteProperty(GB_SESSION_PREFIX + token);
    return { ok: false, needLogin: true, error: 'Sesión expirada.' };
  }

  var email = gbNormEmail_(session.email);
  var role = gbResolveRole_(email);
  if (!role) {
    return {
      ok: false,
      unauthorized: true,
      email: email,
      error: 'La cuenta ' + email + ' no tiene acceso al panel. Pide al administrador que la agregue en la pestaña "Usuarios".'
    };
  }
  return { ok: true, email: email, role: role, method: 'session' };
}

/** Borra las sesiones vencidas (se llama al iniciar sesión). */
function gbPurgeSessions_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var now = Date.now();
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(GB_SESSION_PREFIX) !== 0) return;
      try {
        var s = JSON.parse(all[key]);
        if (!s || now > Number(s.expiry)) props.deleteProperty(key);
      } catch (_) {
        props.deleteProperty(key);
      }
    });
  } catch (e) {
    log_('auth', 'WARN', 'purge sesiones: ' + e);
  }
}

/**
 * Usada por el panel al abrirse para saber si hay acceso (no revela datos).
 * Devuelve el mismo formato que antes y agrega el rol.
 *
 * @param {string} [token]
 * @return {Object}
 */
function cpVerifyAdminAccess(token) {
  var a = gbAuth_(token);
  if (a.ok) {
    return { success: true, authorized: true, email: a.email, role: a.role, method: a.method, entorno: gbEnvironment_() };
  }
  if (a.unauthorized) {
    return { success: true, authorized: false, unauthorized: true, email: a.email, error: a.error };
  }
  return { success: true, authorized: false, needLogin: true, error: a.error };
}

/**
 * Para funciones del menú de la hoja (se ejecutan como el usuario que hizo clic):
 * exige que sea Admin. Lanza un Error con mensaje claro si no lo es.
 */
function gbRequireAdminForMenu_() {
  var a = gbAuth_('');
  if (!a.ok || a.role !== GB_ROLES.ADMIN) {
    throw new Error('Solo un Admin puede ejecutar esta acción.');
  }
  return a;
}
