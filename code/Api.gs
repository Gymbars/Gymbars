/**
 * Api.gs — Única puerta de entrada del panel de administración.
 *
 * El navegador llama SIEMPRE a `gbApi(token, acción, args)`. Aquí se valida la
 * sesión y el rol antes de ejecutar nada. Las funciones que hacen el trabajo
 * son privadas (terminan en `_`), así que no se pueden invocar desde la consola.
 *
 * Para agregar una acción: escribe la función privada y regístrala en
 * `gbActions_()` con los roles que pueden usarla.
 */

/**
 * Registro de acciones. Se construye en cada llamada (barato) para evitar
 * depender del orden en que Apps Script carga los archivos.
 *
 * @return {Object<string,{roles:string[], fn:Function}>}
 */
function gbActions_() {
  var ADMIN = [GB_ROLES.ADMIN];
  var ANY = [GB_ROLES.ADMIN, GB_ROLES.COACH];

  var actions = {
    // --- Sitio web y sistema (solo Admin) ---
    cpGetData:       { roles: ADMIN, fn: cpGetData_ },
    cpSaveSite:      { roles: ADMIN, fn: cpSaveSite_ },
    cpSaveImages:    { roles: ADMIN, fn: cpSaveImages_ },
    cpSaveCarousel:  { roles: ADMIN, fn: cpSaveCarousel_ },
    cpSaveFeatures:  { roles: ADMIN, fn: cpSaveFeatures_ },
    cpSavePrograms:  { roles: ADMIN, fn: cpSavePrograms_ },
    cpSaveSchedule:  { roles: ADMIN, fn: cpSaveSchedule_ },
    cpSaveSocial:    { roles: ADMIN, fn: cpSaveSocial_ },
    cpListImages:    { roles: ADMIN, fn: cpListImages_ },
    cpUploadImage:   { roles: ADMIN, fn: cpUploadImage_ },
    cpCheckImages:   { roles: ADMIN, fn: cpCheckImages_ },
    cpRefreshCache:  { roles: ADMIN, fn: cpRefreshCache_ },
    cpSetupSheets:   { roles: ADMIN, fn: cpSetupSheets_ },
    cpBackup:        { roles: ADMIN, fn: cpBackup_ }
  };

  // Los módulos nuevos (miembros, pagos, asistencia, mensajes…) agregan aquí
  // sus acciones con `gbModuleActions_()` cuando existan.
  if (typeof gbModuleActions_ === 'function') {
    var extra = gbModuleActions_(ADMIN, ANY);
    Object.keys(extra).forEach(function (name) { actions[name] = extra[name]; });
  }
  return actions;
}

/**
 * Ejecuta una acción del panel.
 *
 * En caso de éxito devuelve el resultado tal cual. Si falla la autorización o la
 * acción no existe, lanza un Error (el cliente lo recibe en withFailureHandler).
 * Los problemas de sesión empiezan con "AUTH:" (el panel cierra la sesión y vuelve a
 * pedir el inicio de sesión); los de rol con "PERM:" (solo se muestra el aviso).
 *
 * @param {string} token Token de sesión del navegador.
 * @param {string} action Nombre de la acción (ver gbActions_).
 * @param {Array} [args] Argumentos de la acción.
 * @return {*}
 */
function gbApi(token, action, args) {
  var auth = gbAuth_(token);
  if (!auth.ok) {
    gbWarnOnce_('denied', 'Llamada rechazada a gbApi (' + String(action).substring(0, 40) + '): ' + (auth.error || 'sin sesión'));
    throw new Error('AUTH: ' + (auth.error || 'No autorizado.'));
  }

  var name = String(action == null ? '' : action);
  var registry = gbActions_();
  if (!Object.prototype.hasOwnProperty.call(registry, name)) {
    throw new Error('Acción no disponible: ' + name.substring(0, 60));
  }

  var def = registry[name];
  if (def.roles.indexOf(auth.role) === -1) {
    // PERM: la sesión es válida pero el rol no alcanza (el panel muestra el aviso sin cerrar sesión).
    throw new Error('PERM: Tu rol (' + auth.role + ') no tiene permiso para esta acción.');
  }

  GB_CTX_ = { email: auth.email, role: auth.role, method: auth.method };
  try {
    return def.fn.apply(null, Array.isArray(args) ? args : []);
  } finally {
    GB_CTX_ = null;
  }
}
