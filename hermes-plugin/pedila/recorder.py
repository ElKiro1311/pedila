"""Pedila: which key each request was made with.

Hermes records what each chat spent with each model, but not with which of a provider's keys. With several keys
for the same API (``hermes auth add``), this notes it down, so that the app can tell each one's usage apart.

It wraps the functions every answer's usage goes through in Hermes (``add_session_usage``, the chats;
``record_aux_usage``, titles, summaries, images…): they do the same as always, and then the model, the tokens and a
fingerprint of the key (the first 16 hex digits of its SHA-256, never the key) are added up by hour in
``plugin-data/pedila/usage.db``. No text of any chat is kept. If a Hermes doesn't have those functions, or if
something can't be told, it isn't noted down: the app says it apart, as not known with which key.
"""
from __future__ import annotations

import atexit
import hashlib
import logging
import sqlite3
import sys
import threading
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("hermes_dashboard_plugin_pedila")

KEEP_DAYS = 40
# How long the answers are gathered before writing them down (a Hermes that ends abruptly loses that much).
FLUSH_SECONDS = 0.3
SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
  hour INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0, first REAL NOT NULL, last REAL NOT NULL,
  PRIMARY KEY (hour, kind, key, model));
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value REAL NOT NULL);
"""
ADD = """
INSERT INTO usage (hour, kind, key, model, input, output, cache_read, cache_write, calls, first, last)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (hour, kind, key, model) DO UPDATE SET
  input = input + excluded.input, output = output + excluded.output,
  cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
  calls = calls + excluded.calls, first = MIN(first, excluded.first), last = MAX(last, excluded.last)
"""


def db_path() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "plugin-data" / "pedila" / "usage.db"


def fingerprint(key: Any) -> Optional[str]:
    if not isinstance(key, str) or len(key.strip()) < 8:
        return None
    return hashlib.sha256(key.strip().encode("utf-8")).hexdigest()[:16]


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=5)
    con.executescript(SCHEMA)
    return con


class Recorder:
    """Takes note without making the agent wait: a thread of its own writes it down."""

    def __init__(self, kind_of: Callable[[str], Optional[str]], path: Callable[[], Path] = db_path):
        self.kind_of = kind_of
        self.path = path
        self.pending: list[tuple[Path, tuple]] = []
        self.lock = threading.Lock()        # self.pending and self.thread
        self.writing = threading.Lock()     # one write at a time: whoever ends waits for the one going on
        self.wake = threading.Event()
        self.stopped = False
        self.thread: Optional[threading.Thread] = None
        self.pruned: dict[Path, float] = {}

    def note(self, base_url: Any, key: Any, model: Any, usage: Any, now: Optional[float] = None) -> None:
        kind = self.kind_of(str(base_url or ""))
        fp = fingerprint(key) if kind else None
        if not fp:
            return
        tokens = [max(0, int(getattr(usage, f, 0) or 0)) for f in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")]
        if not any(tokens):
            return
        now = time.time() if now is None else now
        name = " ".join(str(model or "").split())[:80] or "?"
        # The path is the one of the profile that is answering: it's worked out here, not in the thread.
        item = (self.path(), (int(now // 3600), kind, fp, name, *tokens, 1, now, now))
        with self.lock:
            self.pending.append(item)
        if self.stopped:  # another version of this file took over while this answer was on its way
            self.flush()
        else:
            self.start()

    def start(self) -> None:
        with self.lock:
            if not self.stopped and (self.thread is None or not self.thread.is_alive()):
                self.thread = threading.Thread(target=self._run, name="pedila-usage", daemon=True)
                self.thread.start()
        self.wake.set()

    def _run(self) -> None:
        while True:
            self.wake.wait()
            self.wake.clear()
            if not self.stopped:
                time.sleep(FLUSH_SECONDS)
            self.flush()
            if self.stopped:
                return

    def flush(self) -> None:
        """Writes down what's pending. What couldn't be written is left out: it never gets in the way of a chat."""
        with self.writing:
            with self.lock:
                items, self.pending = self.pending, []
            by_path: dict[Path, list] = {}
            for path, row in items:
                by_path.setdefault(path, []).append(row)
            for path, rows in by_path.items():
                try:
                    self._write(path, rows)
                except Exception as exc:
                    log.debug("pedila: couldn't note the usage down: %s", type(exc).__name__)

    def _write(self, path: Path, rows: list[tuple]) -> None:
        con = connect(path)
        try:
            with con:
                con.executemany(ADD, rows)
                # From when there's a record, in each profile's.
                con.execute("INSERT OR IGNORE INTO meta (name, value) VALUES ('since', ?)", (min(r[9] for r in rows),))
                now = time.time()
                if now - self.pruned.get(path, 0.0) > 86400:
                    con.execute("DELETE FROM usage WHERE last < ?", (now - KEEP_DAYS * 86400,))
                    self.pruned[path] = now
        finally:
            con.close()

    def stop(self) -> None:
        self.stopped = True
        self.wake.set()
        self.flush()


# ── What is listened to ────────────────────────────────────────────────────────────────────────
# The answer an auxiliary call has just got and the client it was got with: Hermes doesn't say it when it had to try
# again with another key or another provider, right when it matters.
_last_aux: ContextVar[Optional[tuple]] = ContextVar("pedila_last_aux", default=None)
# What a cache keep-alive was sent with (the agent may have changed its key or its model in the meantime).
_warming = threading.local()


def note_agent(rec: Recorder, agent: Any, usage: Any) -> None:
    """A chat's answer. The key is the one the agent has at that moment, which is the one it was made with."""
    sent = getattr(_warming, "billing", None)
    if isinstance(sent, dict):
        rec.note(sent.get("base_url"), sent.get("api_key"), sent.get("model"), usage)
    elif str(getattr(agent, "provider", "") or "") != "moa":  # a mix of models, each one with its own key
        rec.note(getattr(agent, "base_url", None), getattr(agent, "api_key", None), getattr(agent, "model", None), usage)


