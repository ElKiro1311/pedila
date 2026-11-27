"""Pedila: the calculation behind /api/plugins/pedila/cuotas.

plugin_api.py (the fixed part, the one Hermes imports only once) loads this file and loads it again when
it changes: that way a new version of the plugin takes effect without restarting Hermes.

plugin_api.py asks Hermes for the keys and this module only uses them to ask the provider. They never go out
in the answer or in an error.

A provider may have several keys (`hermes auth add`: Hermes's credential pool): each one comes out as an
account of its own, with which one is in use and which ones are resting.

What it gives of each paid API with a key:
- OpenRouter: credit balance (``/credits``) and the key's limit, spending and reset (``/key``).
- OrcaRouter: the same, at the same addresses as OpenRouter's under ``/api/v1`` (its API copies OpenRouter's).
- Venice: USD, DIEM and included-credit balances, plan, next DIEM reset and limits per model
  (``/api_keys/rate_limits``, an inference key is enough).
- OpenCode Go: what has been used of the 5-hour, weekly and monthly windows and when they reset. Its API
  (``/zen/go/v1/usage``) gives whole numbers rounded down: 0% until it gets to 1%. The usage with decimals
  is worked out here from the tokens Hermes records for each model (state.db, ``session_model_usage``) and
  the price and the monthly limit of each model that OpenCode publishes (``/zen/go/v1/models``, without a
  key). The 5-hour window is 20% of the month and the week 50% (https://opencode.ai/docs/go/). It's only given
  when it agrees with OpenCode's whole number; if it doesn't (the account is used from somewhere else too, or
  OpenCode changed its limits since), the whole number is all there is.
- OpenCode Zen: OpenCode doesn't publish the balance; only what Hermes has spent with it shows.
- DeepSeek: the account's balance (``/user/balance``), granted and topped up, and whether it's enough to use the API.
- Openference: credit balance, plan and, with a paid plan, what has been used of its windows and when they reset.
  Its documentation has no address for this: it's the one its own web page uses (``/api/user/me``), which takes the
  API key too. That answer also has personal data and a key: only the numbers and the plan's name are taken from
  it. The free models and until when they're free come from its public catalog (``/v1/models``, without a key).

And of the AI on one's own network (llama.cpp, Ollama, LM Studio…), which has no quota: which models Hermes has used
and how many tokens each one, from the same records of state.db.
"""
from __future__ import annotations

import calendar
import hashlib
import importlib.util
import ipaddress
import logging
import re
import sqlite3
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

log = logging.getLogger("hermes_dashboard_plugin_pedila")

PLUGIN_VERSION = "1.7.0"
NAMES = {"openrouter": "OpenRouter", "venice": "Venice", "opencode-go": "OpenCode Go", "opencode-zen": "OpenCode Zen",
         "deepseek": "DeepSeek", "openference": "Openference", "orcarouter": "OrcaRouter"}
ORDER = ["openrouter", "venice", "opencode-go", "opencode-zen", "deepseek", "openference", "orcarouter"]
# The longest one reading takes, with all its queries (the ones left come out as "took too long"): Pedila waits 30 s.
BUILD_BUDGET_SECONDS = 20
REQUEST_SECONDS = 10
CONNECT_SECONDS = 5

GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models"
OPENFERENCE_MODELS_URL = "https://api.openference.com/v1/models"
# (id, name, share of the usage included in the month): https://opencode.ai/docs/go/ "Usage limits".
GO_WINDOWS = (("rolling", "5 h", 0.2), ("weekly", "week", 0.5), ("monthly", "month", 1.0))
GO_ROLLING_SECONDS = 5 * 3600
# An unused 5-hour window resets "in 5 h" (it starts with the first request): this is the margin for saying so.
GO_IDLE_SLACK = 60
# Go's plans, from least to most included usage. The API doesn't say which one is yours: the first one that
# agrees with OpenCode's whole numbers is taken (with little usage they all do and Go, the most common, stays).
GO_PLANS = ("go", "go-teams", "go-plus")
# Margin when checking whether a plan fits: splitting a long chat between windows is approximate.
PLAN_TOLERANCE = 0.25
CATALOG_TTL = 3600
CATALOG_RETRY = 300
# How far back state.db is read (the longest monthly window, with a margin).
ROWS_DAYS = 32
# The most keys of one provider that are asked about in one reading (the rest are only counted).
MAX_KEYS = 6
# The most models of one API that are told apart in what Hermes spent (the rest are added up).
MAX_MODELS = 12
# The most providers of the AI on one's own network that are given.
MAX_LOCAL = 6
# What Hermes puts when a provider of one's own has no key.
PLACEHOLDER_KEYS = {"", "no-key-required", "none", "null", "dummy", "sk-dummy"}

_catalog: dict[str, Any] = {"at": 0.0, "failed_at": 0.0, "models": None}
_free: dict[str, Any] = {"at": 0.0, "failed_at": 0.0, "models": None}


class _Fail(Exception):
    """A failure that can be shown as is (no key and no address with secrets)."""


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def _iso(v: Any) -> Optional[str]:
    """A well-formed ISO date (with a time zone) or None."""
    d = _when_dt(v)
    return d.isoformat() if d else None


def _when_dt(v: Any) -> Optional[datetime]:
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        d = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d.astimezone(UTC)


def kind_of(base_url: str) -> Optional[str]:
    """Which API it is, by the address Hermes talks to (only over https: no key goes out in the clear)."""
    try:
        u = urlparse(base_url or "")
        host = (u.hostname or "").lower()
    except ValueError:
        return None
    if u.scheme.lower() != "https":
        return None
    path = (u.path or "").lower()
    if host == "openrouter.ai" or host.endswith(".openrouter.ai"):
        return "openrouter"
    if host == "api.venice.ai" or host.endswith(".venice.ai"):
        return "venice"
    if host == "opencode.ai" or host.endswith(".opencode.ai"):
        return "opencode-go" if "/go" in path else "opencode-zen"
    if host == "api.deepseek.com":
        return "deepseek"
    if host == "api.openference.com":
        return "openference"
    if host == "orcarouter.ai" or host.endswith(".orcarouter.ai"):
        return "orcarouter"
    return None


# Names that only exist on one's own network (mDNS, the router's, a VPN's, Docker's and other private ones).
LOCAL_SUFFIXES = (".local", ".lan", ".home", ".internal", ".intranet", ".home.arpa", ".localdomain", ".fritz.box", ".ts.net")
# What VPNs such as Tailscale give their machines (Python doesn't count it as private).
VPN_NET = ipaddress.ip_network("100.64.0.0/10")


def place_of(base_url: Any) -> Optional[tuple[str, int]]:
    """(machine, port) of an address on this machine or on one's own network; None if it's on the internet."""
    try:
        u = urlparse(base_url.strip() if isinstance(base_url, str) else "")
        host, port = (u.hostname or "").lower().rstrip("."), u.port
    except ValueError:
        return None
    scheme = u.scheme.lower()
    if scheme not in ("http", "https") or not host:
        return None
    try:
        ip = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        if host == "localhost" or host.endswith(".localhost"):
            host = "localhost"
        elif "." in host and not host.endswith(LOCAL_SUFFIXES):
            return None
    else:
        ip = getattr(ip, "ipv4_mapped", None) or ip
        if ip.is_loopback or ip.is_unspecified:
            host = "localhost"
        elif ip.is_private or ip.is_link_local or ip in VPN_NET:
            host = str(ip)
        else:
            return None
    return host, port or (443 if scheme == "https" else 80)


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


