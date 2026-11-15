# Sistema de gestión del gimnasio

Miembros, pagos, medidas, evaluaciones, asistencia con QR y mensajes, sobre la misma hoja
de cálculo y el mismo panel de administración del sitio. Reemplaza al Excel
`CONTROL GYMBRAS.xlsm`.

Todo se puede usar **desde el panel web** (`?page=admin`) y **desde la propia hoja**:
el menú **Gymbars** abre el mismo panel como ventana dentro de Google Sheets
(Miembros y pagos, Mensajes pendientes, Asistencia de hoy, Progreso) y todas las
pestañas de datos se pueden revisar y corregir a mano, con listas desplegables y formato.

## Qué hay en el panel

| Pestaña | Para qué | Quién |
| --- | --- | --- |
| **Progreso** | A quién atender hoy (pago vencido, sin asistir, medidas pendientes), visitas por semana | Admin, Coach |
| **Miembros** | Buscar; ficha con datos, pagos, medidas, evaluaciones; alta y edición; enviar mensajes | Admin, Coach |
| **Asistencia** | Quién vino hoy; registrar una visita a mano | Admin, Coach |
| **Mensajes** | Bandeja de boletas, reportes y recordatorios listos para enviar | Admin, Coach |
| **Ajustes** | Automatización, tablets de asistencia, plantillas, configuración | Solo Admin |
| Sitio, Imágenes, … | El sitio web (como antes) | Solo Admin |

## Pestañas de la hoja (datos)

Las crea **Gymbars → Crear pestañas faltantes** (no borra nada). Definidas en `Schema.gs`.

| Pestaña | Contenido |
| --- | --- |
| `Miembros` | MemberID, DPI, nombres, teléfono (8 dígitos), correo, género, mensualidad, día de pago, estado, TokenQR… |
| `Pagos` | Cada pago, con un token propio para su boleta |
| `Medidas` | Cuello, pecho, brazos, cintura, cadera, piernas y peso (libras) |
| `Evaluaciones` / `EjerciciosEvaluacion` | Resultados N01…N37 y el catálogo con la meta de cada ejercicio |
| `Asistencia` | Cada visita (QR o manual) |
| `Dispositivos` | Tablets autorizados (solo se guarda un hash de su token) |
| `Mensajes` / `Plantillas` | La bandeja y los textos |
| `ConfigGym` | Ajustes (días de gracia, aviso, automatización…) |
| `Usuarios` | Quién puede entrar al panel y con qué rol |

> Los datos personales (DPI, teléfonos, fechas de nacimiento) viven solo en estas pestañas.
> Nunca se incluyen en `getWebsiteData()` ni en `?api=data` (hay una prueba que lo verifica).

## Primer arranque (lista de pasos)

1. **Subir y publicar** con `npm run deploy:staging` / `npm run deploy:prod` (ver [`../DEPLOY.md`](../DEPLOY.md)). Los permisos
   cambiaron (`script.send_mail`), así que hay que **volver a autorizar** una vez en el editor (función `onOpen`).
2. En la hoja: **Gymbars → Crear pestañas faltantes**.
3. **Usuarios**: escribir `Email | Rol | Activo` (`Admin` o `Coach`). El propietario de la hoja es
   siempre Admin. Mientras la pestaña esté vacía, los *editores* de la hoja entran como Admin;
   los *lectores* nunca entran.
4. **Propiedades del script** (Configuración del proyecto → Propiedades del script):

   | Propiedad | Para qué |
   | --- | --- |
   | `GB_REPORT_BASE_URL` | URL del Web App (termina en `/exec`). **Obligatoria**: va dentro de los enlaces de boletas, reportes y carnets |
   | `GOOGLE_AUTH_SHARED_SECRET` | Secreto del inicio de sesión (ver «Seguridad»). Recomendada |
   | `GB_WALLET_ISSUER_ID`, `GB_WALLET_SA` | Opcionales: pase de Google Wallet |
   | `GB_LINK_SECRET` | Se crea sola (firma de los enlaces de reportes) |

