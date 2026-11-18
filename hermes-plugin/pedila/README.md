# Complemento «pedila» para Hermes

Lo instala la app [Pedila](https://github.com/ElKiro1311/pedila) desde su panel («Cuotas → Activar»).
Sirve `GET /api/plugins/pedila/cuotas` en la página de Hermes: lo que queda de cada API de pago
conectada a ese Hermes.

| API | Qué da |
|---|---|
| OpenRouter | saldo de créditos; límite, gasto (día, semana, mes) y reinicio de la clave |
| Venice | saldos USD, DIEM y créditos incluidos; plan; próximo reinicio del DIEM; límites por modelo |
| OpenCode Go | % gastado de las ventanas de 5 h, semana y mes, y cuándo se reinician |
| OpenCode Zen | OpenCode no publica el saldo: solo lo que Hermes ha gastado con ella |

Además, para cada una, lo que Hermes gastó en 24 h, 7 y 30 días (tokens, llamadas y coste
estimado), sacado de su propio registro.

Solo salen las APIs que tienen clave. Las claves no salen de Hermes: el complemento las usa para
preguntar al proveedor y devuelve números. No añade herramientas, ganchos ni texto al prompt.

A mano: `hermes plugins install ElKiro1311/pedila/hermes-plugin/pedila --enable`.
