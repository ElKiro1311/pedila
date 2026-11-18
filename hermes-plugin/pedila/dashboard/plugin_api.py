"""Pedila: cuotas de las APIs de este Hermes, en /api/plugins/pedila/cuotas.

Pedila (https://github.com/ElKiro1311/pedila) enseña en su panel cuánto queda de cada API de pago
conectada a Hermes: saldo, límites, cuándo se reinicia y lo que ha gastado Hermes con ella.

Las claves se quedan aquí dentro: este módulo las pide a Hermes (``resolve_runtime_provider``), las
usa solo para preguntar al proveedor y devuelve números. Nunca salen en la respuesta ni en un error.

Solo aparecen las APIs que tienen clave. Las que conoce:
- OpenRouter: saldo de créditos (``/credits``) y límite, gasto y reinicio de la clave (``/key``).
- Venice: saldos USD, DIEM y créditos incluidos, plan, próximo reinicio del DIEM y límites por modelo
  (``/api_keys/rate_limits``, vale con una clave de inferencia).
- OpenCode Go: porcentaje gastado de las ventanas de 5 h, semana y mes y cuándo se reinician
  (``/zen/go/v1/usage``, el mismo que usa el /usage de Hermes).
- OpenCode Zen: OpenCode no publica el saldo; solo sale lo que Hermes ha gastado con ella.
"""
from __future__ import annotations

import hashlib
import logging
import sqlite3
import threading
import time
from datetime import UTC, datetime
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter

router = APIRouter()
log = logging.getLogger(__name__)

PLUGIN_VERSION = "1.0.0"
# Cada cuánto se pregunta de verdad a los proveedores (Pedila pide cada minuto o menos).
CACHE_SECONDS = 60
# Con ?fresh=1 (el botón de actualizar), como mucho una vez cada esto.
FRESH_MIN_SECONDS = 10
TIMEOUT = 10.0
# Lo que Hermes pone cuando un proveedor propio no tiene clave.
PLACEHOLDER_KEYS = {"", "no-key-required", "none", "null", "dummy", "sk-dummy"}
NAMES = {"openrouter": "OpenRouter", "venice": "Venice", "opencode-go": "OpenCode Go", "opencode-zen": "OpenCode Zen"}
ORDER = ["openrouter", "venice", "opencode-go", "opencode-zen"]

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "body": None}


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def _iso(v: Any) -> Optional[str]:
    """Una fecha ISO bien formada (con zona) o None."""
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        d = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat()


def kind_of(base_url: str) -> Optional[str]:
    """Qué API es, por la dirección a la que Hermes le habla."""
    try:
        u = urlparse(base_url or "")
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    path = (u.path or "").lower()
    if host == "openrouter.ai" or host.endswith(".openrouter.ai"):
        return "openrouter"
    if host == "api.venice.ai" or host.endswith(".venice.ai"):
        return "venice"
    if host == "opencode.ai" or host.endswith(".opencode.ai"):
        return "opencode-go" if "/go" in path else "opencode-zen"
    return None


def _config() -> dict:
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly()
    except Exception:
        try:
            from hermes_cli.config import load_config
            cfg = load_config()
        except Exception:
            cfg = {}
    return cfg if isinstance(cfg, dict) else {}


# Las de Hermes que se reconocen por su nombre (sin dirección en config.yaml).
BUILTIN = {"openrouter": "https://openrouter.ai/api/v1", "opencode-go": "https://opencode.ai/zen/go/v1",
           "opencode-zen": "https://opencode.ai/zen/v1"}


def _url_of(entry: dict) -> str:
    for k in ("base_url", "api", "url"):
        v = entry.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _models_of(entry: dict) -> list[str]:
    ms = entry.get("models")
    names = list(ms.keys()) if isinstance(ms, dict) else [m for m in ms if isinstance(m, str)] if isinstance(ms, list) else []
    for k in ("default_model", "model"):
        if isinstance(entry.get(k), str):
            names.insert(0, entry[k])
    return [n for n in names if isinstance(n, str)]