5. **Migrar los datos** del Excel (siguiente sección).
6. **Tablet de asistencia**: ver `checkin/README.md`.
7. **Automatización**: en Ajustes, *Revisar estados* (pasa a *Inactivo* a quien ya no viene) y
   después *Encender*. Empieza **apagada** a propósito.

## Migrar el Excel

```bash
python3 tools/migrate-xlsm.py "CONTROL GYMBRAS.xlsm"     # lee el xlsm, no lo modifica
```

Genera `migration/` (**ignorada por git**: tiene DPI, teléfonos y fechas de nacimiento) con 4 CSV y un
`reporte.json`. Súbela a una carpeta **privada** de Drive y, en la hoja:

1. **Gymbars → Migración: simulacro** (valida todo sin escribir; si algo falla no se importa nada).
2. **Gymbars → Migración: importar datos del Excel** (pide el enlace de la carpeta).
3. **Gymbars → Verificar datos migrados**.
4. Borra la carpeta de Drive y `migration/` al terminar. Conserva el xlsm hasta cerrar un ciclo de cobro.

Reglas de la migración: la clave interna es `MemberID` (el DPI es un campo); los teléfonos quedan de 8
dígitos (el `502` se agrega al armar el enlace de WhatsApp); todos entran como *Activo*; cada miembro recibe
un `TokenQR` aleatorio. Las filas huérfanas (por ejemplo, medidas de un DPI que no existe) van a
`rechazados.csv` y no se importan.

## Roles y privacidad

* **Admin**: todo. **Coach**: miembros, medidas, evaluaciones, asistencia y mensajes; **no** ve montos ni
  historial de pagos, no ve el DPI completo (últimos 4 dígitos), no elimina miembros y no toca el sitio ni los ajustes.
* El panel oculta lo que el rol no puede usar, pero **la verificación real es del servidor** en cada llamada
  (`Auth.gs` + `Api.gs`). Un rol sin permiso recibe `PERM:`; una sesión vencida, `AUTH:`.
* El QR del carnet **no contiene el DPI**: es `GB1:` + 24 caracteres aleatorios.

## Mensajes (sin costo)

WhatsApp no tiene API gratuita. Por eso cada mensaje se deja **listo en la bandeja** con su texto y un
enlace `wa.me`; la persona toca **Abrir WhatsApp**, envía y marca **Ya lo envié**. Los **correos** (si el
miembro tiene) salen solos con `MailApp`. `wa.me` no adjunta archivos, así que boletas y reportes se
comparten como **enlaces**:

* `?comprobante=<token>` boleta de pago · `?reporte=medidas|evaluacion&…` reporte firmado ·
  `?carnet=<token>` carnet con el QR (y botón de Google Wallet).

Variables de las plantillas: `{nombre} {gym} {fecha} {monto} {proximoPago} {enlace} {dias}`. Se editan en
**Ajustes → Plantillas de mensajes**. Tipos: boleta, recordatorio de pago, pago vencido, inactividad,
progreso, medidas, evaluación, carnet.

## Automatización diaria

Un disparador diario ejecuta `gbDailyJob`. Con la automatización **encendida** crea (sin repetir) en la bandeja:
recordatorio (vence en ≤ N días), aviso de vencido (pasados los días de gracia), inactividad (membresía vigente
y ≥ N días sin asistir, **solo si el control de asistencia ya está en uso**) y seguimiento de medidas
(solo a quien ya tiene medidas). *Ver qué se prepararía hoy* muestra el lote sin guardar nada.

## Comportamiento común del panel

- **Carga unificada:** una barra fina arriba (visible también sobre las ventanas), la zona activa se atenúa y los datos aparecen como esqueleto gris; no hay textos «Cargando…».
- **Sin doble clic:** mientras una acción que guarda está en curso, la ventana queda bloqueada y una segunda petición idéntica se ignora.
- **Avisos:** todo error o confirmación sale como aviso (toast); los errores inesperados del navegador también.
- **Búsqueda de miembros:** filtra mientras escribes usando la lista en memoria (sin tildes ni mayúsculas, sin llamar al servidor). El entrenador no tiene el DPI completo en su lista: si escribe uno completo, el servidor lo busca. Mismo buscador en Miembros y Asistencia; Enter abre el primer resultado.
- **Carnet:** el aviso de Wallet de Apple solo aparece en iPhone; el botón de Google Wallet solo si está configurado.

