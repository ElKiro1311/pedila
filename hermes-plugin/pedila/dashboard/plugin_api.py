"""Pedila: quotas of this Hermes's APIs, at /api/plugins/pedila/cuotas.

Pedila (https://github.com/ElKiro1311/pedila) shows in its panel how much is left of each paid API
connected to Hermes: balance, limits, when it resets and what Hermes has spent with it.

This file is the fixed part: the route, the cache and the reading of keys. Hermes imports it only once (on
startup or when installing the plugin). The calculation lives in quotas_core.py, which is loaded again when
it changes: that way a new version of the plugin takes effect without restarting Hermes.

The keys stay in here: Hermes is asked for them (``resolve_runtime_provider``), they're used only to ask the
provider and numbers are returned. They never go out in the answer or in an error.
"""
from __future__ import annotations

import importlib.util
import logging
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter()
log = logging.getLogger(__name__)

# This fixed part's version. The calculation's is quotas_core.py's PLUGIN_VERSION.
SHELL_VERSION = "1.2.0"
# How often the providers are really asked (Pedila asks every minute or less).
CACHE_SECONDS = 60
# With ?fresh=1 (the refresh button), once per this at most.
FRESH_MIN_SECONDS = 10

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "body": None, "core": None}

# ── The calculation, reloadable ───────────────────────────────────────────────────────────────
_CORE_FILE = Path(__file__).with_name("quotas_core.py")
_CORE_MODULE = "hermes_dashboard_plugin_pedila_core"
_core_lock = threading.Lock()
# "good" = the last one that gave an answer (for when a new one loads but fails).
_core_state: dict[str, Any] = {"sig": None, "mod": None, "good": None}


def _core():
    """quotas_core.py, loaded again if the file changed. If the new version doesn't load, the previous one
    goes on (and it's tried again when the file changes again)."""
    with _core_lock:
        try:
            st = _CORE_FILE.stat()
            sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            sig = None
        mod = _core_state["mod"]
        if mod is not None and (sig is None or sig == _core_state["sig"]):
            return mod
        if sig is None:
            raise RuntimeError("quotas_core.py is missing")
        spec = importlib.util.spec_from_file_location(_CORE_MODULE, _CORE_FILE)
        fresh = importlib.util.module_from_spec(spec)
        before = sys.modules.get(_CORE_MODULE)
        # Registered while it runs: text annotations are resolved by the module's name.
        sys.modules[_CORE_MODULE] = fresh
        try:
            spec.loader.exec_module(fresh)
        except Exception as exc:
            if before is not None:
                sys.modules[_CORE_MODULE] = before
            else:
                sys.modules.pop(_CORE_MODULE, None)
            _core_state["sig"] = sig
            log.warning("pedila: couldn't load quotas_core.py (%s)", type(exc).__name__)
            if mod is not None:
                return mod
            raise
        _core_state.update(sig=sig, mod=fresh)
        return fresh


def _build(core) -> dict[str, Any]:
    """The answer of that calculation; if it fails, the one of the last calculation that worked."""
    info = {"shell": SHELL_VERSION, "shell_file": str(Path(__file__))}
    try:
        body = core.build(runtime=_runtime, **info)
    except Exception as exc:
        good = _core_state["good"]
        if good is None or good is core:
            raise
        log.warning("pedila: quotas_core.py fails (%s); going on with the previous one", type(exc).__name__)
        return good.build(runtime=_runtime, **info)
    _core_state["good"] = core
    return body


# ── Keys: reading them without changing anything in Hermes ────────────────────────────────────
# Resolving a provider takes a key from its pool with CredentialPool.select(), which counts the request and
# rotates the turn (round_robin); and loading a pool, or just looking at it, stores in auth.json what it tidies up
# on the way. While this thread reads, select() does the same as peek() (the key in use, without counting or
# rotating) and _persist() stores nothing. The other threads aren't affected.
_tl = threading.local()


