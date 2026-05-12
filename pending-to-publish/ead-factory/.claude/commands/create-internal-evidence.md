# Create Internal Evidence

Registra un fichero en Evidence Manager con custodia interna, sello TSP (eIDAS) y opcionalmente DLT (blockchain Lacnet).

Dos modos de uso:

- **Guiado** (por defecto): solo pasas el archivo, te pregunta el resto paso a paso con confirmación final
- **Rápido**: pasas todos los flags y ejecuta directamente

## Uso

```
/create-internal-evidence <ruta> [--title "Título"] [--by "Nombre"] [--tsp-only|--dlt] [--meta "clave:valor, ..."]
```

**Ejemplos:**
```
# Modo guiado
/create-internal-evidence /Users/fvaldez/docs/contrato.pdf

# Modo rápido
/create-internal-evidence /Users/fvaldez/docs/contrato.pdf --title "Contrato 2024" --by "Fernando Valdez" --dlt --meta "cliente:Garrigues, expediente:EXP-2024-001"
```

## Instrucciones

Los argumentos son: $ARGUMENTS

---

### PASO 0 — Detectar modo y parsear argumentos

Extrae del string de argumentos:
- `filePath`: primer token (antes del primer `--`)
- `title`: valor de `--title "..."` si existe
- `createdBy`: valor de `--by "..."` si existe
- `dlt`: `true` si `--dlt` está presente, `false` si `--tsp-only`, `undefined` si no se especifica ninguno
- `metadata`: valor de `--meta "..."` si existe (formato libre `clave:valor, clave:valor`)

**Modo rápido**: si están presentes `filePath`, `title` (vía `--title`) Y `createdBy` (vía `--by`) Y timestamp preference (`--dlt` o `--tsp-only`) → salta al PASO 3.

**Modo guiado**: si falta cualquiera de los anteriores → ejecuta el flujo interactivo (PASO 1 y PASO 2).

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

**2a. Título** (solo si no se pasó `--title`):

Obtén el nombre base del fichero sin extensión con: `basename "<filePath>" | sed 's/\.[^.]*$//'`

Pregunta:
> ¿Cuál es el título de la evidencia?
> Sugerencia: `<nombre-sin-extensión>` — pulsa Intro para aceptarlo o escribe otro.

**2b. Creador** (solo si no se pasó `--by`):

Primero comprueba si tienes guardado en memoria un nombre por defecto para `createdBy` (busca en MEMORY.md o en archivos de memoria del proyecto la línea `evidence_default_creator:`).

- Si existe un valor guardado → pregunta:
  > ¿El creador es **"<nombre guardado>"**? (Intro para confirmar o escribe otro nombre)

- Si no existe → pregunta:
  > ¿Tu nombre completo para el registro de custodia?

  Tras obtener el nombre, guárdalo en memoria con la clave `evidence_default_creator` para no volver a preguntarlo.

**2c. Metadatos** (siempre pregunta, es opcional):

> ¿Quieres añadir metadatos adicionales? (cliente, expediente, referencia, tipo de documento, etc.)
> Escribe pares `clave:valor` separados por comas, o di **no** para omitirlos.
> Ejemplo: `cliente:Garrigues, expediente:EXP-2024-001, tipo:contrato`

**2d. Tipo de sello de tiempo** (solo si no se pasó `--dlt` ni `--tsp-only`):

> ¿Qué tipo de sello de tiempo quieres?
> **1. Solo TSP** — eIDAS cualificado (EADTrust)
> **2. TSP + DLT** — eIDAS + blockchain Lacnet

---

### PASO 3 — Resumen y confirmación

Antes de ejecutar, muestra siempre este resumen y pide confirmación:

```
📋 Resumen de la evidencia a crear
────────────────────────────────────
📄 Archivo:     <nombre del fichero> (<tamaño del fichero>)
📝 Título:      <título>
👤 Creado por:  <nombre>
🔐 Custodia:    INTERNAL
🕐 Timestamp:   <"Solo TSP (EADTrust/eIDAS)" o "TSP + DLT (EADTrust + Lacnet)">
📦 Metadatos:   <pares clave:valor o "ninguno">
────────────────────────────────────
¿Procedemos? (sí/no)
```

