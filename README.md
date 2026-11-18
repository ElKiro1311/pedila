<p align="center"><img src="docs/banner.jpg" alt="Una mensajera con sandalias aladas de oro corre por el cielo con una carta, dibujada en tinta"></p>

<p align="center"><img src="docs/icono.png" width="112" alt="Icono de Pedila: una sandalia alada a toda velocidad, en tinta con un toque de oro"></p>

<h1 align="center">Pedila, la mensajera</h1>

<p align="center"><b>Una ventana sencilla, en español, para usar <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> (el de tu PC y el de tu servidor) y <a href="https://www.anthropic.com/claude-code">Claude Code</a>, todo en una sola ventana.</b><br>
<i>Cliente no oficial. Pedila no está hecho ni respaldado por Nous Research.</i></p>

## El nombre

**Pedila** viene del griego **πέδιλα** (*pédila*), las sandalias aladas de Hermes. Los romanos las llamaron *talaria*. Con ellas Hermes, el mensajero de los dioses, llevaba los mensajes de un mundo a otro. Homero lo cuenta dos veces con los mismos versos, cuando Zeus lo envía con un recado (*Odisea* V, 44-46; *Ilíada* XXIV, 340-342):

> αὐτίκ᾽ ἔπειθ᾽ ὑπὸ ποσσὶν ἐδήσατο καλὰ πέδιλα,
> ἀμβρόσια χρύσεια, τά μιν φέρον ἠμὲν ἐφ᾽ ὑγρὴν
> ἠδ᾽ ἐπ᾽ ἀπείρονα γαῖαν ἅμα πνοιῇς ἀνέμοιο.
>
> «Enseguida se ató a los pies las hermosas sandalias, inmortales, de oro, que lo llevaban sobre el mar y sobre la tierra sin límites, tan rápido como los soplos del viento».

Eso quiere ser esta app: las sandalias que llevan tus mensajes hasta Hermes, esté en tu PC o en tu servidor.

**Pedila, la mensajera.** En la app las sandalias cobran vida: Pedila es una chica que se las calza y corre con tus mensajes de un lado a otro. Es la mascota de la app. Espera tranquila con su carta, corre mientras Hermes trabaja, lee su pergamino cuando Hermes usa herramientas, te ofrece la carta cuando Hermes necesita tu permiso, salta de alegría cuando termina y se pone triste si algo falla.

<p align="center"><img src="docs/mascota/quieta.png" height="150" alt="Pedila, de pie con su carta"> <img src="docs/mascota/correr-1.png" height="130" alt="Pedila corriendo con la carta"> <img src="docs/mascota/lee.png" height="150" alt="Pedila leyendo un pergamino"> <img src="docs/mascota/salto.png" height="140" alt="Pedila saltando de alegría"></p>

**El icono, el banner y Pedila** están dibujados en tinta al estilo manga, con el oro de las sandalias como único color: en el icono, una sandalia alada a toda velocidad; en el banner, Pedila cruzando el cielo con una carta. Los generó el propio Hermes con un modelo de imágenes en local (Qwen-Image), y después se recortaron para la app ([`docs/icono.png`](docs/icono.png), [`docs/banner.jpg`](docs/banner.jpg), [`docs/mascota/`](docs/mascota)). Las poses de Pedila se pidieron sobre fondo verde; `scripts/make-pet.js` quita el verde y monta la hoja animada.

## Qué hace

- **Tus Hermes en una ventana:**
  - **Este PC** usa el mismo Hermes que Hermes Desktop, con los mismos chats. Solo aparece si Hermes está instalado en el PC.
  - **Servidor** es un Hermes en otra máquina (`hermes dashboard` con usuario y contraseña). Solo aparece cuando pones su dirección en Ajustes → Servidor.
  - Con un único Hermes no hay selector: se usa ese.
