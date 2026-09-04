<!--
Field study, captured verbatim. This is a field study of Claude Code running
inside Claude Desktop, captured 2026-08-19 (Claude Desktop 1.30096.5, Claude
Code 2.1.229) — in Spanish, the language it was written in. It is the sole
source for the `claude-desktop` adapter's detection values and MCP tool names
(`cli/src/adapters/claude-desktop.ts`); its body is kept unchanged below.
Public docs later confirmed `claude-desktop` as a documented
`CLAUDE_CODE_ENTRYPOINT` value and `Claude Browser` / `Claude Preview` as the
built-in server's two names, but not the 18 method names this study lists —
see the adapter's header comment for what stays unverified.
-->

# Claude Desktop: detección del entorno e inventario de MCP servers

> Relevado el 2026-08-19 en macOS 25.5.0 · Claude Desktop `1.30096.5` · Claude Code `2.1.229` (Agent SDK `0.3.229`).
> Contrastado contra la CLI de terminal `2.1.235` corriendo en el mismo repo y con la misma config de usuario.

---

## 1. Cómo detectar que estamos dentro de Claude Desktop

### 1.1 Señales de entorno (las fiables)

El host escribe estas variables al lanzar el proceso. Las dos primeras bastan por sí solas:

| Variable | Valor en Desktop | Valor en terminal | Nota |
|---|---|---|---|
| `CLAUDE_CODE_ENTRYPOINT` | `claude-desktop` | `cli` | **Señal canónica.** El propio Claude Code declara quién lo lanzó |
| `__CFBundleIdentifier` | `com.anthropic.claudefordesktop` | ausente | macOS marca el bundle de la app padre. Solo en macOS |
| `CLAUDE_CODE_EXECPATH` | `~/Library/Application Support/Claude/claude-code/<ver>/claude.app/Contents/MacOS/claude` | ruta del binario instalado (`~/.local/share/claude/versions/<ver>`) | El binario vive dentro del bundle |
| `CLAUDE_CODE_MESSAGING_SOCKET` | `/tmp/cc-socks/<pid>.sock` | ausente | Socket IPC con el host |
| `CLAUDE_CODE_MESSAGING_TOKEN` | hex de 32 chars | ausente | Par del socket anterior |
| `CLAUDE_CODE_HOST_SESSION_ID` | `local_<uuid>` | ausente | Id de sesión del lado del host |
| `BAGGAGE` | incluye `sentry-release=Claude%40<version-app>` | ausente | Da la versión de la **app**, no la de la CLI |
| `CLAUDE_CODE_CHILD_SESSION` | `1` | ausente | La sesión corre como hija del host |
| `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL` | `true` | ausente | La app habilita el diálogo de preguntas |
| `CLAUDE_CODE_REPORT_FINDINGS` | `1` | ausente | Habilita `ReportFindings` (UI de hallazgos) |
| `CLAUDECODE` | `1` | `1` | **No sirve para distinguir** — está en ambos |
| `AI_AGENT` | `claude-code_<ver>_agent` | igual | **No sirve para distinguir** |

### 1.2 Detección programática

Bash / fish:

```bash
[ "$CLAUDE_CODE_ENTRYPOINT" = "claude-desktop" ] && echo "Claude Desktop" || echo "otro entorno"
```

Node:

```js
const isDesktop = process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";
const isClaudeCode = process.env.CLAUDECODE === "1";      // cualquier entorno de Claude Code
const hostVersion = /sentry-release=Claude%40([^,]+)/.exec(process.env.BAGGAGE ?? "")?.[1];
```

Python:

```python
import os, re
is_desktop = os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop"
is_macos_bundle = os.environ.get("__CFBundleIdentifier") == "com.anthropic.claudefordesktop"
```

Detección defensiva (por si cambia el valor del entrypoint) — cualquiera de estas tres:

```bash
test "$CLAUDE_CODE_ENTRYPOINT" = "claude-desktop" \
  || test "$__CFBundleIdentifier" = "com.anthropic.claudefordesktop" \
  || test -n "$CLAUDE_CODE_MESSAGING_SOCKET"
```

### 1.3 Señales secundarias

- **Proceso padre**: `ps -o comm= -p $(ps -o ppid= -p $CLAUDE_PID)` apunta al ejecutable dentro de `Claude.app`.
- **Plugins de sesión en disco**: la app monta plugins efímeros bajo
  `~/Library/Application Support/Claude/local-agent-mode-sessions/`, visibles también dentro del `PATH`.
  Si el `PATH` contiene `local-agent-mode-sessions`, es Desktop.
