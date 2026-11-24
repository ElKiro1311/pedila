<p align="center"><img src="docs/banner.jpg" alt="Una mensajera con sandalias aladas de oro corre por el cielo con una carta, dibujada en tinta"></p>

<p align="center"><img src="docs/icon.png" width="112" alt="Icono de Pedila: una sandalia alada a toda velocidad, en tinta con un toque de oro"></p>

<h1 align="center">Pedila, la mensajera</h1>

<p align="center"><b>Una ventana sencilla para usar <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>: el de tu PC y el de tu servidor. En español y en inglés.</b><br>
<i>Cliente no oficial. Pedila no está hecho ni respaldado por Nous Research.</i></p>

<p align="center"><a href="README.md">English</a> · <b>Español</b></p>

## El nombre

**Pedila** viene del griego **πέδιλα** (*pédila*), las sandalias aladas de Hermes. Los romanos las llamaron *talaria*. Con ellas Hermes, el mensajero de los dioses, llevaba los mensajes de un mundo a otro. Homero lo cuenta dos veces con los mismos versos, cuando Zeus lo envía con un recado (*Odisea* V, 44-46; *Ilíada* XXIV, 340-342):

> αὐτίκ᾽ ἔπειθ᾽ ὑπὸ ποσσὶν ἐδήσατο καλὰ πέδιλα,
> ἀμβρόσια χρύσεια, τά μιν φέρον ἠμὲν ἐφ᾽ ὑγρὴν
> ἠδ᾽ ἐπ᾽ ἀπείρονα γαῖαν ἅμα πνοιῇς ἀνέμοιο.
>
> «Enseguida se ató a los pies las hermosas sandalias, inmortales, de oro, que lo llevaban sobre el mar y sobre la tierra sin límites, tan rápido como los soplos del viento».

Eso quiere ser esta app: las sandalias que llevan tus mensajes hasta Hermes, esté en tu PC o en tu servidor.

**Pedila, la mensajera.** En la app las sandalias cobran vida: Pedila es una chica que se las calza y corre con tus mensajes de un lado a otro. Es la mascota de la app. Espera tranquila con su carta, corre mientras Hermes trabaja, lee su pergamino cuando Hermes usa herramientas, te ofrece la carta cuando Hermes necesita tu permiso, salta de alegría cuando termina y se pone triste si algo falla.

<p align="center"><img src="docs/pet/still.png" height="150" alt="Pedila, de pie con su carta"> <img src="docs/pet/run-1.png" height="130" alt="Pedila corriendo con la carta"> <img src="docs/pet/read.png" height="150" alt="Pedila leyendo un pergamino"> <img src="docs/pet/jump.png" height="140" alt="Pedila saltando de alegría"></p>

**El icono, el banner y Pedila** están dibujados en tinta al estilo manga, con el oro de las sandalias como único color: en el icono, una sandalia alada a toda velocidad; en el banner, Pedila cruzando el cielo con una carta. Los generó el propio Hermes con un modelo de imágenes en local (Qwen-Image), y después se recortaron para la app ([`docs/icon.png`](docs/icon.png), [`docs/banner.jpg`](docs/banner.jpg), [`docs/pet/`](docs/pet)). Las poses de Pedila se pidieron sobre fondo verde; `scripts/make-pet.js` quita el verde y monta la hoja animada.

## Qué hace

- **Tus Hermes en una ventana:**
  - **Este PC** usa el mismo Hermes que Hermes Desktop, con los mismos chats. Solo aparece si Hermes está instalado en el PC.
  - **Servidor** es un Hermes en otra máquina (`hermes dashboard` con usuario y contraseña). Solo aparece cuando pones su dirección en Ajustes → Servidor.
  - Con un único Hermes no hay selector: se usa ese.
- **Cuotas de tus APIs:** si tu Hermes usa OpenRouter, Venice, OpenCode, DeepSeek u Openference, el panel enseña lo que te queda de cada una:
  - **OpenRouter:** saldo de créditos; límite de la clave, cuándo se reinicia y lo gastado hoy, en la semana y en el mes.
  - **Venice:** saldo USD, créditos del plan y DIEM; cuándo se reinicia el DIEM; límites por modelo.
  - **OpenCode Go:** % usado de las ventanas de 5 h, semana y mes (con un decimal cuando se puede calcular), y cuándo se reinician. De **OpenCode Zen**, OpenCode no publica el saldo.
  - **DeepSeek:** el saldo que queda y un aviso cuando no llega para usar la API.
  - **Openference:** saldo de créditos y plan; con un plan de pago, % usado de sus ventanas y cuándo se reinician; qué modelos son gratis y hasta cuándo.
  - Si le diste a Hermes **varias claves de la misma API** (`hermes auth add`), cada una es una cuota aparte, con su etiqueta: cuál está en uso, cuáles están de reserva y cuáles descansan hasta que se reinicie su límite.
  - En cada una, lo que Hermes ha gastado en 24 h, 7 y 30 días.
  - Lo lee un complemento pequeño de Pedila dentro de Hermes ([hermes-plugin/pedila](hermes-plugin/pedila)): tus claves no salen de Hermes, solo llegan números. Se instala con el botón «Activar cuotas» del panel, sin reiniciar Hermes, y se actualiza también desde ahí (al venir de una versión anterior a la 1.2.0, Hermes tiene que reiniciarse una vez). Las APIs que no tienes no aparecen.