- **Cuotas de tus APIs:** si tu Hermes usa OpenRouter, Venice u OpenCode, el panel enseña lo que te queda de cada una:
  - **OpenRouter:** saldo de créditos; límite de la clave, cuándo se reinicia y lo gastado hoy, en la semana y en el mes.
  - **Venice:** saldo USD, créditos del plan y DIEM; cuándo se reinicia el DIEM; límites por modelo.
  - **OpenCode Go:** % usado de las ventanas de 5 h, semana y mes, y cuándo se reinician. De **OpenCode Zen**, OpenCode no publica el saldo.
  - En cada una, lo que Hermes ha gastado en 24 h, 7 y 30 días.
  - Lo lee un complemento pequeño de Pedila dentro de Hermes ([hermes-plugin/pedila](hermes-plugin/pedila)): tus claves no salen de Hermes, solo llegan números. Se instala con el botón «Activar cuotas» del panel, sin reiniciar Hermes. Las APIs que no tienes no aparecen.
- **Claude Code como chat** («💬 Chats» → «Claude»): escribes a tu Claude Code y lo ves como cualquier chat de Pedila, con su texto en directo, tarjetas de herramientas, permisos con botones y el panel (memoria usada, tokens, tareas).
  - Pedila solo hace de intermediario: abre **tu** `claude` (tu cuenta, tus opciones) en modo de mensajes JSON y le pasa lo que escribes tal cual. Claude usa sus propias herramientas. Hermes no interviene.
  - La lista son tus conversaciones de Claude Code (`~/.claude/projects`), también las empezadas en una consola, y se pueden seguir desde aquí.
  - Cada chat nuevo trabaja en la carpeta que eliges (📁), con el modelo y el razonamiento que elijas.
  - **Tu plan de Claude:** el panel enseña el % usado de tu cuota y cuándo se reinicia, tal como lo manda Claude Code con cada respuesta.
  - **Seguir en una consola:** desde el menú ⋯ del chat, abre la misma conversación con `claude --resume` en una pestaña de consola, para lo que solo existe allí (menús de `/model`, `/resume`…).
  - Fijar y archivar se guardan en Pedila. Borrar manda la conversación a la papelera de Windows.
- **Consolas en pestañas** («▣ Consolas»): Claude Code, Hermes, Antigravity o PowerShell tal cual, dentro de Pedila, sin ventanas aparte. Cada una lleva su estado (trabajando, en espera, te espera, en marcha, terminó) y se cierra con «✕ Cerrar consola» o con la ✕ de su fila.
  - Son consolas de verdad de Windows (ConPTY): los programas funcionan igual que en Windows Terminal.
  - En las de Claude Code, Pedila sabe qué conversación lleva cada pestaña y si está trabajando (lo lee de `claude agents --json`), y avisa cuando termina. Las sesiones de Claude abiertas en otras ventanas aparecen en la lista y se traen con un clic (`claude --resume`).
  - Al salir con consolas abiertas Pedila pregunta, y la próxima vez ofrece reabrirlas (las de Claude con su conversación).
  - Teclas: Ctrl+Mayús+T, nueva; Ctrl+Tab, siguiente; Ctrl+Mayús+W, cerrar; Ctrl+C con texto marcado, copiar; Ctrl+V, pegar. Soltar un archivo escribe su ruta.
- **Opciones de Claude** (Ajustes → Claude y consolas): por ejemplo `--effort max`, para los chats y las consolas de Claude. Con `--dangerously-skip-permissions` no pide permisos.
- Los programas no vienen con Pedila: usa los que tengas instalados.
- **Herramientas como en Claude Code** (en los chats de Hermes y de Claude): las que van seguidas se juntan en una línea que se abre («Ejecutó 2 órdenes, leyó captura.png · +12 −3 · 1 falló»). Dentro, cada una con su título, lo que se le pasó (la orden, el código o el cambio en verde y rojo), lo que devolvió y, si falló, en rojo. Las imágenes que mira o genera salen ahí mismo.
- **Imágenes:** las que adjuntas se ven en tu mensaje y en el recuadro de escribir; se abren en grande al pulsarlas.
- **Chats:**
  - lista y búsqueda, por título y en el contenido;
  - fijar, renombrar, archivar (con su vista de archivados) y borrar con confirmación;
  - exportar a Markdown.
- **Chat:**
  - respuesta en directo, razonamiento plegable y herramientas en curso;
  - botón de parar y tarjetas de permiso y de pregunta;
  - copiar, duración y tokens por segundo;
  - barra de memoria del chat que avisa al 80 %.