## Reglas de negocio (del Excel)

* **Próximo pago**: el mismo día del mes siguiente (si no existe ese día, el último del mes).
* **Estado de pago**: al día · por vencer · en gracia · vencido · sin pagos (días configurables).
* **Puntaje de un nivel**: suma de (resultado ÷ meta) de los ejercicios registrados, entre 7. Los vacíos cuentan
  0 y no hay tope, igual que las fórmulas del Excel; una evaluación incompleta puntúa menos.
* **Medidas**: todos los campos son obligatorios (cm y libras), y se precargan las últimas.

## Asistencia con QR

La cámara no funciona dentro de páginas de Apps Script ni de Google Sites, por eso el escáner es una página
estática aparte (`checkin/`, GitHub Pages) que habla con `doPost`. Un Admin crea un **código de
emparejamiento** (15 min, un solo uso) en *Ajustes → Tablets*; el tablet lo canjea por un token propio (en el
servidor solo se guarda su hash) y puede revocarse. Hay límites de intentos, un segundo QR dentro de la
ventana (4 h por defecto) no duplica la visita, y la respuesta solo lleva nombre de pila y estado.

**Wallet**: el carnet ofrece *Agregar a Google Wallet* si `GB_WALLET_ISSUER_ID` y `GB_WALLET_SA` están
configuradas (Google Wallet Business Console + cuenta de servicio). En iPhone 15 Pro o posterior el
miembro puede guardar la imagen del QR y usar *Agregar pase a Wallet* desde Fotos (sin cuenta de desarrollador).
Un pase firmado de Apple requiere el Apple Developer Program y no está incluido.

## Seguridad

* El Web App es público y se ejecuta como el propietario, por eso **ninguna función sensible es pública**:
  terminan en `_` y solo se llega a ellas con `gbApi(token, acción, args)`. Una prueba revisa que la lista de
  funciones públicas no crezca por accidente (`tools/tests/auth.test.mjs`).
* **Rotar el secreto de inicio de sesión**: el valor antiguo está en el historial de git. Genera uno nuevo
  (`openssl rand -hex 32`), guárdalo como propiedad `GOOGLE_AUTH_SHARED_SECRET` aquí y pégalo como
  `SHARED_SECRET` en el proyecto `gymbars-auth` (en el editor de Apps Script, sin commitearlo).
* `?api=data` solo publica el contenido del sitio web.

## Desarrollo y pruebas

```bash
npm run verify                            # guardia + sintaxis + 150+ pruebas (seguridad, reglas, mensajes, asistencia, escáner, despliegue)
node tools/preview-admin.mjs --demo        # panel completo con datos de ejemplo (http://localhost:3200)
node tools/ui-check.mjs                    # recorre la interfaz en Chrome y guarda capturas
node tools/preview.mjs                     # el sitio público con los datos reales (solo lectura)
```

El panel de vista previa ejecuta los archivos `.gs` **reales** en Node con hojas en memoria; no usa clasp y no
despliega nada. Si existe `migration/` usa esos datos reales, solo en la computadora local.

## Cuotas y límites de Apps Script

Correos por día (≈100 con Gmail personal, ≈1500 con Workspace; el sistema respeta la cuota y reintenta al día
siguiente), 6 minutos por ejecución (el proceso diario crea como máximo 60 mensajes por corrida y continúa al
día siguiente), y una hoja nueva trae 1000 filas × 26 columnas (el código agrega filas y columnas al crecer).

## Lo que no incluye

* Una pestaña «Ficha» con fórmulas y gráficas dentro de la hoja: el panel (también dentro de la hoja)
  muestra la ficha completa con medidas, evolución del peso y evaluaciones.
* WhatsApp automático (requiere la API de pago de Meta): la bandeja está pensada para poder conectarla después.
* Pase firmado de Apple Wallet.