Si el usuario responde **no** → cancela:
```
❌ Evidencia cancelada.
```

---

### PASO 4 — Obtener valores técnicos

Ejecuta en paralelo:
- UUID: `uuidgen | tr '[:upper:]' '[:lower:]'`
- Timestamp actual: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

---

### PASO 5 — Parsear metadatos

Si el usuario proporcionó metadatos (ej: `cliente:Garrigues, expediente:EXP-001`):
- Conviértelos a JSON string: `{"cliente":"Garrigues","expediente":"EXP-001"}`
- Lo usarás en el parámetro `metadata`

Si no hay metadatos → omite el parámetro `metadata`.

---

### PASO 6 — Llamar al MCP

Llama a `mcp__evidence-manager__generate_evidence` con:

- `filePath`: ruta absoluta del fichero
- `evidenceId`: UUID generado en PASO 4
- `title`: título confirmado
- `createdBy`: nombre del creador
- `capturedAt`: timestamp ISO 8601 generado en PASO 4
- `custodyType`: `"INTERNAL"`
- `testimonyTSP`: `true` (siempre)
- `testimonyDLT`: `true` solo si se eligió TSP+DLT; omitir si solo TSP
- `metadata`: JSON string si hay metadatos (omitir si no hay)

---

### PASO 7 — Mostrar resultado

**Éxito (status: COMPLETED):**

Muestra el siguiente bloque, sustituyendo los valores reales. Si no se usó DLT, omite la línea de DLT completamente.

```
╔══════════════════════════════════════════════════════════════╗
║         CERTIFICADO DE EVIDENCIA DIGITAL CUALIFICADA         ║
║              Evidence Manager · Custodia Interna             ║
╚══════════════════════════════════════════════════════════════╝

  Este documento acredita que el fichero indicado ha sido
  registrado con sello de tiempo cualificado conforme al
  Reglamento eIDAS (UE 910/2014), garantizando su integridad
  y existencia en el momento certificado.

  ─────────────────────────────────────────────────────────────
  📄 Documento:    <fileName>
  🆔 Evidence ID:  <evidenceId>
  👤 Registrado por: <createdBy>
  📅 Fecha captura: <capturedAt>
  ─────────────────────────────────────────────────────────────
  🔐 INTEGRIDAD
     Algoritmo:   SHA-256
     Hash:        <hash>

  🏛️  SELLO DE TIEMPO CUALIFICADO (eIDAS)
     Autoridad:   EADTrust — Prestador Cualificado de Confianza
     Sellado el:  <timestampedAt>
     Estado:      ✅ SELLADO Y VERIFICADO

  ⛓️  SELLO BLOCKCHAIN (Lacnet DLT)           [omitir si no aplica]
     Red:         Lacnet
     Estado:      ✅ ANCLADO EN BLOCKCHAIN

  📦 Metadatos:   <pares clave:valor o "ninguno">
  ─────────────────────────────────────────────────────────────
  🔒 Custodia:    INTERNAL — Fichero alojado en Evidence Manager

╔══════════════════════════════════════════════════════════════╗
║  Este certificado puede verificarse en cualquier momento     ║
║  mediante el Evidence ID indicado.                           ║
╚══════════════════════════════════════════════════════════════╝
```

**Error:**
```
❌ Error al crear la evidencia

Paso fallido: <indicar qué paso falló>
Mensaje: <mensaje de error>

💡 Sugerencia: <consejo según el tipo de error>
```

**Errores comunes:**
- `File not found` → Verifica que la ruta sea absoluta y el fichero exista
- `401/403` → Las credenciales Okta han caducado, actualiza el MCP server
- `Timeout polling` → La evidencia sigue procesándose; usa `get_evidence` con el ID para consultar el estado
