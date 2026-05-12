# Create Signature Request

Crea una solicitud de firma completa en Signature Manager: SR en DRAFT → añade documento → añade firmante(s) → (opcionalmente validadores y observadores) → activa la SR.

Tres modos de uso:

- **Guiado** (por defecto): solo pasas el archivo, te pregunta el resto paso a paso con confirmación final
- **Rápido**: pasas los flags principales y ejecuta directamente
- **Full-flow**: delega el flujo completo al MCP con sus valores predefinidos de entorno (ideal para pruebas)

## Uso

```
/create-signature-request <ruta> [--name "Nombre SR"] [--by "Creador"] [--signatory "Nombre,email"] [--type INTERPOSITION|ADVANCED|OTHER] [--lang ES|EN] [--close "2025-12-31T23:59:59Z"]

# Modo full-flow (sin ruta, el MCP usa el fichero de entorno configurado)
/create-signature-request --full-flow --name "Nombre SR" --by "Creador" [--lang ES|EN] [--close "..."]
```

**Ejemplos:**
```
# Modo guiado
/create-signature-request /Users/fvaldez/docs/contrato.pdf

# Modo rápido
/create-signature-request /Users/fvaldez/docs/contrato.pdf --name "Contrato cliente X" --by "Fernando Valdez" --signatory "Ana García,ana@example.com" --type INTERPOSITION

# Modo full-flow (el MCP gestiona documento, firmante, validador y observador predefinidos)
/create-signature-request --full-flow --name "Test SR" --by "Fernando Valdez"
```

## Instrucciones

Los argumentos son: $ARGUMENTS

---

### PASO 0 — Detectar modo y parsear argumentos

Extrae del string de argumentos:
- `fullFlowMode`: `true` si aparece el flag `--full-flow`
- `filePath`: primer token **si no empieza por `--`** (antes del primer `--`)
- `srName`: valor de `--name "..."` si existe
- `createdBy`: valor de `--by "..."` si existe
- `signatory`: valor de `--signatory "Nombre,email"` si existe (formato: `"Nombre Apellidos,email@ejemplo.com"`)
- `signatureType`: valor de `--type ...` si existe (`INTERPOSITION` | `ADVANCED` | `OTHER`)
- `language`: valor de `--lang ...` si existe (`ES`, `EN`, etc.)
- `closeAt`: valor de `--close "..."` si existe (ISO 8601)

**Modo full-flow**: si `fullFlowMode` es `true` → salta directamente al PASO FF.

**Modo rápido**: si están presentes `filePath`, `srName` (vía `--name`), `createdBy` (vía `--by`) Y `signatory` (vía `--signatory`) → salta al PASO 3.

**Modo guiado**: si falta cualquiera de los anteriores (y no es full-flow) → ejecuta el flujo interactivo (PASO 1 y PASO 2).

---

### PASO FF — Modo Full-Flow (delegado al MCP)

En este modo el MCP se encarga de todo: crea la SR, añade un documento predefinido (configurado en el servidor), añade un firmante, validador y observador predefinidos, y activa la SR. Solo se necesita `name` y `createdBy`.

**FF.a — Recopilar datos faltantes**

Si no se pasó `--name`, pregunta:
> ¿Cuál es el nombre de la solicitud de firma?

Si no se pasó `--by`, comprueba si hay un valor guardado en memoria (`signature_default_creator` o `evidence_default_creator`):
- Si existe → pregunta: ¿El creador es **"<nombre guardado>"**? (Intro para confirmar o escribe otro)
- Si no existe → pregunta: ¿Tu nombre o email para el registro?

  Tras obtener el nombre, guárdalo en memoria con la clave `signature_default_creator`.

**FF.b — Resumen y confirmación**

Muestra:
```
📋 Resumen — Modo Full-Flow
─────────────────────────────────────────────
📝 Nombre SR:     <nombre>
👤 Creado por:    <createdBy>
🌐 Idioma:        <idioma o "por defecto del tenant">
📅 Cierre:        <fecha o "sin límite">
ℹ️  Documento, firmante, validador y observador
    serán los predefinidos en el servidor MCP.
─────────────────────────────────────────────
¿Procedemos? (sí/no)
```

Si el usuario responde **no** → cancela: `❌ Solicitud de firma cancelada.`

**FF.c — Llamar al MCP con fullFlow=true**

Llama a `mcp__g-mcp-server__create_signature_request` con:
- `name`: nombre de la SR
- `createdBy`: creador
- `language`: idioma si se especificó
- `notifications`: `true`
- `closeAt`: fecha de cierre si se especificó
- `closeCondition`: `"ALL_REQUIRED"` si hay fecha de cierre; omitir si no
- `fullFlow`: `true`

Muestra el resultado directamente con el formato del PASO 5 (adaptado: sin detalle de firmantes/documento ya que los gestiona el MCP).

---

### PASO 1 — Validar archivo