# Hermes's own, recognized by their name (without an address in config.yaml).
BUILTIN = {"openrouter": "https://openrouter.ai/api/v1", "opencode-go": "https://opencode.ai/zen/go/v1",
           "opencode-zen": "https://opencode.ai/zen/v1", "deepseek": "https://api.deepseek.com/v1"}


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


def _enabled(entry: dict) -> bool:
    """A provider with ``enabled: false`` in config.yaml is turned off: Hermes doesn't use it."""
    flag = entry.get("enabled", True)
    if isinstance(flag, str):
        return flag.strip().lower() not in ("false", "no", "off", "0", "n", "f", "")
    return bool(flag)


def _candidates(cfg: dict) -> list[tuple[str, str, list[str], bool]]:
    """(name for Hermes, address, models, whether it's one of Hermes's own that config.yaml doesn't redefine) ONLY
    of the providers that are paid ones by their configured address. It's decided without reading any key: that way
    no key_cmd is run, no OAuth token is refreshed and nothing of the other providers is touched."""
    providers = cfg.get("providers")
    blocks = [(k, v) for k, v in providers.items() if isinstance(k, str) and isinstance(v, dict)] if isinstance(providers, dict) else []
    custom = cfg.get("custom_providers")
    listed = [(v["name"], v) for v in custom if isinstance(v, dict) and isinstance(v.get("name"), str)] if isinstance(custom, list) else []
    redefined = {k.strip().lower() for k, _v in blocks + listed}
    off = {k.strip().lower() for k, v in blocks if not _enabled(v)}
    out: dict[str, list] = {name: [url, [], name not in redefined] for name, url in BUILTIN.items() if name not in off}
    for key, pv in blocks:
        url = _url_of(pv) or BUILTIN.get(key.lower(), "")
        if _enabled(pv) and kind_of(url):
            slot = out.setdefault(key, [url, [], False])
            slot[0] = url  # one of Hermes's own names may be at another API's address
            slot[1].extend(_models_of(pv))
    for name, pv in listed:
        if _enabled(pv) and name.strip().lower() not in off and kind_of(_url_of(pv)):
            out.setdefault(name, [_url_of(pv), [], False])[1].extend(_models_of(pv))
    model = cfg.get("model")
    if isinstance(model, dict) and isinstance(model.get("provider"), str) and isinstance(model.get("default"), str):
        if model["provider"] in out:
            out[model["provider"]][1].insert(0, model["default"])
    return [(k, v[0], list(dict.fromkeys(v[1])), v[2]) for k, v in out.items()]


# ── The keys of each provider ───────────────────────────────────────────────────────────────────

def clean_key(k: Any) -> Optional[str]:
    if callable(k):  # key_cmd: Hermes gives an object that runs the command when called
        try:
            k = k()
        except Exception:
            return None
    if not isinstance(k, str):
        return None
    k = k.strip()
    return None if k.lower() in PLACEHOLDER_KEYS or len(k) < 8 else k


def _epoch(v: Any) -> Optional[float]:
    """Seconds since 1970 from a number (of seconds or milliseconds) or an ISO date."""
    n = _num(v)
    if n is not None:
        return n / 1000 if n > 1e11 else n
    d = _when_dt(v)
    return d.timestamp() if d else None


def _utc(t: Optional[float]) -> Optional[datetime]:
    """An instant (seconds since 1970) as a date; None if there isn't one or if it's impossible."""
    try:
        return datetime.fromtimestamp(t, UTC) if t else None
    except (OSError, OverflowError, ValueError):
        return None


def _iso_at(t: Optional[float]) -> Optional[str]:
    d = _utc(t)
    return d.isoformat() if d else None


def _resting_until(entry: Any, sole: bool) -> Optional[float]:
    """When Hermes will use that key again (None = there's no saying, and then Hermes doesn't leave it alone)."""
    try:
        from agent.credential_pool import _exhausted_until
        try:
            return _epoch(_exhausted_until(entry, sole_credential=sole))
        except TypeError:  # a Hermes from before sole_credential
            return _epoch(_exhausted_until(entry))
    except Exception:
        return _epoch(getattr(entry, "last_error_reset_at", None))


_AUTO_LABEL = re.compile(r"^(?:api-key-\d+|key #\d+|[a-z0-9-]+-oauth-\d+)$", re.I)


def _like_a_key(label: str) -> bool:
    """A long run of letters and digits without spaces that isn't words joined by hyphens."""
    for run in re.findall(r"[A-Za-z0-9_\-]{24,}", label):
        parts = [p for p in re.split(r"[-_]", run) if p]
        if any(len(p) > 15 or not (p.isalpha() or p.isdigit()) for p in parts):
            return True
    return False


def label_of(entry: Any, keys: list[str]) -> str:
    """The name the person gave that key (`hermes auth add --label`); "" if Hermes named it by itself or if
    there's something in it that looks like a key."""
    source = str(getattr(entry, "source", "") or "")
    if source.startswith(("env:", "config:")) or source == "model_config":
        return ""
    label = "".join(c for c in " ".join(str(getattr(entry, "label", "") or "").split()) if c.isprintable())
    if not label or _AUTO_LABEL.match(label) or _like_a_key(label):
        return ""
    if any(k in label or (len(label) >= 8 and label in k) for k in keys):
        return ""
    return label[:40]


def keys_of(rt: Any, kind: str, base: str, now: float, builtin: bool = True) -> list[dict[str, Any]]:
    """The keys Hermes has for a provider, in the order it tries them: the pool's (`hermes auth add`) and, if
    it isn't one of them, the one it would use now. ``rt`` = {"api_key", "base_url", "credential_pool"} (see
    plugin_api.py). A key that Hermes sends to another address (a proxy, a mirror) isn't sent to this one."""
    if not isinstance(rt, dict):
        return []
    used_at = rt.get("base_url")
    if used_at and kind_of(used_at) != kind:
        # Hermes uses this provider at another address. None of its keys is for here, not even the ones that the pool
        # has down with the usual one: the ones from .env always have it, wherever Hermes sends them.
        return []
    pool = rt.get("credential_pool")
    entries: list[Any] = []
    try:
        entries = list(pool.entries()) if pool is not None else []
    except Exception as exc:
        log.debug("pedila: couldn't read the keys of %s: %s", kind, type(exc).__name__)
    # A key without an address of its own is for its provider's: that's only known with one of Hermes's own that it
    # resolved here. With any other, it might be another provider's account.
    unmarked = base if builtin and used_at else ""
    at = lambda e: getattr(e, "runtime_base_url", None) or unmarked  # noqa: E731
    current = clean_key(rt.get("api_key"))
    # Under any other order (round_robin, least_used, random) there's no "key in use": they take turns.
    in_order = str(getattr(pool, "_strategy", "") or "fill_first") == "fill_first"
    alive = sum(1 for e in entries if getattr(e, "last_status", None) != "dead")
    usable = [(e, clean_key(getattr(e, "runtime_api_key", None))) for e in entries
              if str(getattr(e, "auth_type", "") or "api_key") == "api_key" and kind_of(at(e)) == kind]
    all_keys = [k for _e, k in usable if k]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e, key in usable:
        if not key or key in seen:
            continue
        seen.add(key)
        status = str(getattr(e, "last_status", None) or "")
        until = _resting_until(e, alive <= 1) if status == "exhausted" else None
        resting = status == "dead" or (until is not None and until > now)
        out.append({"key": key, "base": at(e), "id": str(getattr(e, "id", "") or "")[:20], "label": label_of(e, all_keys),
                    "resting": resting, "until": until if resting else None,
                    "active": (key == current and not resting) if in_order else None})
    if current and current not in seen:
        out.insert(0, {"key": current, "base": used_at or base, "id": "", "label": "", "resting": False, "until": None,
                       "active": True if in_order else None})
    return out