- **Herramientas presentes**: existen `Artifact` y `SendUserFile`, y hay tools con prefijo
  `mcp__Claude_Browser__`, `mcp__ccd_session__` o `mcp__computer-use__`. Ninguna existe en terminal.
- **Slash commands ausentes**: `/permissions`, `/config`, `/hooks` y `/doctor` abren un panel interactivo
  de terminal y **no** están disponibles en Desktop.

### 1.4 Falsos amigos

- `CLAUDECODE=1` y `AI_AGENT` están en ambos entornos — no distinguen nada.
- El **nombre del worktree o de la rama** no es evidencia (puede llamarse cualquier cosa).
- La **versión** no distingue: app y CLI se actualizan por separado y pueden divergir
  (relevado: app `2.1.229` vs CLI `2.1.235`).

---

## 2. Qué aporta Desktop por encima de la terminal

Con la misma configuración de usuario y el mismo repo:

| Categoría | Terminal | Desktop | Delta |
|---|---|---|---|
| MCP servers | 3 (solo de plugins) | 15 | **+12 servers** |
| Skills | 85 | 104 | **+19 skills** |
| Tools nativas | — | `Artifact`, `SendUserFile` | +2 |

Los MCP compartidos (`plugin:linear:linear`, `plugin:neon:neon`, `plugin:vercel:vercel`) vienen de plugins
declarados en `~/.claude/settings.json` y existen igual en terminal. Los 12 restantes **no están declarados
en ninguna config** (`~/.claude.json`, `settings.json`, `.mcp.json` del proyecto están vacíos de `mcpServers`)
y no exponen comando ni endpoint: corren in-process dentro de la app. **No son replicables en terminal.**

Los **skills sí son replicables** — son carpetas en disco bajo
`~/Library/Application Support/Claude/local-agent-mode-sessions/` y se pueden copiar a `~/.claude/skills/`.

---

## 3. Inventario de MCP servers exclusivos de Desktop

### 3.1 `Claude_Browser` — navegador embebido en la app

Browser propio, separado de tu Chrome. Sin sesiones logueadas. Es el default para tareas web.
También levanta y monitorea el dev server del proyecto vía `.claude/launch.json`.

| Método | Qué hace |
|---|---|
| `navigate` | Ir a una URL, o `back` / `forward` |
| `computer` | Mouse/teclado: `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`, `screenshot`, `scroll`, `scroll_to`, `hover`, `left_click_drag`, `zoom`, `wait` |
| `read_page` | Árbol de accesibilidad en YAML con refs `[ref_N]`. Preferible al screenshot |
| `find` | Buscar elementos en el último `read_page`; devuelve refs |
| `form_input` | Setear valor de input/textarea/select/checkbox/contenteditable por `ref` |
| `get_page_text` | Texto visible de la página |
| `javascript_tool` | Ejecutar JS en la página — **solo** para debug/inspección |
| `read_console_messages` | Consola (log/info/warn/error/debug) |
| `read_network_requests` | Requests de red; con `requestId` devuelve el body |
| `resize_window` | Viewport: presets `mobile`/`tablet`/`desktop`, `colorScheme` light/dark |
| `preview_start` | Abrir el pane con una URL, **o** arrancar el dev server por `name` de `.claude/launch.json` |
| `preview_list` | Servidores levantados con `preview_start` |
| `preview_logs` | stdout/stderr del server; filtros `level` y `search` |
| `preview_stop` | Frenar un server |
| `tabs_context` | Listar tabs (`tabId`, `origin`, `isActive`) |
| `tabs_create` | Nueva tab en blanco |
| `tabs_select` | Traer una tab al frente |
| `tabs_close` | Cerrar una tab |

**18 métodos.**

### 3.2 `claude-in-chrome` — tu Chrome real

Requiere la extensión de Chrome instalada y logueada. Usarlo solo cuando la tarea necesita las sesiones
ya autenticadas del usuario.