def _candidates(cfg: dict) -> list[tuple[str, str, list[str]]]:
    """(nombre para Hermes, dirección, modelos) SOLO de los proveedores que por su dirección configurada
    son de pago. Se decide sin leer ninguna clave: así no se ejecutan key_cmd, ni se refrescan
    tokens OAuth, ni se toca nada de los demás proveedores."""
    out: dict[str, list] = {name: [url, []] for name, url in BUILTIN.items()}
    providers = cfg.get("providers")
    if isinstance(providers, dict):
        for key, pv in providers.items():
            if isinstance(key, str) and isinstance(pv, dict):
                url = _url_of(pv) or BUILTIN.get(key.lower(), "")
                if kind_of(url):
                    out.setdefault(key, [url, []])[1].extend(_models_of(pv))
    custom = cfg.get("custom_providers")
    if isinstance(custom, list):
        for pv in custom:
            if isinstance(pv, dict) and isinstance(pv.get("name"), str) and kind_of(_url_of(pv)):
                out.setdefault(pv["name"], [_url_of(pv), []])[1].extend(_models_of(pv))
    model = cfg.get("model")
    if isinstance(model, dict) and isinstance(model.get("provider"), str) and isinstance(model.get("default"), str):
        if model["provider"] in out:
            out[model["provider"]][1].insert(0, model["default"])
    return [(k, v[0], list(dict.fromkeys(v[1]))) for k, v in out.items()]


# Leer una clave no debe cambiar nada en Hermes. resolve_runtime_provider elige la clave del pool con
# CredentialPool.select(), que cuenta la petición, rota el turno (round_robin) y lo guarda en
# auth.json. Mientras este hilo resuelve, select() hace lo mismo que peek(): devuelve la clave en
# uso sin contar, rotar, refrescar ni guardar. Los demás hilos no se ven afectados.
_tl = threading.local()


def _install_peek_guard() -> None:
    try:
        from agent.credential_pool import CredentialPool
    except Exception:
        return
    if getattr(CredentialPool.select, "_pedila_peek", False):
        return
    original = CredentialPool.select

    def select(self, *args, **kwargs):
        if getattr(_tl, "peek", False):
            return self.peek()
        return original(self, *args, **kwargs)

    select._pedila_peek = True
    CredentialPool.select = select


def _clean_key(k: Any) -> Optional[str]:
    if callable(k):  # key_cmd: Hermes da un objeto que ejecuta la orden al llamarlo
        try:
            k = k()
        except Exception:
            return None
    if not isinstance(k, str):
        return None
    k = k.strip()
    return None if k.lower() in PLACEHOLDER_KEYS or len(k) < 8 else k


def _resolve(name: str) -> Optional[str]:
    """La clave de ese proveedor si tiene una de verdad; None si no."""
    _install_peek_guard()
    _tl.peek = True
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider
        rt = resolve_runtime_provider(requested=name)
    except Exception:
        return None
    finally:
        _tl.peek = False
    return _clean_key(rt.get("api_key"))


def detect() -> list[dict[str, Any]]:
    """Las APIs de pago con clave, una por cuenta (dos nombres con la misma clave cuentan una vez)."""
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for name, url, models in _candidates(_config()):
        kind = kind_of(url)
        key = _resolve(name) if kind else None
        if not key:
            continue
        fp = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        entry = seen.get((kind, fp))
        if entry:
            entry["models"].extend(m for m in models if m not in entry["models"])
            continue
        seen[(kind, fp)] = {"kind": kind, "name": name, "base": url, "key": key, "models": list(models)}
    return sorted(seen.values(), key=lambda e: (ORDER.index(e["kind"]), e["name"].lower()))


