# Cómo se despliega Gymbars

Dos entornos separados, un solo flujo de trabajo, y siempre una forma de volver atrás.

| | **Pruebas (staging)** | **Producción** |
| --- | --- | --- |
| Rama de git | `develop` | `master` |
| Hoja de cálculo | Una **copia** de la hoja con datos **inventados** | La hoja real |
| Proyecto de Apps Script | `1UYzMHyx…65NIS` (`code/.clasp.staging.json`) | `1bWpZQ9W…QKgTQ` (`code/.clasp.prod.json`) |
| Comando | `npm run deploy:staging` | `npm run deploy:prod` |
| Banner en el panel | **PRUEBAS** (amarillo) | ninguno |

> **Por qué una hoja aparte y no solo otro «ID de implementación»:** el script está ligado a la hoja. Dos
> implementaciones del mismo proyecto leen y escriben la **misma** hoja; un ensayo crearía pagos reales.
>
> **La implementación de producción es una sola y no cambia nunca de ID.** Su URL está dentro de los enlaces de
> WhatsApp, de los carnets y de la configuración del tablet. Solo se mueve a una versión más nueva.

## Cada cambio, de principio a fin

1. **Trabaja en una rama** y abre un *Pull Request* hacia `develop`. GitHub corre las verificaciones (CI):
   guardia de secretos/datos personales, sintaxis, 150+ pruebas y la prueba de interfaz en Chrome.
2. **Mezcla en `develop`** y despliega a pruebas: `npm run deploy:staging`.
3. **Prueba en la hoja de pruebas** (lista abajo).
4. **Pull Request de `develop` a `master`**, mezcla y ponle etiqueta: `git tag v1.2.0 && git push --tags`.
5. **Haz el respaldo** de la hoja real (panel → *Sistema* → *Respaldo*).
6. **Despliega a producción** desde `master`: `npm run deploy:prod`.
   El comando comprueba, prueba, publica, verifica el sitio publicado y, **si algo falla, vuelve solo** a la versión anterior.
7. Mira el sitio y el panel un momento. Si algo no te gusta: *Volver atrás* (abajo).

`npm run deploy:prod -- --dry-run` hace todas las comprobaciones **sin cambiar nada** (úsalo antes la primera vez).

### Qué comprueba el despliegue
Rama correcta · árbol limpio · lo local es igual a lo que hay en GitHub · pruebas en verde · (prod) confirmación del
respaldo · la implementación existe y está fijada a una versión · y, ya publicado: el JSON público trae el sitio **sin datos de
miembros**, un enlace falso se rechaza (prueba que el código nuevo está arriba), un tablet no emparejado es rechazado y el
panel carga.

## Volver atrás

* **Código** (lo normal, instantáneo, la URL no cambia). Si el despliegue falló, ya lo hizo solo. A mano:

  ```bash
  npx @google/clasp -P code/.clasp.prod.json deploy -i <ID_DE_IMPLEMENTACION> -V <VERSION_ANTERIOR>
  ```

  El comando de un despliegue exitoso imprime estas dos cifras. Sin la terminal: editor de Apps Script →
  *Implementar → Administrar implementaciones →* lápiz → *Versión* → elige la anterior → *Implementar*.
* **Datos**: casi nunca hace falta. Las pestañas nuevas solo se **agregan** (nada se borra) y la migración se niega a
  pisar datos, así que una versión vieja funciona con datos nuevos. Restaurar la hoja (*Archivo → Historial de versiones*)
  es el **último recurso**: no revierte el código del script y **borra todo lo registrado después** (pagos, visitas…).
  Prefiere corregir hacia adelante; si hay datos dañados, usa el respaldo del paso 5.

## Primera vez: preparar pruebas (una vez)

1. Hoja de pruebas = copia de la real (ya la tienes). Abre *Extensiones → Apps Script* y comprueba que el ID del proyecto
   coincide con `code/.clasp.staging.json`.
2. En ese proyecto: *Configuración del proyecto → Propiedades del script*:

   | Propiedad | Valor |
   | --- | --- |
   | `GB_ENV` | `staging` (activa el banner amarillo y permite cargar datos de ejemplo) |
   | `GYMBARS_IMAGE_FOLDER_ID` | El **ID** (o el enlace) de una carpeta de Drive **vacía** «Gymbars PRUEBAS». Sin esto, subir una imagen en pruebas la guardaría en la carpeta de **producción** |
   | `GB_REPORT_BASE_URL` | La URL `/exec` de la implementación de pruebas (paso 4) |

   *Qué es el ID de la carpeta:* lo que va después de `/folders/` en su dirección:
   `https://drive.google.com/drive/folders/`**`122q4COt2Sq-Fs0Gohwqf4m7ly3r_9KqL`**. Si pegas el enlace completo también funciona.
   **No** configures Google Wallet en pruebas (los pases de ambos entornos chocarían).