def note_aux(rec: Recorder, response: Any, task: Any, provider: Any, serving: Any) -> None:
    """A title, a summary, an image…: the key is the one of the client that got the answer."""
    from agent import aux_accounting
    from agent.usage_pricing import normalize_usage

    raw = getattr(response, "usage", None)
    if raw is None or not task or task in getattr(aux_accounting, "_EXCLUDED_TASKS", ()):
        return
    if serving is None:
        last = _last_aux.get()
        if last is not None and last[0] is response:
            serving = aux_accounting.ServingCredential.of(last[1])
        _last_aux.set(None)
    if serving is not None:
        # With Hermes's own name for an answer that doesn't say its model.
        rec.note(getattr(serving, "base_url", None), getattr(serving, "api_key", None), str(getattr(response, "model", "") or "") or "unknown",
                 normalize_usage(raw, provider=provider))


def _after(hook: dict, *args: Any, **kwargs: Any) -> None:
    try:
        hook["f"](*args, **kwargs)
    except Exception as exc:
        log.debug("pedila: couldn't note an answer down: %s", type(exc).__name__)


def _wrap(owner: Any, name: str, after: Callable, make: Callable) -> bool:
    """`owner.name` becomes what ``make(current, hook)`` gives. With one of ours already there, only what it calls
    changes (another version of this file takes over)."""
    current = getattr(owner, name, None)
    if not callable(current):
        return False
    hook = getattr(current, "_pedila_hook", None)
    if isinstance(hook, dict):
        hook["f"] = after
        return True
    hook = {"f": after}
    wrapper = make(current, hook)
    wrapper._pedila_hook = hook
    wrapper.__name__, wrapper.__doc__, wrapper.__wrapped__ = name, current.__doc__, current
    setattr(owner, name, wrapper)
    return True


def _then(current: Callable, hook: dict) -> Callable:
    def wrapper(*args, **kwargs):
        out = current(*args, **kwargs)
        _after(hook, *args, **kwargs)
        return out
    return wrapper


def _answered(current: Callable, hook: dict) -> Callable:
    def wrapper(client, *args, **kwargs):
        out = current(client, *args, **kwargs)
        _after(hook, out, client)
        return out
    return wrapper


def _answered_async(current: Callable, hook: dict) -> Callable:
    async def wrapper(client, *args, **kwargs):
        out = await current(client, *args, **kwargs)
        _after(hook, out, client)
        return out
    return wrapper


def _during(current: Callable, hook: dict) -> Callable:
    def wrapper(self, run, *args, **kwargs):
        _after(hook, getattr(run, "billing", None))
        try:
            return current(self, run, *args, **kwargs)
        finally:
            _after(hook, None)
    return wrapper


def _listen_more() -> None:
    """The ones that are only listened to once Hermes has loaded them (importing them here would be slow)."""
    aux = sys.modules.get("agent.auxiliary_client")
    if aux is not None:
        seen = lambda response, client: _last_aux.set((response, client))  # noqa: E731
        _wrap(aux, "_relay_sync_completion", seen, _answered)
        _wrap(aux, "_relay_async_completion", seen, _answered_async)
    warmer = sys.modules.get("agent.prompt_cache_lifecycle.warmer")
    cls = getattr(warmer, "PromptCacheWarmer", None)
    if cls is not None:
        _wrap(cls, "_record", lambda billing: setattr(_warming, "billing", billing), _during)


_current: dict[str, Any] = {"rec": None}


def install(kind_of: Callable[[str], Optional[str]]) -> bool:
    """Starts noting down (once per process; doing it again only changes what's called)."""
    try:
        from agent import aux_accounting, turn_usage
    except Exception as exc:
        log.debug("pedila: this Hermes doesn't let the usage by key be noted down: %s", type(exc).__name__)
        return False
    rec = Recorder(kind_of)

    def chat(agent, usage, *_a, **_k):
        _listen_more()
        note_agent(rec, agent, usage)

    if not _wrap(turn_usage, "add_session_usage", chat, _then):
        return False

    def aux(response, task=None, *, provider=None, base_url=None, serving=None, **_k):  # noqa: ARG001
        _listen_more()
        note_aux(rec, response, task, provider, serving)

    _wrap(aux_accounting, "record_aux_usage", aux, _then)
    _listen_more()
    _current["rec"] = rec
    atexit.register(rec.flush)
    return True


def stop() -> None:
    """Writes down what's pending and ends its thread (another version of this file takes over)."""
    rec = _current.get("rec")
    if rec is not None:
        _current["rec"] = None
        atexit.unregister(rec.flush)
        rec.stop()
