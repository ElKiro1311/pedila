"""Pedila: Hermes plugin for the Pedila app.

It adds no tools, hooks or prompt text: all its work is in dashboard/plugin_api.py, the
/api/plugins/pedila/cuotas route that the app reads.
"""


def register(ctx):  # noqa: ARG001 - Hermes calls it when loading the plugin; there's nothing to register
    return None