- **Al escribir:**
  - imágenes (adjuntar, pegar o arrastrar);
  - «Solo consultar»;
  - nivel de razonamiento;
  - selector de modelo, que marca con ☁ los que están en la nube;
  - frases rápidas con «/».
- **Avisos:** avisos de Windows, un sonido propio al terminar, un punto en el icono de la barra de tareas y parpadeo si los avisos de Windows están apagados.
- **Más:**
  - un panel a la derecha, como el de Claude Panel, con lo que hace Hermes, la memoria y los tokens del chat abierto, el uso de hoy y de 7 días, los modelos que más tokens han gastado (también en resumir la memoria, poner títulos o ver imágenes) y las conexiones (se pliega con ◨);
  - la hora de la última respuesta de Hermes y el tiempo que ha pasado desde entonces (o, si está trabajando, desde cuándo), aunque la tarea la empezara Hermes Desktop;
  - «Tareas», como en Claude Code: el plan de Hermes (su lista de tareas, con subtareas) y cuánto lleva hecho, lo que está haciendo ahora, las herramientas en marcha y sus subagentes;
  - la lista de chats y el panel se ensanchan o estrechan arrastrando su raya (o con las flechas; doble clic: el ancho de siempre);
  - «Tu uso», calculado solo con tus datos;
  - bandeja del sistema y atajo **Ctrl+Alt+H**;
  - actualizaciones desde GitHub Releases;
  - Pedila, la mascota, que reacciona a lo que hace Hermes; si prefieres otra, se elige entre más de 5.000 de [Petdex](https://petdex.dev).
- **Diseño a tu gusto** (Ajustes → Diseño): ordena y esconde las pestañas (Chats/Consolas, Este PC/Servidor/Claude), elige qué tarjetas del panel salen en cada modo y en qué orden, esconde los botones que no uses y pon la lista de chats a la derecha si lo prefieres. Las pestañas y las tarjetas también se arrastran directamente en su sitio.
- **Cuotas con el mismo diseño para todos:** cada proveedor (OpenRouter, Venice, OpenCode y tu plan de Claude) sale igual: lo que te queda en grande y, debajo, cada medida con su barra y cuándo se reinicia. Para los saldos sin total (Venice), la barra cuenta lo gastado desde el saldo más alto que Pedila ha visto.
- **Temas:** seis, cada uno en modo oscuro y claro, con vista previa en Ajustes → Apariencia:
  - **Mensajera** (predeterminado): tinta, grises y oro, como Pedila;
  - **Clásico**: grises fríos y violeta, el de las primeras versiones;
  - **Egeo**: azul noche y oro;
  - **Ánfora**: negro y terracota;
  - **Olivo**: verdes tranquilos;
  - **Claude**: pizarra, marfil y terracota, como Claude.
  - El color de acento puede ser el del tema o uno a elegir.

## Instalar

1. Descarga `Pedila-Setup.exe` desde [Releases](../../releases).
2. Ábrelo. Se instala en tu usuario, sin pedir permisos de administrador.
   - El instalador no está firmado, así que Windows puede decir «Windows protegió tu PC». Pulsa **Más información** y luego **Ejecutar de todas formas**.
3. **Este PC** funciona solo si tienes Hermes Agent instalado (con Hermes Desktop o el instalador oficial).
4. **Servidor**: pon la dirección de su `hermes dashboard` en Ajustes → Servidor e inicia sesión con su usuario y contraseña. La contraseña no se guarda; la sesión sí, cifrada con Windows (DPAPI).

**Requisitos:** Windows 10 u 11 y Hermes Agent 0.22 o 0.23 (probado con 0.22.5 en el servidor y 0.23.0 en el PC). Pedila habla el protocolo interno que usa Hermes Desktop, así que una versión nueva de Hermes puede necesitar una actualización de Pedila.

## Cómo habla con Hermes (la misma vía que Hermes Desktop)

| | Este PC | Servidor |
|---|---|---|
| Dirección | `hermes gateway ensure --json` (arranca el gateway si hace falta) | La de Ajustes → Servidor; se prueba la primera y, si no responde, la alternativa |
| Entrar | Sin contraseña. Los tickets de un solo uso salen de la tubería privada del gateway, pedidos con el Python de Hermes | `POST /auth/password-login`; las cookies `hermes_session_*` se guardan cifradas |
| Chat en vivo | `/api/ws`, con el ticket como subprotocolo junto a `hermes-gateway-v1` | `/api/ws?ticket=` (de `POST /api/auth/ws-ticket`) |
| Lista, búsqueda y cambios | REST `/api/sessions…`, con un ticket `native-http` por petición | REST con las cookies |
| Tokens por modelo | `GET /api/analytics/usage?days=365` (lo de la página de uso de Hermes Desktop); sin esa ruta, la suma de la lista de chats | Igual, con las cookies |

Los cambios sobre un chat (renombrar, fijar, archivar, borrar) usan las ediciones protegidas de Hermes: primero `/mutation-snapshot` y luego `request_id` + `expected_revision` + `expected_generation`. Se hablan los dos protocolos del gateway, el nuevo (`session_authority`) y el clásico.

## Desarrollo

```
npm install                # si falta el binario de Electron: node node_modules/electron/install.js
npm run assets             # iconos desde docs/icono.png, la hoja de Pedila desde docs/mascota y copia de marked, DOMPurify y xterm.js
npm test                   # pruebas de las piezas puras
npm start                  # abre la app
npm run dist               # instalador en dist/ (NSIS por usuario)
```

Solo en desarrollo:
- `PEDILA_CDP=9334` abre un puerto de depuración. Con `node scripts/cdp.mjs 9334 eval "<js>"` se lee o maneja la ventana.
- `PEDILA_DEMO=1` usa datos inventados.
- `PEDILA_DATA=<carpeta>` usa otra carpeta de datos.
- `PEDILA_DEBUG=1` saca también el registro por consola.

**Publicar una versión:** sube a la Release `Pedila-Setup.exe` y un `version.json` con `{"version": "0.8.0-beta", "sha256": "<sha256 del instalador>", "notas": "…"}`. La versión tiene que ser exactamente la de `package.json`, con su sufijo -alfa/-beta si lo lleva: si no, la app instalada seguiría viendo una versión «nueva» después de actualizarse. La Release va como normal, no como pre-release: la app mira la última de GitHub (`releases/latest`), que se salta las pre-releases. La app compara la versión (como Semantic Versioning), descarga el instalador, comprueba el SHA-256 y se actualiza en silencio.

## Créditos y licencia

- Código de Pedila: [MIT](LICENSE).
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) es de Nous Research (MIT). Pedila no incluye su código; usa la misma vía que su app de escritorio.
- [Electron](https://www.electronjs.org/) (MIT), [marked](https://marked.js.org/) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0), [xterm.js](https://xtermjs.org/) (MIT) y [node-pty](https://github.com/microsoft/node-pty) (MIT).
- **Pedila**, la mascota, es del proyecto (MIT, como el código) y viaja en el instalador.
- **Las demás mascotas** son de sus autores en [Petdex](https://petdex.dev) y la app las descarga de allí cuando las eliges; no vienen en el repositorio ni en el instalador.
- El texto griego es de Homero (dominio público). La traducción es del proyecto.

---

### English

**Pedila** (Greek *πέδιλα*, Hermes' winged sandals, Latin *talaria*) is an unofficial Windows desktop client, with Pedila the messenger girl as its mascot, for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It talks to the Hermes on this PC (the same one Hermes Desktop uses) and to a remote `hermes dashboard`. It also talks to your own Claude Code as a chat (Pedila only relays: it runs your `claude` CLI in stream-json mode, Claude uses its own tools, your Claude Code conversations become the chat list, and the panel shows your plan usage), and hosts your AI consoles (Claude Code, Hermes, Antigravity, PowerShell) in tabs as real ConPTY terminals.

Features: live chat, tool and permission cards, chat management (pin, rename, archive, delete), full-text search, images, a «read-only» mode, a reasoning level, snippets, usage stats, what is left on the paid APIs your Hermes uses (OpenRouter, Venice, OpenCode — read by a small companion Hermes plugin, so API keys never leave Hermes), a tray icon, five themes (dark and light) and an animated pet: Pedila by default, or any of 5,000+ from Petdex.

The UI is in Spanish. Not affiliated with Nous Research. Code under the MIT license.