| Método | Qué hace |
|---|---|
| `navigate` | Navegar / `back` / `forward` |
| `computer` | Mouse y teclado (mismo repertorio que el browser embebido) |
| `read_page` | Árbol de accesibilidad con refs |
| `find` | Buscar elementos por descripción |
| `form_input` | Setear valores de formulario |
| `get_page_text` | Texto de la página |
| `javascript_tool` | JS en la página |
| `read_console_messages` | Consola |
| `read_network_requests` | Red |
| `resize_window` | Viewport y color scheme |
| `file_upload` | Subir un archivo a un input de la página |
| `upload_image` | Subir una imagen |
| `gif_creator` | Grabar la interacción como GIF |
| `browser_batch` | Encadenar varias acciones en una llamada |
| `tabs_context_mcp` | Listar tabs |
| `tabs_create_mcp` | Nueva tab |
| `tabs_close_mcp` | Cerrar tab |
| `list_connected_browsers` | Browsers conectados a la extensión |
| `select_browser` | Elegir browser destino |
| `switch_browser` | Cambiar de browser activo |
| `shortcuts_list` | Listar shortcuts/automatizaciones guardadas |
| `shortcuts_execute` | Ejecutar una |
| `request_credentials` | Pedir credenciales al gestor (1Password). El usuario aprueba en la UI del gestor |
| `autofill_credential` | Rellenar el valor aprobado directo en la tab — Claude nunca ve el valor |
| `list_granted_credentials` | Qué credenciales están aprobadas |
| `release_credentials` | Liberar las aprobaciones |
| `enter_verification_code` | Meter el OTP de SMS/email en el campo enfocado, sin exponerlo |

**27 métodos.** Los cinco de credenciales son la razón principal para elegir este server sobre el embebido.

### 3.3 `computer-use` — control del escritorio macOS

Para apps nativas (Notes, Finder, Maps, System Settings, apps de terceros) y flujos entre apps.
Sujeto a un flujo de permisos por aplicación, con tiers: browsers → `read`, terminales/IDEs → `click`,
resto → `full`.

| Método | Qué hace |
|---|---|
| `request_access` | Pedir acceso a una lista de apps. **Obligatorio antes de cualquier acción** |
| `request_teach_access` | Acceso para el modo de enseñanza |
| `list_granted_applications` | Apps ya aprobadas y su tier |
| `open_application` | Traer una app al frente. Funciona en cualquier tier |
| `screenshot` | Captura de pantalla |
| `zoom` | Captura ampliada de una región |
| `switch_display` | Cambiar de monitor |
| `cursor_position` | Posición actual del cursor |
| `mouse_move` | Mover el cursor |
| `left_click` · `right_click` · `middle_click` · `double_click` · `triple_click` | Clicks |
| `left_mouse_down` · `left_mouse_up` | Click en dos tiempos |
| `left_click_drag` | Arrastrar |
| `scroll` | Scroll |
| `key` | Pulsar tecla / combinación |
| `hold_key` | Mantener una tecla |
| `type` | Escribir texto |
| `wait` | Esperar |
| `read_clipboard` | Leer el portapapeles |
| `write_clipboard` | Escribir el portapapeles |
| `computer_batch` | Varias acciones en una sola llamada |
| `teach_step` · `teach_batch` | Grabar pasos para enseñarle un flujo |

**27 métodos.** La disponibilidad concreta varía por sesión y por permisos concedidos.

### 3.4 `Claude_Code_iOS_Simulator` — simulador de iOS

Solo simuladores; no controla un iPhone físico.

| Método | Qué hace |
|---|---|
| `build` | Compilar el proyecto iOS |
| `control` | Todo lo demás, vía el parámetro `action` |

Acciones de `control`: `attach` (abrir el panel en vivo — conviene llamarlo **antes** de compilar),
`launch` (instalar y arrancar un `.app`), `screenshot`, `tap`, `swipe`, `touch_path` (arrastre con curva),
`touch2_path` (dos dedos: pinch/rotate), `text`, `button` (`HOME`/`LOCK`/`SIRI`/`SIDE_BUTTON`/`APPLE_PAY`),
`open_url` (deep link), `detach`.

**2 métodos, 11 acciones.** Coordenadas en puntos de dispositivo, origen arriba-izquierda.

### 3.5 `visualize` — widgets inline en el chat

| Método | Qué hace |
|---|---|
| `read_me` | Contexto obligatorio antes del primer `show_widget`: variables CSS, tipografía, reglas de layout. Módulos: `diagram`, `mockup`, `interactive`, `data_viz`, `art`, `chart`, `elicitation` |
| `show_widget` | Renderizar SVG o HTML inline junto a la respuesta. Expone un `sendPrompt(text)` global |

