/**
 * Wallet.gs — Carnet del miembro y pase de Google Wallet.
 *
 * El pase es una tarjeta genérica con el QR del miembro. Se entrega como un enlace
 * "Agregar a Google Wallet": un JWT firmado (RS256) con la cuenta de servicio.
 * El enlace incluye la definición de la clase y del objeto, así que no hace falta
 * llamar a ninguna API de Google en el momento de crearlo.
 *
 * Configuración (Script Properties; ver README, "Google Wallet"):
 *   GB_WALLET_ISSUER_ID   ID de emisor de la Google Wallet Business Console
 *   GB_WALLET_SA          JSON completo de la clave de la cuenta de servicio
 *
 * Sin esa configuración la función devuelve '' y el carnet muestra solo el QR
 * (que en iPhone 15 Pro o posterior también se puede agregar a Wallet desde Fotos).
 */

function gbWalletConfig_() {
  var props = PropertiesService.getScriptProperties();
  var issuer = props.getProperty('GB_WALLET_ISSUER_ID');
  var raw = props.getProperty('GB_WALLET_SA');
  if (!issuer || !raw) return null;
  try {
    var sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    return { issuer: String(issuer).trim(), email: sa.client_email, key: sa.private_key };
  } catch (_) {
    return null;
  }
}

function gbWalletConfigured_() {
  return !!gbWalletConfig_();
}

function gbB64urlText_(text) {
  return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

/**
 * Enlace para agregar el carnet a Google Wallet ('' si no está configurado).
 * @param {Object} member Fila de Miembros.
 */
function gbWalletSaveUrl_(member) {
  var cfg = gbWalletConfig_();
  if (!cfg) return '';

  var gym = gbConfigGet_('nombre_gym', 'Gymbars');
  var classId = cfg.issuer + '.gymbars_member';
  var objectId = cfg.issuer + '.' + String(member.MemberID).replace(/[^A-Za-z0-9_-]/g, '_');
  var text = function (value) { return { defaultValue: { language: 'es', value: String(value) } }; };

  var payload = {
    genericClasses: [{ id: classId }],
    genericObjects: [{
      id: objectId,
      classId: classId,
      state: 'ACTIVE',
      cardTitle: text(gym),
      header: text(gbFullName_(member)),
      subheader: text('Carnet de miembro'),
      barcode: { type: 'QR_CODE', value: gbQrText_(member.TokenQR), alternateText: String(member.MemberID) },
      hexBackgroundColor: '#0b0c0e'
    }]
  };

  return 'https://pay.google.com/gp/v/save/' + gbWalletJwt_({
    iss: cfg.email, aud: 'google', typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000), payload: payload
  }, cfg.key);
}

/** JWT firmado con RS256 (la clave privada nunca sale del script). */
function gbWalletJwt_(claims, privateKey) {
  var signingInput = gbB64urlText_(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + gbB64urlText_(JSON.stringify(claims));
  var signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(signingInput, privateKey)).replace(/=+$/, '');
  return signingInput + '.' + signature;
}

/**
 * Acción del panel (Ajustes): comprueba la configuración de Google Wallet contra Google y dice qué falta.
 * Solo lee el emisor; no crea ni cambia nada y no devuelve datos secretos.
 */
function gbWalletCheck_() {
  var cfg = gbWalletConfig_();
  if (!cfg) return { ok: false, paso: 'config', message: 'Faltan las propiedades GB_WALLET_ISSUER_ID y GB_WALLET_SA, o el JSON de la clave no es válido.' };

  var now = Math.floor(Date.now() / 1000);
  var tokenRes = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: gbWalletJwt_({ iss: cfg.email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
        aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 300 }, cfg.key)
    }
  });
  if (tokenRes.getResponseCode() !== 200) {
    return { ok: false, paso: 'clave', message: 'Google no aceptó la clave de la cuenta de servicio (' + cfg.email + '). Puede estar eliminada o copiada incompleta: crea una clave nueva y pega el JSON completo en GB_WALLET_SA.' };
  }
  var token = JSON.parse(tokenRes.getContentText()).access_token;

  var res = UrlFetchApp.fetch('https://walletobjects.googleapis.com/walletobjects/v1/issuer/' + encodeURIComponent(cfg.issuer), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  var code = res.getResponseCode(), body = String(res.getContentText() || '');
  if (code === 200) {
    var name = '';
    try { name = JSON.parse(body).name || ''; } catch (_) {}
    return { ok: true, paso: 'listo', message: 'Conexión correcta con el emisor' + (name ? ' «' + name + '»' : '') + '. Si el emisor sigue en modo de prueba, solo las cuentas de Google agregadas como "Cuentas de prueba" pueden guardar el pase.' };
  }
  if (code === 403 && /has not been used|SERVICE_DISABLED|disabled/i.test(body)) {
    return { ok: false, paso: 'api', message: 'Activa "Google Wallet API" en el proyecto de Google Cloud de la cuenta de servicio.' };
  }
  if (code === 401 || code === 403) {
    return { ok: false, paso: 'acceso', message: 'La cuenta de servicio ' + cfg.email + ' no tiene acceso al emisor. En Google Pay y Wallet Console → Usuarios, invítala con rol Desarrollador o Administrador.' };
  }
  if (code === 404) {
    return { ok: false, paso: 'emisor', message: 'No existe un emisor con el ID ' + cfg.issuer + '. Revisa GB_WALLET_ISSUER_ID (es el número que aparece en la consola de Wallet).' };
  }
  return { ok: false, paso: 'otro', message: 'Google respondió ' + code + '. Intenta de nuevo en unos minutos.' };
}

/** Acción del panel: datos del carnet de un miembro (para mostrarlo o enviarlo). */
function gbCarnetInfo_(memberId) {
  var m = gbMemberOrThrow_(memberId);
  return {
    ok: true, nombre: gbFullName_(m), memberId: String(m.MemberID),
    enlace: gbCarnetLink_(m), qrTexto: gbQrText_(m.TokenQR),
    walletConfigurado: gbWalletConfigured_(), walletUrl: gbWalletSaveUrl_(m)
  };
}
