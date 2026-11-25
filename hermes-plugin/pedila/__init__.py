"""Pedila: Hermes plugin for the Pedila app.

It adds no tools, hooks or prompt text: its work is in dashboard/plugin_api.py, the /api/plugins/pedila/cuotas
route that the app reads, and in recorder.py, which notes down how many tokens were spent with each key.
"""
import importlib.util
import logging
from pathlib import Path


def register(ctx):  # noqa: ARG001 - Hermes calls it when loading the plugin, in each one of its processes
    try:
        path = Path(__file__).resolve().parent / "dashboard" / "quotas_core.py"
        spec = importlib.util.spec_from_file_location("hermes_plugin_pedila_boot", path)
        core = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(core)
        core.ensure_recorder()
    except Exception as exc:  # the quotas work without it
        logging.getLogger("hermes_dashboard_plugin_pedila").debug("pedila: no usage record by key (%s)", type(exc).__name__)
