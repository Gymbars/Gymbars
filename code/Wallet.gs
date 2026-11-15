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

  var claims = {
    iss: cfg.email, aud: 'google', typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000), payload: payload
  };
  var signingInput = gbB64urlText_(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + gbB64urlText_(JSON.stringify(claims));
  var signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(signingInput, cfg.key)).replace(/=+$/, '');
  return 'https://pay.google.com/gp/v/save/' + signingInput + '.' + signature;
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