- **Modelo y esfuerzo de un chat empezado:** se pueden cambiar con el chat ya en marcha (Hermes los cambia con sus órdenes `/model` y `/reasoning`), con niveles de razonamiento hasta «al máximo».
- **Herramientas como en Claude Code:** las que van seguidas se juntan en una línea que se abre («Ejecutó 2 órdenes, leyó captura.png · +12 −3 · 1 falló»). Dentro, cada una con su título, lo que se le pasó (la orden, el código o el cambio en verde y rojo), lo que devolvió y, si falló, en rojo. Las imágenes que mira o genera salen ahí mismo.
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
  - bandeja del sistema y atajo **Ctrl+Alt+H**; «Iniciar con Windows» en Ajustes → Ventana y en el menú del icono de la bandeja;
  - actualizaciones desde GitHub Releases, que se instalan solas cuando no usas Pedila (10 minutos sin tocarla, sin nada escrito sin enviar y sin Hermes trabajando) y la vuelven a abrir como estaba, sin quitarte el foco;
  - **versiones de Hermes:** Pedila mira cada 6 horas si hay una nueva (la tarjeta «Conexiones» y Ajustes → Acerca de lo dicen). El Hermes de este PC, si es una instalación que Hermes sabe actualizar (la del instalador oficial), se actualiza solo con su propia orden `hermes update` cuando lleva 10 minutos sin usarse: sin chats trabajando ni con actividad. Un Hermes en Docker (un servidor) no puede actualizarse a sí mismo: Pedila avisa y se actualiza desde su servidor;
  - Pedila, la mascota, que reacciona a lo que hace Hermes; si prefieres otra, se elige entre más de 5.000 de [Petdex](https://petdex.dev).
- **Diseño a tu gusto** (Ajustes → Diseño): ordena y esconde las pestañas (Este PC/Servidor), elige qué tarjetas del panel salen y en qué orden, esconde los botones que no uses y pon la lista de chats a la derecha si lo prefieres. Las pestañas y las tarjetas también se arrastran directamente en su sitio.
- **Cuotas con el mismo diseño para todos:** cada proveedor (OpenRouter, Venice, OpenCode, DeepSeek y Openference) sale igual: lo que te queda en grande y, debajo, cada medida con su barra y cuándo se reinicia. Para los saldos sin total (Venice, DeepSeek y Openference si no hay créditos comprados), la barra cuenta lo gastado desde el saldo más alto que Pedila ha visto.
- **Temas:** seis, cada uno en modo oscuro y claro, con vista previa en Ajustes → Apariencia:
  - **Mensajera** (predeterminado): tinta, grises y oro, como Pedila;
  - **Clásico**: grises fríos y violeta, el de las primeras versiones;
  - **Egeo**: azul noche y oro;
  - **Ánfora**: negro y terracota;
  - **Olivo**: verdes tranquilos;
  - **Claude**: pizarra, marfil y terracota, como Claude.
  - El color de acento puede ser el del tema o uno a elegir.
- **En español y en inglés:** la app sigue el idioma del sistema, o el que elijas en Ajustes → Apariencia.

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
npm run assets             # iconos desde docs/icon.png, la hoja de Pedila desde docs/pet y copia de marked/DOMPurify
npm test                   # pruebas de las piezas puras
npm start                  # abre la app
npm run dist               # instalador en dist/ (NSIS por usuario)
```

Solo en desarrollo:
- `PEDILA_CDP=9334` abre un puerto de depuración. Con `node scripts/cdp.mjs 9334 eval "<js>"` se lee o maneja la ventana.
- `PEDILA_DEMO=1` usa datos inventados.
- `PEDILA_DATA=<carpeta>` usa otra carpeta de datos.
- `PEDILA_DEBUG=1` saca también el registro por consola.

**Los textos.** El código tiene cada texto en inglés, `tr('…')`, y [`src/shell/es.json`](src/shell/es.json) los españoles; `npm test` comprueba que no falte ni sobre ninguno. La página (`index.html`) está escrita en inglés y se traduce al abrirse.

**Publicar una versión:** sube a la Release `Pedila-Setup.exe` y un `version.json` con `{"version": "0.16.0-beta", "sha256": "<sha256 del instalador>", "notes": "…", "notas": "…"}` (las notas en inglés y en español; las versiones anteriores a la 0.16 solo leen `notas`). La versión tiene que ser exactamente la de `package.json`, con su sufijo -alpha/-beta si lo lleva: si no, la app instalada seguiría viendo una versión «nueva» después de actualizarse. La Release va como normal, no como pre-release: la app mira la última de GitHub (`releases/latest`), que se salta las pre-releases. La app compara la versión (como Semantic Versioning), descarga el instalador, comprueba el SHA-256 y se actualiza en silencio.

## Créditos y licencia

- Código de Pedila: [MIT](LICENSE).
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) es de Nous Research (MIT). Pedila no incluye su código; usa la misma vía que su app de escritorio.
- [Electron](https://www.electronjs.org/) (MIT), [marked](https://marked.js.org/) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0).
- **Pedila**, la mascota, es del proyecto (MIT, como el código) y viaja en el instalador.
- **Las demás mascotas** son de sus autores en [Petdex](https://petdex.dev) y la app las descarga de allí cuando las eliges; no vienen en el repositorio ni en el instalador.
- El texto griego es de Homero (dominio público). La traducción es del proyecto.
