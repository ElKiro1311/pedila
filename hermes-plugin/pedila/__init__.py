"""Pedila: complemento de Hermes para la app Pedila.

No añade herramientas, ganchos ni texto al prompt: todo su trabajo está en dashboard/plugin_api.py,
la ruta /api/plugins/pedila/cuotas que lee la app.
"""


def register(ctx):  # noqa: ARG001 - Hermes lo llama al cargar el complemento; no hay nada que registrar
    return None
