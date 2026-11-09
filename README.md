# Hermes Panel

Una ventana sencilla, en español, para usar [Hermes Agent](https://github.com/NousResearch/hermes-agent):

- **Este PC**: el mismo Hermes que usa Hermes Desktop, con sus mismos chats.
- **Servidor**: un Hermes en otra máquina (`hermes dashboard` protegido con usuario y contraseña).

Incluye:
- **Chats:** lista, búsqueda por título y en el contenido, fijados, renombrar, archivar (con su vista de archivados) y borrar con confirmación. Los cambios usan el borrado y la edición protegidos de Hermes: primero `/mutation-snapshot` y después la identidad del cambio.
- **Chat:** respuesta en directo, razonamiento plegable, herramientas en curso, botón de parar, tarjetas de permiso y de pregunta, copiar, exportar a Markdown, duración y tokens por segundo, y una barra de memoria del chat que avisa al 80 %.
- **Al escribir:** imágenes (adjuntar, pegar o arrastrar), «Solo consultar», nivel de razonamiento, selector de modelo (marca los modelos que están en la nube) y frases rápidas con «/».
- **Avisos:** avisos de Windows, un sonido propio al terminar, un punto en el icono de la barra de tareas y parpadeo si los avisos de Windows están apagados.
- **Tu uso:** chats por día y tokens por modelo, calculados solo con tus datos.
- **Actualizaciones:** desde una carpeta web con `version.json` (versión y SHA-256) y `HermesPanel-Setup.exe`.
- **Otros:** bandeja del sistema, atajo Ctrl+Alt+H y una mascota de [Petdex](https://petdex.dev) que reacciona a lo que hace Hermes.

## Cómo habla con Hermes (la misma vía que Hermes Desktop)

| | Este PC | Servidor |
|---|---|---|
| Dirección | `hermes gateway ensure --json` (arranca el gateway si hace falta) | La de Ajustes → Servidor; se prueba la primera y, si no responde, la alternativa (por ejemplo una VPN) |
| Entrar | Sin contraseña. Los tickets de un solo uso salen de la tubería privada del gateway, pedidos con el Python de Hermes (`_session_ticket`) | `POST /auth/password-login` deja las cookies `hermes_session_*`, que se guardan cifradas con safeStorage (DPAPI). La contraseña no se guarda |
| Chat en vivo | `/api/ws` con el ticket como subprotocolo `hermes-gateway-ticket.<t>` junto a `hermes-gateway-v1` | `/api/ws?ticket=` (de `POST /api/auth/ws-ticket`, válido 30 s) |
| Lista y mensajes | REST `/api/sessions…` con un ticket `native-http` por petición | REST con las cookies |

El protocolo se elige por `gateway.ready.session_authority`.

**Nuevo (Hermes 0.23):**
- `session.create` lleva `request_id` y `prompt.submit` lleva `submission_id`.
- Parar, responder un permiso y responder una pregunta llevan `execution_generation`.
- Los permisos y las preguntas llegan como eventos `approval.request` y `clarify.request`.

**Clásico (Hermes 0.22):**
- Los permisos y las preguntas llegan como peticiones del servidor (`approval`, `clarify`) y se contestan en esa misma petición.
- Las peticiones que siguen abiertas vuelven en `open_requests` al hacer `session.resume`.

## Desarrollo

```
npm install                # si falta el binario de Electron: node node_modules/electron/install.js
npm run assets             # baja la mascota predeterminada de Petdex, genera los iconos y copia marked/DOMPurify
npm test                   # pruebas de las piezas puras
npm start                  # abre la app
npm run dist               # instalador en dist/ (NSIS por usuario)
```

Solo en desarrollo:

- `HERMES_PANEL_CDP=9334` abre un puerto de depuración. Con `node scripts/cdp.mjs 9334 eval "<js>"` se lee o maneja la ventana, y con `close` se cierra.
- `HERMES_PANEL_DEMO=1` usa datos inventados (`src/shell/demo.js`), sin tocar ningún Hermes.
- `HERMES_PANEL_DEBUG=1` saca también el registro por consola.
- `HERMES_PANEL_DATA=<carpeta>` usa otra carpeta de datos (ajustes, sesión, mascotas) y deja abrir esa copia junto a la app instalada.

El registro va a `%APPDATA%\Hermes Panel\logs\hermes-panel.log` y los ajustes a `%APPDATA%\Hermes Panel\settings.json`.

## Mascota

En Ajustes → Mascota → «Elegir otra mascota…» se abre el selector:

- **Tus mascotas**: la predeterminada más las que ya usaste.
- **Catálogo de Petdex**: más de 5.000 mascotas, con búsqueda por nombre o autor y filtro por tipo.
  - Las miniaturas animadas son las tiras `preview.webp` que usa la propia web de Petdex.
  - Al elegir una se baja su hoja completa, solo de `petdex.dev`, con un tamaño máximo y comprobando que sea PNG o WebP. Se guarda en `%APPDATA%\Hermes Panel\pets\<slug>\`.

La predeterminada es Codux, de petdex.dev (slug `code-default`, subida por duxphp). Su arte no está en el repositorio: `scripts/fetch-pet.mjs` la descarga al preparar la app.

`src/shell/pet.js` deduce la cuadrícula de cada hoja:
- cuadros de 192×208 en 8×9 (o con filas de más, como 8×11) y en las antiguas de 9×8;
- si la hoja no encaja en 192×208, la de 8×9 o 9×8 con esa proporción, como hace la web de Petdex al escalarla.

El número de cuadros de cada fila se cuenta mirando la transparencia.