3. Sesión de clasp (una vez en tu computadora): `npx @google/clasp login`. Activa además la **API de Apps Script** en
   <https://script.google.com/home/usersettings>.
4. **Crea la implementación de pruebas** en el editor: *Implementar → Nueva implementación → Aplicación web*
   (Ejecutar como: **Yo** · Acceso: **Cualquier persona**). Copia su **ID de implementación** y su **URL `/exec`** a
   `tools/deploy.config.json` (sección `staging`).
5. `npm run deploy:staging` (sube el código y publica).
6. **Autoriza los permisos** (esto no se puede automatizar): en el editor de pruebas elige la función **`onOpen`**
   en la lista, pulsa *Ejecutar* y acepta los permisos nuevos, incluido el de enviar correo (las funciones que terminan en `_` son
   privadas y no aparecen en esa lista; con `onOpen` basta, porque Google pide todos los permisos del proyecto de una vez).
7. En la hoja de pruebas: *Gymbars → Crear pestañas faltantes*, *Gymbars → Cargar datos de ejemplo (solo pruebas)*, y agrégate en
   la pestaña `Usuarios`.

> En la hoja de pruebas **nunca** importes la migración real ni escribas datos de personas reales.

## Primera vez en producción
1. La implementación actual debe estar **fijada a una versión** (no «HEAD»): *Administrar implementaciones →* lápiz →
   *Versión: Nueva versión*. El comando se niega a desplegar si apunta a HEAD, porque no podría volver atrás.
2. Sigue el orden de `code/GESTION.md` («Primer arranque»): propiedades del script (`GB_REPORT_BASE_URL`, secreto de inicio
   de sesión), pestaña `Usuarios`, migración, tablet.
3. Tras el **primer** despliegue con permisos nuevos hay que **autorizarlos a mano** en el editor, igual que en pruebas.
4. Rota el secreto de inicio de sesión (ver `code/GESTION.md`, «Seguridad»); es lo que hace que el guardia deje de avisar.

## Lista de pruebas en staging (a mano, 10 minutos)
- [ ] Entrar al panel con tu cuenta; se ve el banner **PRUEBAS**.
- [ ] Miembros: crear uno, registrar un pago (sale la boleta con enlace), registrar medidas y una evaluación.
- [ ] Abrir los enlaces de boleta, reporte y carnet desde el teléfono; el QR del carnet se ve.
- [ ] Tablet: emparejar (Ajustes → Tablets) y escanear un carnet; la visita aparece en *Asistencia*.
- [ ] *Mensajes*: «Abrir WhatsApp» abre el chat con el texto listo.
- [ ] *Ajustes → Ver qué se prepararía hoy* (simulacro de la automatización).
- [ ] Entrar con una cuenta *Coach*: no ve montos ni el DPI completo.
- [ ] El sitio público se ve bien en el teléfono.

## Protección de ramas en GitHub (una vez, 3 minutos)
*Settings → Branches → Add rule* para `master` **y** `develop`: **Require a pull request before merging** y **Require status
checks to pass** (elige `Guardia, sintaxis y pruebas` y `Prueba de interfaz (Chrome)`). Así nadie (incluido tú) sube a `master`
algo que no pasó las verificaciones.

## Qué no es automático (a propósito)
* Autorizar permisos nuevos y poner propiedades del script: lo haces tú, una vez por entorno.
* El despliegue **no** corre en GitHub: necesitaría guardar allí tu sesión de Google, que podría cambiar producción. Si más
  adelante quieres desplegar pruebas desde GitHub, se puede añadir como un paso aparte con aprobación.
* Los datos nunca viajan con el código: cada hoja tiene los suyos.

## Problemas frecuentes
| Mensaje | Qué hacer |
| --- | --- |
| «No se pudo leer las implementaciones» | `npx @google/clasp login` y activa la API de Apps Script |
| «La implementación … no existe en ese proyecto» | El ID de `tools/deploy.config.json` no es de ese proyecto: `npx @google/clasp -P code/.clasp.staging.json deployments` |
| «Falta deploymentId/url» | Crea la implementación (paso 4 de la primera vez) y pega sus datos |
| «Lo que vas a desplegar no coincide con origin/…» | `git push` (o `git pull`) y vuelve a intentar |
| Las pruebas del sitio fallan justo después de publicar | Suele ser un retraso de propagación; el comando reintenta 5 veces. Si sigue fallando en prod, vuelve solo |
| «No se pudo crear la versión» | El código ya subió: en el editor *Implementar → Administrar implementaciones →* nueva versión |