**2 métodos.** Aparece duplicado bajo un id opaco (`6f616b42-0ed8-…`) con la misma superficie.

### 3.6 `ccd_session` — sesión actual

| Método | Qué hace |
|---|---|
| `mark_chapter` | Marcar un capítulo en la sesión: divisor en el transcript + tabla de contenidos |
| `spawn_task` | Crear un chip de tarea en background para un pendiente fuera de alcance |
| `dismiss_task` | Retirar un chip que quedó obsoleto |
| `read_widget_context` | Leer el estado actual de un widget interactivo ya renderizado |

**4 métodos.**

### 3.7 `ccd_session_mgmt` — gestión de sesiones

| Método | Qué hace |
|---|---|
| `list_sessions` | Listar sesiones |
| `get_session` | Detalle de una sesión |
| `list_events` | Eventos de una sesión |
| `search_session_transcripts` | Buscar texto en los transcripts |
| `send_message` | Mandar un mensaje a otra sesión |
| `set_session_title` | Renombrar una sesión |
| `archive_session` | Archivar |

**7 métodos.**

### 3.8 `ccd_directory` — acceso a directorios

| Método | Qué hace |
|---|---|
| `request_directory` | Pedir acceso a un directorio fuera del working dir |

**1 método.**

### 3.9 `terminal` — terminal externa

| Método | Qué hace |
|---|---|
| `read_terminal` | Leer el contenido de la terminal del usuario |

**1 método.**

### 3.10 `mcp-registry` — descubrimiento de conectores

| Método | Qué hace |
|---|---|
| `search_mcp_registry` | Buscar servers en el registry |
| `list_connectors` | Conectores disponibles |
| `suggest_connectors` | Sugerir conectores según la tarea |

**3 métodos.**

### 3.11 `scheduled-tasks` — tareas programadas

| Método | Qué hace |
|---|---|
| `create_scheduled_task` | Crear una tarea recurrente |
| `list_scheduled_tasks` | Listar |
| `update_scheduled_task` | Modificar |
| `delete_scheduled_task` | Borrar |

**4 métodos.** Distinto de `ScheduleWakeup` (tool nativa, existe también en terminal) y del skill `schedule`.

---

## 4. Tools nativas exclusivas (no son MCP)

| Tool | Qué hace |
|---|---|
| `Artifact` | Publicar una página HTML/Markdown privada en claude.ai. Acciones: `publish`, `list`, `comments`, `reply`, `resolve`, `upload_asset`, `list_assets`, `read_asset`, `delete_asset` |
| `SendUserFile` | Mandar archivos al chat como tarjeta o render inline |

`ScheduleWakeup`, `Workflow`, `Agent`, `AskUserQuestion` y `ReportFindings` **también existen en terminal**
(algunas condicionadas por flags de entorno).

---

## 5. Skills exclusivos de Desktop (19)

Montados como plugins efímeros por sesión bajo
`~/Library/Application Support/Claude/local-agent-mode-sessions/`:

- **`anthropic-skills`** (14) — `docx` · `pdf` · `pptx` · `xlsx` · `canvas-design` · `theme-factory` ·
  `web-artifacts-builder` · `doc-coauthoring` · `skill-creator` · `consolidate-memory` · `explain-usage` ·
  `morning` · `schedule` · `setup-cowork`
- **`cowork-plugin-management`** (2) — `create-cowork-plugin` · `cowork-plugin-customizer`
- **Artifacts** (3) — `artifact-design` · `artifact-diagramming` · `artifact-capabilities`

Copiar alguno a terminal:

```bash
cp -R "$HOME/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/"*/*/skills/{docx,pdf,pptx,xlsx} ~/.claude/skills/
```

---

## 6. Resumen ejecutable

```bash
# ¿Estoy en Claude Desktop?
echo $CLAUDE_CODE_ENTRYPOINT          # -> claude-desktop
echo $__CFBundleIdentifier            # -> com.anthropic.claudefordesktop

# Versión de la app (no de la CLI)
echo $BAGGAGE | grep -o 'sentry-release=Claude%40[^,]*'

# MCPs configurados (los únicos replicables en terminal)
claude mcp list

# Plugins que inyecta la app
ls ~/Library/Application\ Support/Claude/local-agent-mode-sessions/
```

| Total | |
|---|---|
| MCP servers exclusivos | 12 |
| Métodos MCP exclusivos | ~99 |
| Skills exclusivos | 19 |
| Tools nativas exclusivas | 2 |