def _get(client, url: str, key: str) -> dict:
    r = client.get(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    if r.status_code in (401, 403):
        raise _Fail("la clave no vale o no tiene permiso para ver esto")
    if r.status_code == 404:
        raise _Fail("el proveedor no tiene este dato")
    if r.status_code == 429:
        raise _Fail("el proveedor pide esperar (demasiadas consultas)")
    if r.status_code >= 400:
        raise _Fail(f"el proveedor respondió {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        raise _Fail("respuesta ilegible del proveedor") from None
    return body if isinstance(body, dict) else {}


def _data(body: dict) -> dict:
    d = body.get("data")
    return d if isinstance(d, dict) else {}


class _Fail(Exception):
    """Un fallo que se puede enseñar tal cual (sin clave ni dirección con secretos)."""


def fetch_openrouter(client, e: dict) -> dict:
    base = e["base"].rstrip("/")
    # /key vale con cualquier clave (límite, gasto y reinicio); /credits (saldo de la cuenta) puede no
    # dejarse leer con según qué clave: si falla, se sigue sin saldo.
    k = _data(_get(client, f"{base}/key", e["key"]))
    try:
        credits = _data(_get(client, f"{base}/credits", e["key"]))
    except _Fail:
        credits = {}
    total, used = _num(credits.get("total_credits")), _num(credits.get("total_usage"))
    out: dict[str, Any] = {
        "credits_total": total, "credits_used": used,
        "balance": max(0.0, total - used) if total is not None and used is not None else None,
        "free_tier": bool(k.get("is_free_tier")) if isinstance(k.get("is_free_tier"), bool) else None,
    }
    limit, remaining = _num(k.get("limit")), _num(k.get("limit_remaining"))
    reset = k.get("limit_reset")
    out["key_limit"] = {
        "limit": limit, "remaining": remaining,
        "reset": reset if isinstance(reset, str) and reset in ("daily", "weekly", "monthly") else None,
    } if limit is not None and limit > 0 else None
    out["key_usage"] = {p: _num(k.get(f)) for p, f in (("total", "usage"), ("day", "usage_daily"), ("week", "usage_weekly"), ("month", "usage_monthly"))}
    return out


def fetch_venice(client, e: dict) -> dict:
    u = urlparse(e["base"])
    base = f"{u.scheme}://{u.netloc}/api/v1"
    d = _data(_get(client, f"{base}/api_keys/rate_limits", e["key"]))
    b = d.get("balances") if isinstance(d.get("balances"), dict) else {}
    tier = d.get("apiTier") if isinstance(d.get("apiTier"), dict) else {}
    wanted = [m.lower() for m in e.get("models") or []]
    limits = []
    for row in d.get("rateLimits") if isinstance(d.get("rateLimits"), list) else []:
        if not isinstance(row, dict) or not isinstance(row.get("apiModelId"), str):
            continue
        mid = row["apiModelId"]
        if wanted and mid.lower() not in wanted:
            continue
        vals = {}
        for rl in row.get("rateLimits") if isinstance(row.get("rateLimits"), list) else []:
            if isinstance(rl, dict) and rl.get("type") in ("RPM", "RPD", "TPM") and _num(rl.get("amount")) is not None:
                vals[rl["type"].lower()] = _num(rl["amount"])
        if vals:
            limits.append({"model": mid, **vals})
    return {
        "usd": _num(b.get("USD")), "diem": _num(b.get("DIEM")), "bundled": _num(b.get("BUNDLED_CREDITS")),
        "tier": tier.get("id") if isinstance(tier.get("id"), str) else None,
        "charged": tier.get("isCharged") if isinstance(tier.get("isCharged"), bool) else None,
        "access": d.get("accessPermitted") if isinstance(d.get("accessPermitted"), bool) else None,
        "next_epoch": _iso(d.get("nextEpochBegins")),
        "key_expires": _iso(d.get("keyExpiration")),
        "model_limits": limits[:12],
    }


def fetch_opencode_go(client, e: dict) -> dict:
    usage = _get(client, "https://opencode.ai/zen/go/v1/usage", e["key"]).get("usage")
    usage = usage if isinstance(usage, dict) else {}
    windows = []
    for key, label in (("rolling", "5 h"), ("weekly", "semana"), ("monthly", "mes")):
        w = usage.get(key) if isinstance(usage, dict) else None
        if isinstance(w, dict) and _num(w.get("percent")) is not None:
            windows.append({"id": key, "label": label, "percent": max(0.0, min(100.0, _num(w["percent"]))), "resets_at": _iso(w.get("resetsAt"))})
    return {"windows": windows}


FETCHERS = {"openrouter": fetch_openrouter, "venice": fetch_venice, "opencode-go": fetch_opencode_go}


def spent_by_kind(now: float) -> dict[str, dict[str, dict[str, float]]]:
    """Lo que Hermes gastó con cada API (tokens, llamadas, coste estimado): 24 h, 7 y 30 días.

    Sale de ``session_model_usage`` de su state.db (cuenta también resúmenes, títulos y demás
    tareas auxiliares). Cada fila va al día en que se usó por última vez, así que es aproximado."""
    try:
        from hermes_constants import get_hermes_home
        db = get_hermes_home() / "state.db"
    except Exception:
        return {}
    if not db.exists():
        return {}
    spans = {"day": now - 86400, "week": now - 7 * 86400, "month": now - 30 * 86400}
    out: dict[str, dict[str, dict[str, float]]] = {}
    try:
        con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            rows = con.execute(
                "SELECT billing_base_url, input_tokens + output_tokens, api_call_count, "
                "COALESCE(NULLIF(actual_cost_usd, 0), estimated_cost_usd), COALESCE(last_seen, first_seen, 0) "
                "FROM session_model_usage WHERE COALESCE(last_seen, first_seen, 0) >= ?", (spans["month"],)).fetchall()
        finally:
            con.close()
    except Exception as exc:
        log.debug("pedila: no pude leer el uso de state.db: %s", exc)
        return {}
    for base, tokens, calls, cost, seen in rows:
        kind = kind_of(base or "")
        if not kind:
            continue
        per = out.setdefault(kind, {p: {"tokens": 0, "calls": 0, "cost": 0.0} for p in spans})
        for p, since in spans.items():
            if (seen or 0) >= since:
                per[p]["tokens"] += int(tokens or 0)
                per[p]["calls"] += int(calls or 0)
                per[p]["cost"] += float(cost or 0.0)
    return out


# Lo más que se espera a los proveedores en una lectura (el resto sale como «tardó demasiado»).
BUILD_BUDGET_SECONDS = 25


def build() -> dict[str, Any]:
    import httpx

    now = time.time()
    spent = spent_by_kind(now)
    accounts = detect()
    per_kind: dict[str, int] = {}
    for e in accounts:
        per_kind[e["kind"]] = per_kind.get(e["kind"], 0) + 1
    providers = []
    deadline = time.monotonic() + BUILD_BUDGET_SECONDS
    with httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=False) as client:
        for e in accounts:
            # El gasto de state.db va por tipo de API: con dos cuentas del mismo tipo no se sabe de cuál es.
            row: dict[str, Any] = {"kind": e["kind"], "name": NAMES[e["kind"]], "hermes_name": e["name"], "ok": True,
                                   "spent": spent.get(e["kind"]) if per_kind[e["kind"]] == 1 else None}
            fetcher = FETCHERS.get(e["kind"])
            if not fetcher:
                row["no_api"] = True
            elif time.monotonic() > deadline:
                row.update(ok=False, error="el proveedor tardó demasiado")
            else:
                try:
                    row.update(fetcher(client, e))
                except _Fail as exc:
                    row.update(ok=False, error=str(exc))
                except httpx.TimeoutException:
                    row.update(ok=False, error="el proveedor tardó demasiado")
                except httpx.HTTPError:
                    row.update(ok=False, error="no pude llegar al proveedor")
                except Exception as exc:  # nunca el texto: podría llevar la clave
                    log.warning("pedila: fallo leyendo %s: %s", e["kind"], type(exc).__name__)
                    row.update(ok=False, error="fallo inesperado leyendo el proveedor")
            providers.append(row)
    return {"plugin": "pedila", "version": PLUGIN_VERSION, "fetched_at": datetime.fromtimestamp(now, UTC).isoformat(),
            "providers": providers}


@router.get("/cuotas")
def cuotas(fresh: int = 0) -> dict[str, Any]:
    body = _cache["body"]
    if body is not None and time.time() - _cache["at"] < (FRESH_MIN_SECONDS if fresh else CACHE_SECONDS):
        return body
    # Una sola lectura a la vez; mientras dura, las demás peticiones reciben la anterior sin esperar.
    if not _lock.acquire(blocking=body is None):
        return body
    try:
        body = _cache["body"]
        if body is not None and time.time() - _cache["at"] < FRESH_MIN_SECONDS:
            return body
        body = build()
        _cache.update(at=time.time(), body=body)
        return body
    finally:
        _lock.release()


@router.get("/version")
def version() -> dict[str, Any]:
    return {"plugin": "pedila", "version": PLUGIN_VERSION}