Ejecuta: `ls -la "<filePath>"`

Si no existe, muestra error y detente:
```
❌ No se encuentra el archivo: <filePath>

Verifica que la ruta sea absoluta y el fichero exista.
```

---

### PASO 2 — Recopilación guiada (solo en modo guiado)

Haz las preguntas **de una en una**, esperando respuesta del usuario antes de pasar a la siguiente.

**2a. Nombre de la SR** (solo si no se pasó `--name`):

Obtén el nombre base del fichero sin extensión con: `basename "<filePath>" | sed 's/\.[^.]*$//'`

Pregunta:
> ¿Cuál es el nombre de la solicitud de firma?
> Sugerencia: `<nombre-sin-extensión>` — pulsa Intro para aceptarlo o escribe otro.

**2b. Creador** (solo si no se pasó `--by`):

Comprueba si tienes guardado en memoria un nombre por defecto para `createdBy` (busca en MEMORY.md la clave `signature_default_creator` o `evidence_default_creator`).

- Si existe un valor guardado → pregunta:
  > ¿El creador es **"<nombre guardado>"**? (Intro para confirmar o escribe otro nombre)

- Si no existe → pregunta:
  > ¿Tu nombre o email para el registro de la solicitud?

  Tras obtener el nombre, guárdalo en memoria con la clave `signature_default_creator`.

**2c. Tipo de firma** (solo si no se pasó `--type`):

> ¿Qué tipo de firma necesitas?
> **1. INTERPOSITION** — Firma por interposición (click-to-sign)
> **2. ADVANCED** — Firma electrónica avanzada
> **3. OTHER** — Otro tipo

**2d. Idioma** (siempre, es opcional):

> ¿Idioma para las notificaciones? (ES / EN / — omitir con "no")

**2e. Firmantes** (solo si no se pasó `--signatory`):

Pide al menos un firmante. Para cada firmante:
> Firmante 1 — Nombre completo y email (formato: `Nombre Apellidos, email@ejemplo.com`)
> Escribe los datos o di **no** para no añadir más firmantes.

Continúa preguntando firmantes adicionales hasta que el usuario diga "no".

**2f. Validadores** (es opcional):

> ¿Quieres añadir validadores a algún firmante? (nombre, email — o **no** para omitir)
> Los validadores deben aprobar antes de que el firmante pueda firmar.

Si responde afirmativamente, para cada firmante pregunta si tiene validador asignado:
> ¿Validador para `<nombre firmante>`? (Nombre, email — o **no**)

**2g. Observadores** (es opcional):

> ¿Quieres añadir observadores al documento? Recibirán notificaciones pero no firman.
> (Nombre, email — o **no** para omitir)

**2h. Fecha de cierre** (es opcional):

> ¿Fecha límite para firmar? (formato ISO 8601: `2025-12-31T23:59:59Z` — o **no** para omitir)

---

### PASO 3 — Resumen y confirmación

Antes de ejecutar, muestra siempre este resumen y pide confirmación:

```
📋 Resumen de la solicitud de firma
─────────────────────────────────────────────
📄 Archivo:       <nombre del fichero> (<tamaño>)
📝 Nombre SR:     <nombre>
👤 Creado por:    <createdBy>
✍️  Tipo de firma: <INTERPOSITION | ADVANCED | OTHER>
🌐 Idioma:        <idioma o "por defecto del tenant">
✍️  Firmantes:
   · <Nombre firmante 1> (<email>)  [Validador: <nombre> (<email>) o ninguno]
   · <Nombre firmante 2> (<email>)  ...
👁️  Observadores: <lista o "ninguno">
📅 Cierre:        <fecha o "sin límite">
─────────────────────────────────────────────
¿Procedemos? (sí/no)
```

Si el usuario responde **no** → cancela:
```
❌ Solicitud de firma cancelada.
```

---

### PASO 4 — Ejecutar el flujo completo

Ejecuta los pasos en secuencia, mostrando progreso tras cada llamada al MCP:

**4a. Crear la SR**

Llama a `mcp__g-mcp-server__create_signature_request` con:
- `name`: nombre de la SR
- `createdBy`: creador
- `description`: descripción si existe (puedes omitir si no hay)
- `language`: idioma si se especificó
- `notifications`: `true` (por defecto)
- `closeAt`: fecha de cierre si se especificó
- `closeCondition`: `"ALL_REQUIRED"` si hay fecha de cierre; omitir si no
- `fullFlow`: `false` (siempre en este modo; el flujo lo controla esta skill)

Muestra: `✅ SR creada: <id> (DRAFT)`

**4b. Añadir documento**

Llama a `mcp__g-mcp-server__add_document_to_signature_request` con:
- `signatureRequestId`: ID obtenido en 4a
- `filePath`: ruta absoluta del fichero
- `title`: nombre de la SR (o título del documento si se especificó)
- `signatureType`: tipo elegido

Espera la respuesta. El tool gestiona la subida a S3 internamente.

