/**
 * Reglas del guardia del repositorio: nada de datos personales ni secretos en git.
 * Funciones puras (se prueban con archivos falsos); tools/guard.mjs las usa con `git ls-files`.
 */

/** Rutas que nunca deben estar en git (datos personales, credenciales). */
export const FORBIDDEN_PATHS = [
  [/^migration\//, 'datos personales de la migración (DPI, teléfonos)'],
  [/\.(xlsx|xlsm|xls)$/i, 'archivo de Excel (puede traer datos de miembros)'],
  [/(^|\/)\.clasprc\.json$/, 'credenciales de clasp'],
  [/(^|\/)\.env(\..*)?$/, 'variables de entorno'],
  [/\.(pem|p12|pfx|key)$/i, 'clave privada']
];

/** Textos que parecen secretos. */
export const SECRET_PATTERNS = [
  ['ctx7sk', /ctx7sk-[A-Za-z0-9-]{16,}/],
  ['llave-privada', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['clave-api-google', /AIza[0-9A-Za-z_-]{35}/],
  ['secreto-hex', /(?:SECRET|TOKEN|KEY)[A-Z_]*\s*=\s*['"][0-9a-f]{40,}['"]/],
  ['cuenta-de-servicio', /"private_key"\s*:\s*"-----BEGIN/]
];

/**
 * @param {string[]} files rutas rastreadas por git
 * @param {(path:string)=>(string|null)} readFile texto del archivo (null si es binario o no existe)
 * @param {{file:string, pattern:string, why?:string}[]} baseline hallazgos conocidos (se avisan, no fallan)
 * @return {{errors:string[], warnings:string[]}}
 */
export function scanRepository(files, readFile, baseline = []) {
  const errors = [], warnings = [];
  const known = new Set(baseline.map(b => `${b.file}::${b.pattern}`));
  const seen = new Set();

  for (const file of files) {
    for (const [re, why] of FORBIDDEN_PATHS) {
      if (re.test(file)) errors.push(`${file}: no debe estar en git (${why}).`);
    }
    const text = readFile(file);
    if (text == null) continue;
    for (const [name, re] of SECRET_PATTERNS) {
      if (!re.test(text)) continue;
      const key = `${file}::${name}`;
      seen.add(key);
      if (known.has(key)) warnings.push(`${file}: secreto conocido «${name}» (en la lista base; rótalo y quítalo).`);
      else errors.push(`${file}: parece contener un secreto («${name}»). Si es real, rótalo y no lo subas.`);
    }
  }
  for (const b of baseline) {
    if (!seen.has(`${b.file}::${b.pattern}`)) warnings.push(`${b.file}: el hallazgo «${b.pattern}» ya no aparece; quítalo de tools/guard-baseline.json.`);
  }
  return { errors, warnings };
}