def detect(runtime: Callable[..., Optional[dict]], cfg: Optional[dict] = None, now: Optional[float] = None) -> list[dict[str, Any]]:
    """The paid APIs with a key, one entry per account (two names with the same key count once).
    ``runtime(name, url, builtin)`` = what Hermes would use for that provider (see plugin_api.py), or None."""
    now = time.time() if now is None else now
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for name, url, models, builtin in _candidates(_config() if cfg is None else cfg):
        kind = kind_of(url)
        if not kind:
            continue
        for pos, k in enumerate(keys_of(runtime(name, url, builtin), kind, url, now, builtin)):
            fp = hashlib.sha256(k["key"].encode("utf-8")).hexdigest()[:16]
            entry = seen.get((kind, fp))
            if entry:
                entry["models"].extend(m for m in models if m not in entry["models"])
                entry["active"] = entry["active"] or k["active"]
                continue
            seen[(kind, fp)] = {**k, "fp": fp, "kind": kind, "name": name, "models": list(models), "pos": pos}
    # Hermes's own provider first, and each one's keys in the order Hermes tries them.
    return sorted(seen.values(), key=lambda e: (ORDER.index(e["kind"]), e["name"].lower() != e["kind"], e["name"].lower(), e["pos"]))


def shown_of(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The accounts of an API that are asked about: the first MAX_KEYS of each provider (and always the one in use)."""
    out: list[dict[str, Any]] = []
    for name in dict.fromkeys(e["name"] for e in group):
        mine = [e for e in group if e["name"] == name]
        cut = mine[:MAX_KEYS]
        cut += [e for e in mine[MAX_KEYS:] if e["active"]]
        out.extend(cut)
    return out


def titles_of(group: list[dict[str, Any]]) -> list[str]:
    """What each account of an API is called: "OpenCode Go", "OpenCode Go · work", "OpenCode Go 2"…"""
    out: list[str] = []
    several = len({e["name"] for e in group}) > 1
    for i, e in enumerate(group, 1):
        base = NAMES[e["kind"]]
        label = e["label"] or (e["name"] if several and e["name"].lower() != e["kind"] else "")
        if not label:
            title = base if base not in out else f"{base} {i}"
        elif label.lower().startswith(base.lower()):
            title = label
        else:
            title = f"{base} · {label}"
        title = title[:40]
        unique, n = title, 2
        while unique in out:
            unique = f"{title[:35]} ({n})"
            n += 1
        out.append(unique)
    return out


def account_of(e: dict[str, Any], group: list[dict[str, Any]], shown: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """For a key that isn't its provider's only one: which one it is, whether Hermes uses it now (None = they take
    turns), whether it's resting and until when, and how many more there are (said in the last one shown)."""
    mates = [x for x in group if x["name"] == e["name"]]
    if len(mates) < 2:
        return None
    visible = [x for x in shown if x["name"] == e["name"]]
    return {"id": e["id"], "n": mates.index(e) + 1, "of": len(mates), "active": e["active"], "resting": e["resting"],
            "until": _iso_at(e["until"]), "hidden": len(mates) - len(visible) if e is visible[-1] else 0}


class _Net:
    """The client for asking the providers, with a deadline for all the queries together."""

    def __init__(self, client, timeout: Callable[[float], Any]):
        self.client = client
        self.timeout = timeout
        self.deadline = time.monotonic() + BUILD_BUDGET_SECONDS

    def get(self, url: str, headers: dict[str, str]):
        left = self.deadline - time.monotonic()
        if left < 1:
            raise _Fail("the provider took too long")
        return self.client.get(url, headers=headers, timeout=self.timeout(left))


def _get(client, url: str, key: str) -> dict:
    r = client.get(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    if r.status_code in (401, 403):
        raise _Fail("the key isn't valid or isn't allowed to see this")
    if r.status_code == 404:
        raise _Fail("the provider doesn't have this data")
    if r.status_code == 429:
        raise _Fail("the provider asks to wait (too many queries)")
    if r.status_code >= 400:
        raise _Fail(f"the provider answered {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        raise _Fail("unreadable answer from the provider") from None
    return body if isinstance(body, dict) else {}


def _data(body: dict) -> dict:
    d = body.get("data")
    return d if isinstance(d, dict) else {}


def fetch_openrouter(client, e: dict) -> dict:
    return openrouter_like(client, e["base"].rstrip("/"), e["key"])


def fetch_orcarouter(client, e: dict) -> dict:
    # Its chats go to /v1, but /key and /credits are under /api/v1 (as on OpenRouter): at /v1 they don't exist.
    u = urlparse(e["base"])
    return openrouter_like(client, f"{u.scheme}://{u.netloc}/api/v1", e["key"])


def openrouter_like(client, base: str, key: str) -> dict:
    """OpenRouter's /key and /credits (and those of the APIs that copy them) at ``base``."""
    # /key works with any key (limit, spending and reset); /credits (the account's balance) may not let
    # itself be read with some keys: if it fails, go on without the balance.
    k = _data(_get(client, f"{base}/key", key))
    try:
        credits = _data(_get(client, f"{base}/credits", key))
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


def fetch_deepseek(client, e: dict) -> dict:
    u = urlparse(e["base"])
    body = _get(client, f"{u.scheme}://{u.netloc}/user/balance", e["key"])
    balances = []
    for b in body.get("balance_infos") if isinstance(body.get("balance_infos"), list) else []:
        if not isinstance(b, dict) or _num(b.get("total_balance")) is None:
            continue
        cur = b.get("currency")
        balances.append({"currency": cur if cur in ("USD", "CNY") else "", "total": _num(b["total_balance"]),
                         "granted": _num(b.get("granted_balance")), "topped_up": _num(b.get("topped_up_balance"))})
    if not balances:
        raise _Fail("unreadable answer from the provider")
    avail = body.get("is_available")
    return {"balances": balances[:4], "available": avail if isinstance(avail, bool) else None}


# ── Openference ─────────────────────────────────────────────────────────────────────────────────

def _dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _first(*vs: Any) -> Optional[float]:
    return next((x for x in map(_num, vs) if x is not None), None)


def openference_windows(me: dict) -> list[dict[str, Any]]:
    """What has been used of the plan: the token plans' percentages (``limits.allowance``) or, with one of the old
    request plans, the count against its limit. Without a plan there's none."""
    limits, plan = _dict(me.get("limits")), _dict(me.get("plan"))
    al = limits.get("allowance")
    hours = _num(plan.get("windowHours"))
    hours = hours if hours and hours > 0 else 5
    rows: list[tuple[str, Optional[float], Any, Optional[float], Optional[float], str]] = []
    if isinstance(al, dict):
        for wid, f in (("rolling", "window"), ("weekly", "weekly"), ("monthly", "monthly")):
            rows.append((wid, _num(al.get(f + "Percent")), al.get(f + "ResetAt"), None, None, ""))
    else:
        for wid, used, limit, reset, unit in (
                ("rolling", _first(limits.get("windowQuotaUsed"), limits.get("windowRequests")),
                 _first(limits.get("windowLimit"), plan.get("requestsPerWindow")), limits.get("windowResetAt"), "requests"),
                ("weekly", _first(limits.get("weekQuotaUsed"), limits.get("weekRequests")),
                 _first(limits.get("requestsPerWeek"), plan.get("requestsPerWeek")), limits.get("weeklyResetAt"), "requests"),
                ("weekly-tokens", _first(limits.get("weekTokens")),
                 _first(limits.get("tokensPerWeek"), plan.get("tokensPerWeek")), limits.get("weeklyResetAt"), "tokens")):
            if used is not None and limit and limit > 0:
                rows.append((wid, used / limit * 100, reset, used, limit, unit))
    return [{"id": wid, "percent": max(0.0, min(100.0, p)), "resets_at": _iso_at(_epoch(at)), "hours": hours if wid == "rolling" else None,
             "used": used, "limit": limit, "unit": unit} for wid, p, at, used, limit, unit in rows if p is not None]


def openference_free(client, now: float) -> Optional[list[dict[str, Any]]]:
    """The free models and the last day they're free (remembered for 1 h; after a failure, 5 min without asking).
    None if it could never be read."""
    c = _free
    if c["models"] is not None and now - c["at"] < CATALOG_TTL:
        return c["models"]
    if c["failed_at"] and now - c["failed_at"] < CATALOG_RETRY:
        return c["models"]
    try:
        r = client.get(OPENFERENCE_MODELS_URL, headers={"Accept": "application/json"})  # public: no key needed
        if r.status_code != 200:
            raise _Fail(f"it answered {r.status_code}")
        body = r.json()
        rows = body.get("data") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise _Fail("unreadable catalog")
        models = []
        for m in rows:
            if isinstance(m, dict) and m.get("is_free") is True and isinstance(m.get("id"), str) and m["id"].strip():
                until = m.get("free_until")
                ok = isinstance(until, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", until) and _day_of(until)
                models.append({"model": m["id"].strip()[:80], "until": until if ok else None})
        c.update(at=now, failed_at=0.0, models=models[:12])
    except Exception as exc:
        log.info("pedila: couldn't read Openference's catalog (%s)", type(exc).__name__)
        c["failed_at"] = now
    return c["models"]


def fetch_openference(client, e: dict) -> dict:
    u = urlparse(e["base"])
    # The answer has the person's name and e-mail address, and a key: nothing but what's below comes out of it.
    me = _get(client, f"{u.scheme}://{u.netloc}/api/user/me", e["key"])
    credits, plan, usage = _dict(me.get("credits")), _dict(me.get("plan")), _dict(me.get("usage"))
    if not credits and not plan and not usage:
        raise _Fail("unreadable answer from the provider")
    name, status = plan.get("name"), me.get("status")
    return {
        "balance": _num(credits.get("balanceUsd")), "credits_total": _num(credits.get("totalPurchasedUsd")),
        "plan_name": name.strip()[:30] if isinstance(name, str) else None,
        "subscribed": bool(me.get("planId")) or isinstance(_dict(me.get("limits")).get("allowance"), dict),
        "expires_at": _iso_at(_epoch(me.get("planExpiresAt"))),
        "active": status == "active" if isinstance(status, str) else None,
        "windows": openference_windows(me),
        "account_usage": {k: _num(usage.get(f)) for k, f in (("requests", "totalRequests"), ("tokens", "totalTokens"), ("cost", "totalCost"))},
        "free_models": openference_free(client, time.time()),
    }


# ── OpenCode Go: public catalog of models (price per million tokens and monthly limit) ─────────────

def norm_model(name: Any) -> str:
    """'opencode-go/GLM-5.3' and 'zhipuai/glm-5.3' → 'glm-5.3'."""
    s = str(name or "").strip().lower()
    return s.rsplit("/", 1)[-1] if s else ""


def parse_catalog(body: Any) -> dict[str, dict]:
    """(normalized) model id → {id, name, cost, monthly: {plan: dollars of usage per month}}."""
    out: dict[str, dict] = {}
    rows = body.get("data") if isinstance(body, dict) else None
    for m in rows if isinstance(rows, list) else []:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not m["id"].strip():
            continue
        go = m.get("go") if isinstance(m.get("go"), dict) else {}
        mu = go.get("monthly_usage") if isinstance(go.get("monthly_usage"), dict) else {}
        monthly = {p: _num(v) for p, v in mu.items() if isinstance(p, str) and (_num(v) or 0) > 0}
        entry = {"id": m["id"], "name": m["name"] if isinstance(m.get("name"), str) else m["id"],
                 "cost": m["cost"] if isinstance(m.get("cost"), dict) else {}, "monthly": monthly}
        for alias in (m["id"], m.get("canonical_id")):
            k = norm_model(alias)
            if k and k not in out:
                out[k] = entry
    return out


def go_catalog(client, now: float) -> Optional[dict[str, dict]]:
    """The catalog (remembered for 1 h; after a failure, 5 min without asking). None if it could never be read."""
    c = _catalog
    if c["models"] is not None and now - c["at"] < CATALOG_TTL:
        return c["models"]
    if c["failed_at"] and now - c["failed_at"] < CATALOG_RETRY:
        return c["models"]
    try:
        # Public: no key needed.
        r = client.get(GO_MODELS_URL, headers={"Accept": "application/json"})
        if r.status_code != 200:
            raise _Fail(f"it answered {r.status_code}")
        models = parse_catalog(r.json())
        if not models:
            raise _Fail("empty catalog")
        c.update(at=now, failed_at=0.0, models=models)
    except Exception as exc:
        log.info("pedila: couldn't read OpenCode Go's catalog (%s)", type(exc).__name__)
        c["failed_at"] = now
    return c["models"]


_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_OPS = {"gt": lambda a, b: a > b, "gte": lambda a, b: a >= b, "lt": lambda a, b: a < b, "lte": lambda a, b: a <= b}


def _hm(v: Any) -> Optional[int]:
    """'06:30' → minutes of the day."""
    try:
        h, m = str(v).split(":", 1)
        return int(h) * 60 + int(m)
    except (TypeError, ValueError):
        return None


def _cmp(value: Any, spec: Any, conv: Callable[[Any], Any] = lambda x: x) -> bool:
    """{"gt"|"gte"|"lt"|"lte": x, "in": [...]}: all of them must hold. What isn't understood doesn't hold."""
    if not isinstance(spec, dict) or not spec or value is None:
        return False
    for op, ref in spec.items():
        if op == "in":
            if not isinstance(ref, list) or value not in ref:
                return False
            continue
        ref = conv(ref)
        if op not in _OPS or ref is None:
            return False
        try:
            if not _OPS[op](value, ref):
                return False
        except TypeError:
            return False
    return True


def _day_of(v: Any) -> Optional[datetime]:
    """'2026-12-01' or a full ISO date → UTC datetime."""
    if isinstance(v, str) and len(v.strip()) == 10:
        v = v.strip() + "T00:00:00+00:00"
    return _when_dt(v)


def matches(when: Any, ctx: dict) -> bool:
    """Does a catalog condition hold (price by context, peak hours, dates)?
    ctx = {"context": input tokens per call, "time": UTC datetime}. All the keys of one object must hold;
    "any"/"all" group them. An unknown condition doesn't hold."""
    if not isinstance(when, dict) or not when:
        return False
    t = ctx.get("time")
    for key, spec in when.items():
        if key == "any":
            ok = isinstance(spec, list) and any(matches(w, ctx) for w in spec)
        elif key == "all":
            ok = isinstance(spec, list) and bool(spec) and all(matches(w, ctx) for w in spec)
        elif key == "context":
            ok = _cmp(_num(ctx.get("context")), spec, _num)
        elif key == "utc_days":
            ok = t is not None and _cmp(_DAYS[t.weekday()], spec)
        elif key == "utc_hours":
            ok = t is not None and _cmp(t.hour * 60 + t.minute, spec, _hm)
        elif key == "date":
            ok = t is not None and _cmp(t, spec, _day_of)
        else:
            ok = False
        if not ok:
            return False
    return True


def _pick(node: Any, ctx: dict) -> dict:
    """The price that applies to this call (the first "overrides" that holds, or the usual one)."""
    if not isinstance(node, dict):
        return {}
    for ov in node.get("overrides") if isinstance(node.get("overrides"), list) else []:
        if isinstance(ov, dict) and matches(ov.get("when"), ctx):
            merged = dict(node)
            merged.update({k: v for k, v in ov.items() if k != "when"})
            return merged
    return node


def _write_price(cache: dict, p_in: float) -> float:
    w = cache.get("write")
    if isinstance(w, dict):  # by duration ('30m', '12h'): Hermes doesn't record which, the cheapest is taken
        vals = [x for x in (_num(v) for v in w.values()) if x is not None and x >= 0]
        return min(vals) if vals else p_in
    x = _num(w)
    return x if x is not None and x >= 0 else p_in


def row_cost(row: dict, model: Optional[dict]) -> Optional[float]:
    """Dollars of usage of a session_model_usage row with OpenCode's prices; None without a price.
    Hermes's tokens come apart: input without cache, cache read and written, and output (with the
    reasoning inside). The context per call and the time (halfway between the first and the last call)
    choose the price and the multipliers (peak hours, end of discounts)."""
    if not model:
        return None
    cost = model.get("cost") if isinstance(model.get("cost"), dict) else {}
    text = cost.get("text") if isinstance(cost.get("text"), dict) else None
    if not text:
        return None
    calls = max(1, int(row.get("calls") or 0))
    first, last = row.get("first") or row.get("last") or 0.0, row.get("last") or row.get("first") or 0.0
    ctx = {"context": (row["input"] + row["cache_read"] + row["cache_write"]) / calls,
           "time": _utc((first + last) / 2)}
    inp, out = _pick(text.get("input"), ctx), _pick(text.get("output"), ctx)
    p_in, p_out = _num(inp.get("price")), _num(out.get("price"))
    if p_in is None or p_out is None or p_in < 0 or p_out < 0:
        return None
    cache = inp.get("cache") if isinstance(inp.get("cache"), dict) else {}
    p_read = _num(cache.get("read"))
    p_read = p_in if p_read is None or p_read < 0 else p_read
    usd = (row["input"] * p_in + row["cache_read"] * p_read + row["cache_write"] * _write_price(cache, p_in)
           + row["output"] * p_out) / 1e6
    for mul in cost.get("multipliers") if isinstance(cost.get("multipliers"), list) else []:
        if isinstance(mul, dict) and matches(mul.get("when"), ctx):
            f = _num(mul.get("factor"))
            if f is not None and f > 0:
                usd *= f
    return usd


def shift_month(d: datetime, delta: int) -> datetime:
    """The same day and time `delta` months before or after (the 31st becomes the last day of a short month)."""
    total = d.year * 12 + (d.month - 1) + delta
    y, m = divmod(total, 12)
    return d.replace(year=y, month=m + 1, day=min(d.day, calendar.monthrange(y, m + 1)[1]))


def _monday(now: float) -> float:
    d = datetime.fromtimestamp(now, UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return d.timestamp() - d.weekday() * 86400


def window_starts(ends: dict[str, Optional[float]], now: float) -> dict[str, Optional[float]]:
    """When each window started, from when it resets according to OpenCode. The 5-hour one starts with the
    first request (with no usage going on, OpenCode says "in 5 h" and it starts now); the week, on Monday at
    00:00 UTC; the month, on the same day of the month before its reset (the day you paid)."""
    out: dict[str, Optional[float]] = {}
    for wid, _label, _share in GO_WINDOWS:
        end = ends.get(wid)
        if wid == "rolling":
            start = end - GO_ROLLING_SECONDS if end else None
        elif wid == "weekly":
            start = end - 7 * 86400 if end else _monday(now)
        else:
            at = _utc(end)
            start = shift_month(at, -1).timestamp() if at and at.year > 1970 else None
        out[wid] = min(start, now) if start is not None else None
    return out


def share_after(first: Optional[float], last: Optional[float], start: float) -> float:
    """Which share of a row falls from `start` on: Hermes records the first and the last call of each chat
    and model, not every one; if the row crosses the start, it's split in proportion to the time."""
    if last is None and first is None:
        return 0.0
    last = first if last is None else last
    first = last if first is None else first
    if last < start:
        return 0.0
    if first >= start or last <= first:
        return 1.0
    return (last - start) / (last - first)


def go_estimate(rows: list[dict], catalog: Optional[dict], official: dict[str, dict], now: float) -> dict[str, Any]:
    """Each window's usage with decimals. ``official`` = OpenCode's {id: {"percent", "end"}}.
    → {"plan", "unpriced", "windows": {id: {"estimate", "own", "cost", "tokens", "calls"}}}.
    "plan" only if there's just one it can be; "estimate" only where the calculation agrees with OpenCode."""
    starts = window_starts({w: (official.get(w) or {}).get("end") for w, _l, _s in GO_WINDOWS}, now)
    by_plan = {p: {w: 0.0 for w, _l, _s in GO_WINDOWS} for p in GO_PLANS}
    plan_ok = {p: True for p in GO_PLANS}
    own = {w: {"cost": 0.0, "tokens": 0.0, "calls": 0.0} for w, _l, _s in GO_WINDOWS}
    unpriced: set[str] = set()
    blind: set[str] = set()  # windows with usage that can't be priced: what's worked out there is too little
    for r in rows:
        model = catalog.get(norm_model(r["model"])) if catalog else None
        usd = row_cost(r, model)
        for wid, _label, part in GO_WINDOWS:
            s = starts.get(wid)
            f = share_after(r.get("first"), r.get("last"), s) if s is not None else 0.0
            if f <= 0:
                continue
            own[wid]["tokens"] += (r["input"] + r["output"]) * f
            own[wid]["calls"] += (r.get("calls") or 0) * f
            if usd is None:
                unpriced.add(str(r["model"])[:80])
                if r["input"] + r["output"] + r["cache_read"] + r["cache_write"] > 0:
                    blind.add(wid)
                continue
            own[wid]["cost"] += usd * f
            if usd <= 0:  # free models don't use up the plan
                continue
            for p in GO_PLANS:
                lim = model["monthly"].get(p) if model else None
                if lim:
                    by_plan[p][wid] += usd * f / (lim * part) * 100
                else:
                    plan_ok[p] = False
    # OpenCode gives the whole number rounded down: the real value is between that one and the next.
    said = {w: (official.get(w) or {}).get("percent") for w, _l, _s in GO_WINDOWS}

    def agrees(p: str, w: str) -> bool:
        return said[w] is not None and starts.get(w) is not None and said[w] <= by_plan[p][w] < said[w] + 1

    def fits(p: str) -> bool:
        """It doesn't overshoot any window and it agrees with one at least."""
        return (plan_ok[p] and all(o is None or by_plan[p][w] < o + 1 + PLAN_TOLERANCE for w, o in said.items())
                and any(agrees(p, w) for w in said))

    fitting = [p for p in GO_PLANS if fits(p)] if catalog else []
    plan = fitting[0] if fitting else None
    windows: dict[str, dict] = {}
    for wid, _label, _part in GO_WINDOWS:
        raw = by_plan[plan][wid] if plan else None
        if said[wid] is not None and said[wid] >= 100:
            est = 100.0
        else:
            est = raw if plan and wid not in blind and agrees(plan, wid) else None
        windows[wid] = {
            "estimate": round(est, 4) if est is not None else None,
            "own": round(raw, 4) if raw is not None else None,
            "cost": round(own[wid]["cost"], 6),
            "tokens": int(round(own[wid]["tokens"])),
            "calls": int(round(own[wid]["calls"])),
        }
    return {"plan": plan if len(fitting) == 1 else None, "unpriced": sorted(unpriced)[:8], "windows": windows}


def fetch_opencode_go(client, e: dict) -> dict:
    usage = _get(client, GO_USAGE_URL, e["key"]).get("usage")
    usage = usage if isinstance(usage, dict) else {}
    windows = []
    for wid, label, _part in GO_WINDOWS:
        w = usage.get(wid)
        if isinstance(w, dict) and _num(w.get("percent")) is not None:
            pct = max(0.0, min(100.0, _num(w["percent"])))
            if w.get("status") == "rate-limited":
                pct = 100.0
            reset = _when_dt(w.get("resetsAt"))
            windows.append({"id": wid, "label": label, "percent": pct, "resets_at": reset.isoformat() if reset else None})
    return {"windows": windows}


def go_official(row: dict) -> dict[str, dict]:
    """What OpenCode says of each window: {id: {"percent", "end"}}."""
    return {w["id"]: {"percent": w["percent"], "end": _epoch(w["resets_at"])} for w in row.get("windows") or []}


def go_idle(row: dict, now: float) -> bool:
    """Is it known that this key isn't being used? Its 5-hour window is at 0% and hasn't started: OpenCode
    sets when it resets with the first request, and until then it says "in 5 h"."""
    w = go_official(row).get("rolling") if row.get("ok") else None
    return bool(w) and w["percent"] == 0 and w["end"] is not None and w["end"] - now >= GO_ROLLING_SECONDS - GO_IDLE_SLACK


def go_decimals(accounts: list[dict], rows: list[dict], catalog: Optional[dict], now: float, whole: bool,
                keyed: Optional[list[list[dict]]] = None, noted: Optional[list[dict]] = None, since: float = 0.0) -> None:
    """Puts the decimals on OpenCode Go's rows. Hermes's records don't say with which key each thing was spent: with
    several keys, what recorder.py noted down is used (``keyed`` = each account's rows, ``noted`` = all of them, from
    ``since`` on), in the windows where nothing that Hermes recorded is missing. In the others, they're only worked
    out in the 5-hour window of one key while all the others are idle (in the week and the month, another key's 0%
    may hide up to 0.99%). ``whole`` = all of the API's keys are in ``accounts``."""
    def spent(its: list[dict], start: float) -> float:
        return sum((r["input"] + r["output"]) * share_after(r["first"], r["last"], start) for r in its)

    for i, row in enumerate(accounts):
        official = go_official(row) if row.get("ok") else {}
        if not official:
            continue
        parts: list[tuple[list[dict], dict[str, dict]]] = []
        if keyed is not None:
            starts = window_starts({w: o["end"] for w, o in official.items()}, now)
            sure = {w: o for w, o in official.items() if starts.get(w) is not None and starts[w] >= since
                    and spent(rows, starts[w]) <= spent(noted or [], starts[w]) * 1.05 + 1000}
            parts.append((keyed[i], sure))
            official = {w: o for w, o in official.items() if w not in sure}
        if keyed is not None or len(accounts) > 1 or not whole:
            if not whole or not all(go_idle(x, now) for x in accounts if x is not row):
                official = {}
            official = {w: o for w, o in official.items() if w == "rolling"}
        parts.append((rows, official))
        for its, windows in parts:
            if not windows:
                continue
            est = go_estimate(its, catalog, windows, now)
            for w in row["windows"]:
                if w["id"] in windows:
                    w.update(est["windows"].get(w["id"]) or {})
            row.update(plan=row.get("plan") or est["plan"], unpriced=sorted(set(row.get("unpriced") or []) | set(est["unpriced"])), catalog=bool(catalog))


FETCHERS = {"openrouter": fetch_openrouter, "venice": fetch_venice, "opencode-go": fetch_opencode_go,
            "deepseek": fetch_deepseek, "openference": fetch_openference, "orcarouter": fetch_orcarouter}


# ── What Hermes spent, from its own records ─────────────────────────────────────────────────────

# Ollama's cloud models are used through its local address, but they run in its cloud ("gpt-oss:120b-cloud").
_CLOUD_MODEL = re.compile(r"[:-]cloud$", re.IGNORECASE)
# llama.cpp may answer with the path of the file as the model's name.
_MODEL_FILE = re.compile(r"[\\/]([^\\/]+)\.(?:gguf|ggml|bin|safetensors)$", re.IGNORECASE)


def file_model(name: Any) -> str:
    """A model's name; if it's the path of its file, the file's name ("/models/Qwen3-8B-Q4_K_M.gguf")."""
    s = str(name or "").strip()
    m = _MODEL_FILE.search(s)
    return m.group(1) if m else s


def usage_rows(since: float) -> Optional[list[dict]]:
    """Rows of state.db's ``session_model_usage`` with usage since `since` that go to a paid API (``kind``: which one)
    or to the AI on one's own network (``kind``: "local", and ``place``: at which address).
    Each row = one chat, one model and one task (summaries, titles and images go apart).
    None if it couldn't be read."""
    try:
        from hermes_constants import get_hermes_home
        db = get_hermes_home() / "state.db"
    except Exception:
        return None
    if not db.exists():
        return []
    try:
        con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            raw = con.execute(
                "SELECT model, billing_base_url, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
                "api_call_count, COALESCE(NULLIF(actual_cost_usd, 0), estimated_cost_usd), first_seen, last_seen "
                "FROM session_model_usage WHERE COALESCE(last_seen, first_seen, 0) >= ?", (since,)).fetchall()
        finally:
            con.close()
    except Exception as exc:
        log.debug("pedila: couldn't read the usage in state.db: %s", exc)
        return None
    rows = []
    for model, base, inp, out, cr, cw, calls, cost, first, last in raw:
        kind = kind_of(base or "")
        place = None if kind else place_of(base)
        if not kind and (not place or _CLOUD_MODEL.search(str(model or "").strip())):
            continue
        first, last = _num(first), _num(last)
        row = {"kind": kind or "local", "model": model or "", "input": int(inp or 0), "output": int(out or 0),
               "cache_read": int(cr or 0), "cache_write": int(cw or 0), "calls": int(calls or 0),
               "cost": float(cost or 0.0), "first": first if first is not None else last,
               "last": last if last is not None else first}
        if place:
            row.update(place=place, model=file_model(model), cost=0.0)  # one's own AI isn't billed by the token
        rows.append(row)
    return rows


def _ranked(models: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], Optional[dict[str, int]]]:
    """The models that spent the most, first, and what the ones that don't fit add up to."""
    rows = sorted(models.values(), key=lambda m: (-(m["input"] + m["output"]), -m["cache"], m["model"]))
    out = [{"model": m["model"], "tokens": int(round(m["input"] + m["output"])), "input": int(round(m["input"])),
            "output": int(round(m["output"])), "cache": int(round(m["cache"])), "calls": int(round(m["calls"])),
            "cost": round(m["cost"], 6)} for m in rows]
    out = [m for m in out if m["tokens"] or m["cache"] or m["calls"]]
    rest = out[MAX_MODELS:]
    return out[:MAX_MODELS], {"models": len(rest), "tokens": sum(m["tokens"] for m in rest)} if rest else None


def key_rows(since: float) -> Optional[tuple[float, list[dict]]]:
    """What recorder.py noted down of each key, as rows like ``usage_rows``'s with the key's fingerprint, and since
    when there's a record. None if there's none."""
    try:
        from hermes_constants import get_hermes_home
        db = Path(get_hermes_home()) / "plugin-data" / "pedila" / "usage.db"
    except Exception:
        return None
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            start = con.execute("SELECT value FROM meta WHERE name = 'since'").fetchone()
            raw = con.execute("SELECT kind, key, model, input, output, cache_read, cache_write, calls, first, last "
                              "FROM usage WHERE last >= ?", (since,)).fetchall()
        finally:
            con.close()
    except Exception as exc:
        log.debug("pedila: couldn't read the usage by key: %s", type(exc).__name__)
        return None
    start = _num(start[0]) if start else None
    if start is None:
        return None
    return start, [{"kind": k, "key": key, "model": m or "", "input": int(i or 0), "output": int(o or 0), "cache_read": int(cr or 0),
                    "cache_write": int(cw or 0), "calls": int(n or 0), "cost": 0.0, "first": _num(f), "last": _num(la)}
                   for k, key, m, i, o, cr, cw, n, f, la in raw]


SPANS = {"day": 1, "week": 7, "month": 30}
_FIELDS = ("input", "output", "cache", "calls", "cost")
# Of a model, less than this share without a known key isn't worth saying.
REST_SHARE = 0.02


def _tally(rows: list[dict], now: float, catalog: Optional[dict] = None) -> dict[str, dict[str, dict[str, Any]]]:
    """{span: {model in lower case: {model, input, output, cache, calls, cost}}}. Hermes records the first and the
    last call of each chat and model, not every one: a row that crosses the start of the span is split in
    proportion to the time, so it's approximate. With OpenCode Go, which Hermes can't put a price on, the cost comes
    from its catalog's prices."""
    out: dict[str, dict[str, dict[str, Any]]] = {p: {} for p in SPANS}
    for r in rows:
        cost = r["cost"]
        if not cost and r["kind"] == "opencode-go" and catalog:
            cost = row_cost(r, catalog.get(norm_model(r["model"]))) or 0.0
        name = " ".join(str(r["model"] or "").split())[:80] or "?"
        vals = (r["input"], r["output"], r["cache_read"] + r["cache_write"], r["calls"], cost)
        for p, days in SPANS.items():
            f = share_after(r["first"], r["last"], now - days * 86400)
            if f <= 0:
                continue
            # The same model may be written with other capitals from one chat to another.
            m = out[p].setdefault(name.lower(), {"model": name, **dict.fromkeys(_FIELDS, 0.0)})
            for k, v in zip(_FIELDS, vals):
                m[k] += v * f
    return out


def _present(tally: dict[str, dict[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    """What's given of each span: the totals and the models, the ones that spent the most first."""
    out: dict[str, dict[str, Any]] = {}
    for p, by in tally.items():
        models, others = _ranked(by)
        out[p] = {"tokens": int(round(sum(m["input"] + m["output"] for m in by.values()))),
                  "calls": int(round(sum(m["calls"] for m in by.values()))), "cost": sum(m["cost"] for m in by.values()),
                  "cache": int(round(sum(m["cache"] for m in by.values()))), "models": models, "others": others}
    return out


def spent_by_kind(rows: list[dict], now: float, catalog: Optional[dict] = None) -> dict[str, dict[str, dict[str, Any]]]:
    """What Hermes spent with each API (tokens read + written, cache, calls, cost), in all and model by model:
    24 h, 7 and 30 days."""
    return {k: _present(_tally([r for r in rows if r["kind"] == k], now, catalog)) for k in dict.fromkeys(r["kind"] for r in rows)}


def local_names(cfg: dict) -> dict[tuple[str, int], str]:
    """What config.yaml calls the provider at each address of one's own network."""
    providers, custom = cfg.get("providers"), cfg.get("custom_providers")
    blocks = [(k, v) for k, v in providers.items() if isinstance(v, dict)] if isinstance(providers, dict) else []
    blocks += [("", v) for v in custom if isinstance(v, dict)] if isinstance(custom, list) else []
    out: dict[tuple[str, int], str] = {}
    for key, pv in blocks:
        place = place_of(_url_of(pv))
        given = pv.get("name")
        name = " ".join(str(given if isinstance(given, str) and given.strip() else key or "").split())[:40]
        if place and name:
            out.setdefault(place, name)
    return out


def local_spent(rows: list[dict], cfg: dict, now: float) -> list[dict[str, Any]]:
    """What Hermes used of the AI on one's own network, provider by provider (the one used the most, first):
    [{name, spent}]. The same provider may be at several addresses (at home and through a VPN): they go together if
    config.yaml gives them the same name. An address that isn't among config.yaml's providers goes by itself."""
    names = local_names(cfg)
    spelled: dict[str, str] = {}  # the same name with other capitals is the same provider
    for name in names.values():
        spelled.setdefault(name.lower(), name)
    groups: dict[str, tuple[str, list[dict]]] = {}
    for r in rows:
        if r["kind"] != "local":
            continue
        host, port = r["place"]
        name = names.get(r["place"]) or (f"[{host}]:{port}" if ":" in host else f"{host}:{port}")[-40:]
        groups.setdefault(name.lower(), (spelled.get(name.lower(), name), []))[1].append(r)
    out = [{"name": name, "spent": _present(_tally(its, now))} for name, its in groups.values()]
    out = [x for x in out if x["spent"]["month"]["models"]]
    out.sort(key=lambda x: (-x["spent"]["month"]["tokens"], x["name"].lower()))
    return out[:MAX_LOCAL]


def with_cost(noted: list[dict], rows: list[dict]) -> list[dict]:
    """recorder.py's rows, with what Hermes reckons each model costs (dollars per token of its own records)."""
    rate: dict[str, list[float]] = {}
    for r in rows:
        if r["cost"] > 0:
            x = rate.setdefault(str(r["model"]).lower(), [0.0, 0.0])
            x[0] += r["cost"]
            x[1] += r["input"] + r["output"]
    out = []
    for r in noted:
        cost, tokens = rate.get(str(r["model"]).lower(), (0.0, 0.0))
        out.append({**r, "cost": cost / tokens * (r["input"] + r["output"]) if tokens else 0.0})
    return out


_COUNTS = ("input", "output", "cache_read", "cache_write", "calls", "cost")


def rest_rows(rows: list[dict], noted: list[dict], keys: list[str], since: float) -> list[dict]:
    """What isn't in the list of any of the keys shown, as rows: what Hermes recorded before there was a record by key
    (``since``), what it recorded afterwards and recorder.py didn't note down, and what was spent with other keys."""
    early = [r for r in rows if (r["last"] or 0) < since]
    late = [r for r in rows if (r["last"] or 0) >= since]
    out = early + [r for r in noted if r["key"] not in keys]
    # Of the chats used since then, model by model and without splitting any by the time: Hermes's total minus what
    # was noted down. (Only of those: what was noted down of a chat that was deleted must not hide what's from before.)
    by: dict[str, list[dict]] = {}
    for r in late:
        by.setdefault(" ".join(str(r["model"] or "").split())[:80].lower(), []).append(r)
    known: dict[str, dict[str, float]] = {}
    for r in noted:
        k = known.setdefault(str(r["model"]).lower(), dict.fromkeys(_COUNTS, 0.0))
        for f in _COUNTS:
            k[f] += r[f]
    for name, its in by.items():
        k = known.get(name) or dict.fromkeys(_COUNTS, 0.0)
        whole = {f: sum(r[f] for r in its) for f in _COUNTS}
        missing = {f: max(0.0, whole[f] - k[f]) for f in _COUNTS}
        tokens = whole["input"] + whole["output"]
        if tokens <= 0 or missing["input"] + missing["output"] < tokens * REST_SHARE:
            continue
        # When it was: before there was a record, if some chat is from then; if not, at any time of theirs.
        firsts = [r["first"] for r in its if r["first"] is not None]
        first = min(firsts) if firsts else None
        last = since if first is not None and first < since else max(r["last"] for r in its)
        out.append({"kind": its[0]["kind"], "model": its[0]["model"], "first": first, "last": last, **missing})
    return out


def shell_stale(info: dict[str, Any]) -> bool:
    """Is the fixed part (plugin_api.py) that Hermes has loaded another than the one on disk? Hermes only loads it
    when it starts, so it's still the old one until it restarts."""
    try:
        m = re.search(r'^SHELL_VERSION = "([^"]+)"', Path(info["shell_file"]).read_text(encoding="utf-8"), re.M)
    except (KeyError, TypeError, OSError, ValueError):
        return False
    return bool(m) and m.group(1) != info.get("shell")


_RECORDER_MODULE = "hermes_dashboard_plugin_pedila_recorder"
_recorder_lock = threading.Lock()


def ensure_recorder() -> bool:
    """Loads recorder.py (or loads it again, if it or this file changed) in this process and starts it."""
    with _recorder_lock:
        here = Path(__file__).resolve()
        path = here.parent.parent / "recorder.py"
        try:
            sig = tuple((s.st_mtime_ns, s.st_size) for s in (path.stat(), here.stat()))
        except OSError:
            return False
        old = sys.modules.get(_RECORDER_MODULE)
        if old is not None and getattr(old, "_pedila_sig", None) == sig:
            return bool(getattr(old, "_pedila_on", False))
        try:
            spec = importlib.util.spec_from_file_location(_RECORDER_MODULE, path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            on = mod.install(kind_of)
        except Exception as exc:
            log.warning("pedila: couldn't start the usage record by key (%s)", type(exc).__name__)
            return False
        mod._pedila_sig, mod._pedila_on = sig, on
        sys.modules[_RECORDER_MODULE] = mod
        if old is not None:
            old.stop()
        return on


def build(runtime: Callable[..., Optional[dict]], **info: Any) -> dict[str, Any]:
    """The whole answer. ``info`` = what plugin_api.py says of itself ("shell" and "shell_file")."""
    import httpx

    if info:  # inside Hermes
        ensure_recorder()
    now = time.time()
    rows = usage_rows(now - ROWS_DAYS * 86400)
    noted = key_rows(now - ROWS_DAYS * 86400)
    groups: dict[str, list[dict[str, Any]]] = {}
    for e in detect(runtime, now=now):
        groups.setdefault(e["kind"], []).append(e)
    work: list[tuple[dict, dict]] = []  # (account, row)
    for kind, group in groups.items():
        shown = shown_of(group)
        for e, title in zip(shown, titles_of(shown)):
            row: dict[str, Any] = {"kind": kind, "name": title, "hermes_name": e["name"], "ok": True, "spent": None}
            account = account_of(e, group, shown)
            if account:
                row["account"] = account
            work.append((e, row))
    with httpx.Client(timeout=REQUEST_SECONDS, follow_redirects=False) as client:
        net = _Net(client, lambda left: httpx.Timeout(min(REQUEST_SECONDS, left), connect=min(CONNECT_SECONDS, left)))
        catalog = go_catalog(net, now) if "opencode-go" in groups else None
        down: dict[str, str] = {}  # the APIs that don't answer: their other keys aren't waited for too
        for e, row in work:
            fetcher = FETCHERS.get(e["kind"])
            if not fetcher:
                row["no_api"] = True
                continue
            if e["kind"] in down:
                row.update(ok=False, error=down[e["kind"]])
                continue
            try:
                row.update(fetcher(net, e))
            except _Fail as exc:
                row.update(ok=False, error=str(exc))
            except httpx.TransportError as exc:
                down[e["kind"]] = "the provider took too long" if isinstance(exc, httpx.TimeoutException) else "couldn't reach the provider"
                row.update(ok=False, error=down[e["kind"]])
            except httpx.HTTPError:
                row.update(ok=False, error="couldn't reach the provider")
            except Exception as exc:  # never the text: it could carry the key
                log.warning("pedila: failure reading %s: %s", e["kind"], type(exc).__name__)
                row.update(ok=False, error="unexpected failure reading the provider")
    for kind, group in groups.items() if rows is not None else ():
        mine = [row for e, row in work if e["kind"] == kind]
        keys = [e["fp"] for e, _row in work if e["kind"] == kind]
        of_kind = [r for r in rows if r["kind"] == kind]
        try:
            since, by_key = noted if noted else (0.0, [])
            by_key = with_cost([r for r in by_key if r["kind"] == kind], of_kind)
            # (A single key too, if something was noted down with another one that is no longer there.)
            if by_key and (len(group) > 1 or any(r["key"] not in keys for r in by_key)):
                # Each key with its own. Hermes doesn't record it: it's what recorder.py noted down.
                keyed = [[r for r in by_key if r["key"] == k] for k in keys]
                for row, its in zip(mine, keyed):
                    row["spent"] = spent_by_kind(its, now, catalog).get(kind)
                rest = spent_by_kind(rest_rows(of_kind, by_key, keys, since), now, catalog).get(kind)
                if rest and rest["month"]["tokens"]:
                    mine[-1]["spent_rest"] = rest
                if kind == "opencode-go":
                    go_decimals(mine, of_kind, catalog, now, len(mine) == len(group), keyed, by_key, since)
                continue
            # What Hermes spent goes by API: with several keys it isn't known which one it was, so it's said once,
            # for all of them (in a field of its own: earlier versions of Pedila would take it for that key's).
            mine[0]["spent" if len(group) == 1 else "spent_all"] = spent_by_kind(of_kind, now, catalog).get(kind)
            if kind == "opencode-go":
                go_decimals(mine, of_kind, catalog, now, len(mine) == len(group))
        except Exception as exc:  # what's worked out from Hermes's records doesn't take the quotas down
            log.warning("pedila: failure working out what was spent with %s: %s", kind, type(exc).__name__)
    local = None  # Hermes's records couldn't be read
    if rows is not None:
        try:
            local = local_spent(rows, _config(), now)
        except Exception as exc:
            log.warning("pedila: failure working out what the local AI was used for: %s", type(exc).__name__)
    return {"plugin": "pedila", "version": PLUGIN_VERSION, "fetched_at": datetime.fromtimestamp(now, UTC).isoformat(),
            "shell_stale": shell_stale(info), "providers": [row for _e, row in work], "local": local}