Muestra: `✅ Documento añadido: <documentId>`

Después de añadir el documento, **espera** unos segundos (5-10s) para que el sistema procese el documento antes de añadir firmantes. Muestra: `⏳ Esperando a que el documento esté listo...`

Ejecuta: `sleep 8`

**4c. Añadir firmantes** (para cada firmante de la lista)

Para cada firmante, llama a `mcp__g-mcp-server__add_signatory_to_document` con:
- `signatureRequestId`: ID de la SR
- `documentId`: ID del documento obtenido en 4b
- `name`: nombre del firmante
- `email`: email del firmante
- `surnames`: apellidos si se separaron del nombre

Muestra: `✅ Firmante añadido: <nombre> (<signatoryId>)`

Guarda el `signatoryId` de cada firmante para el siguiente paso.

**4d. Añadir validadores** (solo si se especificaron)

Para cada par (firmante → validador), llama a `mcp__g-mcp-server__add_validator_to_signatory` con:
- `documentId`: ID del documento
- `signatoryId`: ID del firmante correspondiente
- `name`: nombre del validador
- `email`: email del validador

Muestra: `✅ Validador añadido: <nombre> → firmante <nombre firmante>`

**4e. Añadir observadores** (solo si se especificaron)

Para cada observador, llama a `mcp__g-mcp-server__add_observer_to_document` con:
- `signatureRequestId`: ID de la SR
- `documentId`: ID del documento
- `name`: nombre del observador
- `email`: email del observador

Muestra: `✅ Observador añadido: <nombre>`

**4f. Activar la SR**

Llama a `mcp__g-mcp-server__activate_signature_request` con:
- `signatureRequestId`: ID de la SR

Muestra: `✅ SR activada → ACTIVE`

---

### PASO 5 — Mostrar resultado

**Éxito (modo guiado / rápido):**

```
╔══════════════════════════════════════════════════════════════╗
║          SOLICITUD DE FIRMA CREADA Y ACTIVADA                ║
║              Signature Manager · Garrigues                   ║
╚══════════════════════════════════════════════════════════════╝

  La solicitud de firma ha sido creada y activada. Las
  notificaciones han sido enviadas a los firmantes.

  ──────────────────────────────────────────────────────────
  📝 Nombre:       <nombre de la SR>
  🆔 SR ID:        <id>
  👤 Creado por:   <createdBy>
  📄 Documento:    <nombre del fichero>
  🆔 Doc ID:       <documentId>
  ✍️  Tipo firma:  <tipo>
  📊 Estado:       ACTIVE
  ──────────────────────────────────────────────────────────
  👥 FIRMANTES
  <para cada firmante:>
     · <Nombre>  (<email>)  — ID: <signatoryId>
       Validador: <nombre validador> (<email>) o ninguno

  👁️  OBSERVADORES
  <lista o "ninguno">
  ──────────────────────────────────────────────────────────
  📅 Cierre:       <fecha o "sin límite">

╔══════════════════════════════════════════════════════════════╗
║  Los firmantes recibirán un email con el enlace de firma.    ║
║  Usa el SR ID para consultar el estado en cualquier momento. ║
╚══════════════════════════════════════════════════════════════╝
```

**Éxito (modo full-flow):**

```
╔══════════════════════════════════════════════════════════════╗
║       SOLICITUD DE FIRMA CREADA Y ACTIVADA (FULL-FLOW)       ║
║              Signature Manager · Garrigues                   ║
╚══════════════════════════════════════════════════════════════╝

  La SR fue creada y activada por el servidor MCP con los
  participantes y documento predefinidos del entorno.

  ──────────────────────────────────────────────────────────
  📝 Nombre:       <nombre de la SR>
  🆔 SR ID:        <id>
  👤 Creado por:   <createdBy>
  📊 Estado:       ACTIVE
  ──────────────────────────────────────────────────────────

╔══════════════════════════════════════════════════════════════╗
║  Usa el SR ID para consultar el estado en cualquier momento. ║
╚══════════════════════════════════════════════════════════════╝
```

**Error en cualquier paso:**
```
❌ Error en el flujo de firma

Paso fallido: <indicar qué paso falló>
SR ID: <id si ya se creó, o "no creada">
Mensaje: <mensaje de error>

💡 Sugerencia: <consejo según el tipo de error>
```

**Errores comunes:**
- `File not found` → Verifica que la ruta sea absoluta y el fichero exista
- `401/403` → Las credenciales Okta han caducado, actualiza el MCP server
- `Document not READY_TO_SIGN` → El documento aún no está procesado; espera y reintenta desde add_signatory
- `SR not in DRAFT` → La SR ya fue activada o cancelada; no se puede modificar
- `422 / validation error` → Revisa que el email del firmante tenga formato válido
- `FULL_FLOW_FILE_PATH not configured` → El servidor MCP no tiene configurada la variable de entorno del fichero predefinido