def _install_guard() -> None:
    global _tl
    try:
        from agent.credential_pool import CredentialPool
    except Exception:  # a Hermes without a pool of keys: there's nothing to keep from changing
        return
    installed = getattr(CredentialPool.select, "_pedila_tl", None)
    if installed is not None:
        _tl = installed  # this file was loaded twice in the same process: the same switch serves both
        return
    tl = _tl
    original_select, original_persist = CredentialPool.select, getattr(CredentialPool, "_persist", None)

    def select(self, *args, **kwargs):
        if getattr(tl, "peek", False):
            try:
                return self.peek(*args, **kwargs)
            except TypeError:  # a Hermes whose peek() takes nothing
                return self.peek()
        return original_select(self, *args, **kwargs)

    def _persist(self, *args, **kwargs):
        return None if getattr(tl, "peek", False) else original_persist(self, *args, **kwargs)

    select._pedila_tl = tl
    logging.getLogger("agent.credential_pool").addFilter(
        # Looking at a pool with a key that has been dead for a day says that it's removed; but nothing is stored.
        lambda r: not (getattr(tl, "peek", False) and str(r.msg).startswith("credential pool: pruning DEAD")))
    CredentialPool.select = select
    if original_persist is not None:
        CredentialPool._persist = _persist


@contextmanager
def _reading():
    _install_guard()
    tl = _tl
    tl.peek = True
    try:
        yield
    finally:
        tl.peek = False


def _pool(name: str, url: str, builtin: bool, rt: dict[str, Any]) -> Any:
    """The keys that provider may send to its address (Hermes's own view of its pool); None if there's no saying."""
    resolved = str(rt.get("provider") or name).strip().lower()
    if resolved not in (name.strip().lower(), "custom") and not resolved.startswith("custom:"):
        return None  # Hermes took it for another provider: that one's keys aren't this one's
    try:
        from agent.custom_entry_pool import load_runtime_pool
    except ImportError:
        # A Hermes from before that view: only its own providers, whose pool is theirs alone.
        if not builtin:
            return None
        from agent.credential_pool import load_pool
        return load_pool(name)
    return load_runtime_pool(rt.get("provider") or name, rt.get("base_url") or url, name)


def _runtime(name: str, url: str = "", builtin: bool = False) -> dict[str, Any]:
    """What Hermes would use for that provider: the key it would take now, the address it sends it to and its pool
    of keys, if it has one. ``url`` = its address in config.yaml; ``builtin`` = it's one of Hermes's own and
    config.yaml doesn't redefine it. "error" = the type of the failure, if Hermes couldn't resolve it."""
    out: dict[str, Any] = {"api_key": None, "base_url": None, "provider": None, "source": None, "credential_pool": None, "error": ""}
    with _reading():
        try:
            from hermes_cli.runtime_provider import resolve_runtime_provider
            rt = resolve_runtime_provider(requested=name)
            if isinstance(rt, dict):
                out.update({k: rt.get(k) for k in ("api_key", "base_url", "provider", "source", "credential_pool")})
        except Exception as exc:
            out["error"] = type(exc).__name__
        # With all of its keys resting, Hermes resolves without the pool, or it can't (AuthError): the pool is read
        # here, so that they don't disappear from the panel right when it matters. Any other failure (the provider
        # is turned off, for example) means that it isn't to be used.
        if out["credential_pool"] is None and out["error"] in ("", "AuthError"):
            try:
                out["credential_pool"] = _pool(name, url, builtin, out)
            except Exception as exc:
                log.debug("pedila: couldn't read the pool of %s: %s", name, type(exc).__name__)
    return out


@router.get("/cuotas")
def cuotas(fresh: int = 0) -> dict[str, Any]:
    core = _core()
    body = _cache["body"] if _cache["core"] is core else None
    if body is not None and time.time() - _cache["at"] < (FRESH_MIN_SECONDS if fresh else CACHE_SECONDS):
        return body
    # One reading at a time; while it lasts, the other requests get the previous one without waiting.
    if not _lock.acquire(blocking=body is None):
        return body
    try:
        if _cache["core"] is core and _cache["body"] is not None and time.time() - _cache["at"] < FRESH_MIN_SECONDS:
            return _cache["body"]
        body = _build(core)
        body["shell"] = SHELL_VERSION
        _cache.update(at=time.time(), body=body, core=core)
        return body
    finally:
        _lock.release()


@router.get("/version")
def version() -> dict[str, Any]:
    try:
        v = getattr(_core(), "PLUGIN_VERSION", None)
    except Exception:
        v = None
    return {"plugin": "pedila", "version": v, "shell": SHELL_VERSION}
