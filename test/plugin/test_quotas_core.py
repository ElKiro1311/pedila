"""Tests of Hermes's "pedila" plugin (hermes-plugin/pedila/dashboard).

`npm test` (test/plugin.test.js) launches them with Hermes's Python if it's installed, because the plugin
uses httpx and fastapi, which Hermes brings. By hand:
  python -I -X utf8 test/plugin/test_quotas_core.py
They touch neither the network nor the real Hermes: everything goes with test data.
"""
import asyncio
import importlib.util
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
DASH = HERE.parent.parent / "hermes-plugin" / "pedila" / "dashboard"


def _hermes_python() -> None:
    """httpx and fastapi come with Hermes: if this Python doesn't have them, it's started the way hermes.exe
    does it (hermes_bootstrap puts its environment in sys.path). Without Hermes, those tests are skipped."""
    try:
        import fastapi  # noqa: F401
        import httpx  # noqa: F401
        return
    except ImportError:
        pass
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "hermes-agent"
    if not (root / "hermes_bootstrap.py").is_file():
        return
    for k in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        os.environ.pop(k, None)
    sys.path.insert(0, str(root))
    sys._hermes_pin_default_home = True
    import hermes_bootstrap  # noqa: F401


_hermes_python()


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


core = load(DASH / "quotas_core.py", "pedila_core_test")
ts = lambda *a: datetime(*a, tzinfo=UTC).timestamp()  # noqa: E731

# A piece of the real catalog at https://opencode.ai/zen/go/v1/models (2026-11-20).
CATALOG_BODY = {"object": "list", "data": [
    {"id": "glm-5.3", "canonical_id": "zhipuai/glm-5.3", "name": "GLM-5.3",
     "cost": {"text": {"input": {"price": 1.4, "cache": {"read": 0.26}}, "output": {"price": 4.4}}},
     "go": {"monthly_usage": {"go": 500, "go-plus": 1000, "go-teams": 505}}},
    {"id": "gpt-5.6-luna", "name": "GPT 5.6 Luna",
     "cost": {"text": {"input": {"price": 0.2, "cache": {"read": 0.02, "write": {"30m": 0.25, "12h": 0.5}},
                                 "overrides": [{"when": {"context": {"gt": 272000}}, "price": 0.4, "cache": {"read": 0.04, "write": {"30m": 0.5, "12h": 1}}}]},
                       "output": {"price": 1.2, "overrides": [{"when": {"context": {"gt": 272000}}, "price": 1.8}]}}},
     "go": {"monthly_usage": {"go": 15, "go-plus": 60, "go-teams": 20}}},
    {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro",
     "cost": {"text": {"input": {"price": 0.66, "cache": {"read": 0.022}}, "output": {"price": 1.98}},
              "multipliers": [{"when": {"utc_days": {"in": ["mon", "tue", "wed", "thu", "fri"]},
                                        "any": [{"all": [{"utc_hours": {"gte": "01:00"}}, {"utc_hours": {"lt": "04:00"}}]},
                                                {"all": [{"utc_hours": {"gte": "06:00"}}, {"utc_hours": {"lt": "10:00"}}]}]},
                               "factor": 2}]},
     "go": {"monthly_usage": {"go": 15, "go-plus": 60, "go-teams": 20}}},
    {"id": "gemini-4-argon", "name": "Gemini 4 Argon",
     "cost": {"text": {"input": {"price": 2, "cache": {"read": 0.1}}, "output": {"price": 10}},
              "multipliers": [{"when": {"date": {"gte": "2026-12-01"}}, "factor": 2}]},
     "go": {"monthly_usage": {"go": 30, "go-plus": 120, "go-teams": 35}}},
    {"id": "beam-free", "name": "Beam Free", "cost": {"text": {"input": {"price": 0, "cache": {"read": 0}}, "output": {"price": 0}}}, "go": None},
    {"id": "", "name": "sin id"}, "basura",
]}
CAT = core.parse_catalog(CATALOG_BODY)


def row(model="glm-5.3", inp=0, out=0, cr=0, cw=0, calls=1, first=None, last=None, kind="opencode-go", cost=0.0):
    return {"kind": kind, "model": model, "input": inp, "output": out, "cache_read": cr, "cache_write": cw,
            "calls": calls, "cost": cost, "first": first, "last": last}


# What Hermes would record in a quarter of an hour of work (added up).
NOW = ts(2026, 11, 20, 1, 8, 15)
REAL = row(inp=150000, out=50000, cr=1200000, calls=32, first=ts(2026, 11, 20, 0, 50, 51), last=ts(2026, 11, 20, 1, 7, 39))
REAL_USD = (150000 * 1.4 + 50000 * 4.4 + 1200000 * 0.26) / 1e6  # 0.742
OFFICIAL = {"rolling": {"percent": 0.0, "end": ts(2026, 11, 20, 5, 50, 37)},
            "weekly": {"percent": 0.0, "end": ts(2026, 11, 23)},
            "monthly": {"percent": 0.0, "end": ts(2026, 12, 19, 18, 20, 30)}}


class Catalog(unittest.TestCase):
    def test_reads_prices_limits_and_aliases(self):
        self.assertIn("glm-5.3", CAT)
        self.assertEqual(CAT["glm-5.3"]["monthly"], {"go": 500.0, "go-plus": 1000.0, "go-teams": 505.0})
        self.assertIs(CAT["zhipuai/glm-5.3".rsplit("/", 1)[-1]], CAT["glm-5.3"])
        self.assertEqual(CAT["beam-free"]["monthly"], {})
        self.assertNotIn("", CAT)
        self.assertEqual(core.norm_model("opencode-go/GLM-5.3"), "glm-5.3")
        self.assertEqual(core.parse_catalog({"data": "nada"}), {})
        self.assertEqual(core.parse_catalog(None), {})


class Conditions(unittest.TestCase):
    def test_context_hours_days_dates(self):
        m = core.matches
        self.assertTrue(m({"context": {"gt": 272000}}, {"context": 300000}))
        self.assertFalse(m({"context": {"gt": 272000}}, {"context": 272000}))
        tue = datetime(2026, 11, 17, 2, 30, tzinfo=UTC)  # Tuesday 02:30 UTC
        sab = datetime(2026, 11, 21, 2, 30, tzinfo=UTC)
        peak = CATALOG_BODY["data"][2]["cost"]["multipliers"][0]["when"]
        self.assertTrue(m(peak, {"time": tue}))
        self.assertFalse(m(peak, {"time": sab}))
        self.assertFalse(m(peak, {"time": datetime(2026, 11, 17, 4, 0, tzinfo=UTC)}))  # 'lt 04:00'
        self.assertTrue(m({"date": {"gte": "2026-12-01"}}, {"time": datetime(2026, 12, 1, tzinfo=UTC)}))
        self.assertFalse(m({"date": {"gte": "2026-12-01"}}, {"time": datetime(2026, 11, 30, 23, 59, tzinfo=UTC)}))
        # What is unknown or badly formed doesn't hold.
        self.assertFalse(m({"region": {"in": ["eu"]}}, {"time": tue}))
        self.assertFalse(m({}, {"time": tue}))
        self.assertFalse(m({"utc_hours": {"gte": "xx"}}, {"time": tue}))
        self.assertFalse(m({"any": []}, {"time": tue}))
        self.assertFalse(m(None, {}))


class Cost(unittest.TestCase):
    def test_glm_on_the_pc(self):
        self.assertAlmostEqual(core.row_cost(REAL, CAT["glm-5.3"]), REAL_USD, places=9)

    def test_large_context_and_cache_writes(self):
        r = row("gpt-5.6-luna", inp=100000, out=10000, cr=300000, cw=20000, calls=1, first=NOW, last=NOW)
        # 420,000 of context per call > 272,000: large-context prices; the cheapest write (30m).
        want = (100000 * 0.4 + 300000 * 0.04 + 20000 * 0.5 + 10000 * 1.8) / 1e6
        self.assertAlmostEqual(core.row_cost(r, CAT["gpt-5.6-luna"]), want, places=12)
        small = row("gpt-5.6-luna", inp=1000, out=100, cr=0, cw=1000, calls=1, first=NOW, last=NOW)
        self.assertAlmostEqual(core.row_cost(small, CAT["gpt-5.6-luna"]), (1000 * 0.2 + 1000 * 0.25 + 100 * 1.2) / 1e6, places=12)

    def test_multipliers(self):
        base = (1_000_000 * 0.66 + 100_000 * 1.98) / 1e6
        peak = row("deepseek-v4-pro", inp=1_000_000, out=100_000, first=ts(2026, 11, 17, 2, 0), last=ts(2026, 11, 17, 3, 0))
        calm = row("deepseek-v4-pro", inp=1_000_000, out=100_000, first=ts(2026, 11, 21, 2, 0), last=ts(2026, 11, 21, 3, 0))
        self.assertAlmostEqual(core.row_cost(peak, CAT["deepseek-v4-pro"]), base * 2, places=12)
        self.assertAlmostEqual(core.row_cost(calm, CAT["deepseek-v4-pro"]), base, places=12)
        dic = row("gemini-4-argon", inp=1_000_000, first=ts(2026, 12, 2), last=ts(2026, 12, 2))
        self.assertAlmostEqual(core.row_cost(dic, CAT["gemini-4-argon"]), 4.0, places=12)

    def test_without_price(self):
        self.assertIsNone(core.row_cost(REAL, None))
        self.assertIsNone(core.row_cost(REAL, {"cost": {}}))
        self.assertIsNone(core.row_cost(REAL, {"cost": {"text": {"input": {"price": "x"}, "output": {"price": 1}}}}))


class Windows(unittest.TestCase):
    def test_months(self):
        sm = core.shift_month
        self.assertEqual(sm(datetime(2026, 12, 19, 18, 20, 30, tzinfo=UTC), -1), datetime(2026, 11, 19, 18, 20, 30, tzinfo=UTC))
        self.assertEqual(sm(datetime(2026, 3, 31, tzinfo=UTC), -1), datetime(2026, 2, 28, tzinfo=UTC))
        self.assertEqual(sm(datetime(2028, 3, 31, tzinfo=UTC), -1), datetime(2028, 2, 29, tzinfo=UTC))
        self.assertEqual(sm(datetime(2027, 1, 15, tzinfo=UTC), -1), datetime(2026, 12, 15, tzinfo=UTC))

    def test_starts(self):
        st = core.window_starts({w: o["end"] for w, o in OFFICIAL.items()}, NOW)
        self.assertEqual(st["rolling"], ts(2026, 11, 20, 0, 50, 37))
        self.assertEqual(st["weekly"], ts(2026, 11, 16))
        self.assertEqual(st["monthly"], ts(2026, 11, 19, 18, 20, 30))
        # With no usage going on OpenCode says "in 5 h": the window starts now (and never later).
        idle = core.window_starts({"rolling": NOW + 5 * 3600 + 3, "weekly": None, "monthly": None}, NOW)
        self.assertEqual(idle["rolling"], NOW)
        self.assertEqual(idle["weekly"], ts(2026, 11, 16))  # Monday, even if OpenCode doesn't say so
        self.assertIsNone(idle["monthly"])

    def test_split(self):
        sa = core.share_after
        self.assertEqual(sa(10, 20, 5), 1.0)
        self.assertEqual(sa(10, 20, 25), 0.0)
        self.assertAlmostEqual(sa(10, 20, 15), 0.5)
        self.assertEqual(sa(20, 20, 20), 1.0)
        self.assertEqual(sa(None, 20, 10), 1.0)
        self.assertEqual(sa(None, None, 10), 0.0)


class Estimate(unittest.TestCase):
    def test_real_usage_of_the_pc(self):
        e = core.go_estimate([REAL], CAT, OFFICIAL, NOW)
        self.assertIsNone(e["plan"])  # with this little, it could be any of the three: none is said
        w = e["windows"]
        self.assertAlmostEqual(w["rolling"]["estimate"], round(REAL_USD / (500 * 0.2) * 100, 4))
        self.assertAlmostEqual(w["weekly"]["estimate"], round(REAL_USD / (500 * 0.5) * 100, 4))
        self.assertAlmostEqual(w["monthly"]["estimate"], round(REAL_USD / 500 * 100, 4))
        self.assertEqual(w["rolling"]["tokens"], 150000 + 50000)
        self.assertEqual(w["rolling"]["calls"], 32)
        self.assertAlmostEqual(w["rolling"]["cost"], round(REAL_USD, 6))

    def test_only_when_it_agrees_with_opencodes_whole_number(self):
        # OpenCode says 3% in the 5 hours: this Hermes only sees 0.75% (the account was used from somewhere else).
        # There it isn't known; in the week and the month (0%), it is.
        off = {k: dict(v) for k, v in OFFICIAL.items()}
        off["rolling"]["percent"] = 3.0
        w = core.go_estimate([REAL], CAT, off, NOW)["windows"]
        self.assertIsNone(w["rolling"]["estimate"])
        self.assertAlmostEqual(w["weekly"]["estimate"], round(REAL_USD / (500 * 0.5) * 100, 4))
        # What this Hermes spent is said anyway.
        self.assertAlmostEqual(w["rolling"]["cost"], round(REAL_USD, 6))
        # OpenCode says 0% but the calculation gives 1.5% with Go (and Teams) and 0.75% with Go Plus: Go Plus.
        twice = dict(REAL, input=REAL["input"] * 2, output=REAL["output"] * 2, cache_read=REAL["cache_read"] * 2)
        e = core.go_estimate([twice], CAT, OFFICIAL, NOW)
        self.assertEqual(e["plan"], "go-plus")  # the only one it can be
        self.assertAlmostEqual(e["windows"]["rolling"]["estimate"], round(REAL_USD * 2 / (1000 * 0.2) * 100, 4))
        # No plan agrees (OpenCode changed its limits, for example): no decimals, and no made-up plan.
        huge = dict(REAL, input=REAL["input"] * 50, output=REAL["output"] * 50, cache_read=REAL["cache_read"] * 50)
        e = core.go_estimate([huge], CAT, OFFICIAL, NOW)
        self.assertIsNone(e["plan"])
        self.assertEqual([x["estimate"] for x in e["windows"].values()], [None, None, None])
        for o in off.values():
            o["percent"] = 40.0
        self.assertIsNone(core.go_estimate([REAL], CAT, off, NOW)["plan"])
        # Used up (OpenCode gives 100): 100.
        off["weekly"]["percent"] = 100.0
        self.assertEqual(core.go_estimate([REAL], CAT, off, NOW)["windows"]["weekly"]["estimate"], 100.0)

    def test_out_of_window_free_and_without_price(self):
        old = dict(REAL, first=ts(2026, 11, 19, 10), last=ts(2026, 11, 19, 11))  # before paying for the plan
        free = row("beam-free", inp=10 ** 6, out=10 ** 5, calls=3, first=NOW - 60, last=NOW - 30)
        odd = row("modelo-nuevo", inp=5000, out=500, calls=1, first=NOW - 60, last=NOW - 30)
        e = core.go_estimate([old, free], CAT, OFFICIAL, NOW)
        self.assertEqual(e["windows"]["rolling"]["estimate"], 0.0)  # what is free doesn't use up the plan
        self.assertEqual(e["windows"]["weekly"]["calls"], 32 + 3)
        self.assertEqual(e["windows"]["monthly"]["calls"], 3)
        # With usage that can't be priced, what's worked out is too little: no decimals in the windows it's in.
        e = core.go_estimate([old, free, odd], CAT, OFFICIAL, NOW)
        self.assertEqual(e["unpriced"], ["modelo-nuevo"])
        self.assertEqual([w["estimate"] for w in e["windows"].values()], [None, None, None])
        self.assertEqual(e["windows"]["rolling"]["calls"], 3 + 1)
        before = dict(odd, first=ts(2026, 11, 19, 10), last=ts(2026, 11, 19, 11))  # only in the week
        w = core.go_estimate([before, REAL], CAT, OFFICIAL, NOW)["windows"]
        self.assertIsNone(w["weekly"]["estimate"])
        self.assertAlmostEqual(w["rolling"]["estimate"], round(REAL_USD / (500 * 0.2) * 100, 4))
        # A model without a limit in a plan rules that plan out.
        rare = core.parse_catalog({"data": [{**CATALOG_BODY["data"][0], "go": {"monthly_usage": {"go-plus": 1000}}}]})
        self.assertEqual(core.go_estimate([REAL], rare, OFFICIAL, NOW)["plan"], "go-plus")

    def test_without_catalog(self):
        e = core.go_estimate([REAL], None, OFFICIAL, NOW)
        self.assertIsNone(e["plan"])
        self.assertIsNone(e["windows"]["rolling"]["estimate"])
        self.assertEqual(e["windows"]["rolling"]["calls"], 32)


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


GO_URL = "https://opencode.ai/zen/go/v1"


class Pool:
    """A make-believe credential pool of Hermes."""

    def __init__(self, entries, strategy="fill_first"):
        self._entries = entries
        self._strategy = strategy

    def entries(self):
        return list(self._entries)


def cred(label, letter, source="manual", priority=0, auth_type="api_key", base_url=GO_URL, **state):
    """A key of the pool, with the fields of agent.credential_pool.PooledCredential."""
    key = "oc_" + (letter * 48)[:48]
    c = types.SimpleNamespace(id=f"id-{letter}", label=label, source=source, priority=priority, auth_type=auth_type, base_url=base_url,
                              access_token=key, request_count=0, last_status=None, last_status_at=None, last_error_reset_at=None)
    for k, v in state.items():
        setattr(c, k, v)

    class _C(types.SimpleNamespace):
        runtime_api_key = property(lambda s: s.access_token)
        runtime_base_url = property(lambda s: s.base_url)
    return _C(**vars(c))


class FakeClient:
    """A make-believe httpx.Client: OpenCode Go's usage and catalog; it keeps what was asked for."""
    calls: list = []
    usage = {"usage": {"rolling": {"status": "ok", "percent": 0, "resetsAt": "2026-11-20T05:50:37.000Z"},
                       "weekly": {"status": "ok", "percent": 0, "resetsAt": "2026-11-23T00:00:00.000Z"},
                       "monthly": {"status": "ok", "percent": 0, "resetsAt": "2026-12-19T18:20:30.000Z"}}}

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    by_key: dict = {}  # the usage of one key in particular
    timeouts: list = []

    def get(self, url, headers=None, timeout=None):
        FakeClient.calls.append((url, dict(headers or {})))
        FakeClient.timeouts.append(timeout)
        if url == core.GO_USAGE_URL:
            return _Resp(200, FakeClient.by_key.get(headers["Authorization"].removeprefix("Bearer "), FakeClient.usage))
        if url == core.GO_MODELS_URL:
            return _Resp(200, CATALOG_BODY)
        return _Resp(404, {})


class Build(unittest.TestCase):
    def setUp(self):
        try:
            import httpx
        except ImportError:
            self.skipTest("without httpx (tested with the Python of Hermes)")
        self.httpx = httpx
        self.saved = (httpx.Client, core.usage_rows, core.key_rows, core._config, core.time.time)
        httpx.Client = FakeClient
        core.usage_rows = lambda since: [REAL, row("x", kind="openrouter", inp=5, out=5)]
        core.key_rows = lambda since: None  # (not this PC's real record)
        core._config = lambda: {}
        core.time.time = lambda: NOW
        core._catalog.update(at=0.0, failed_at=0.0, models=None)
        FakeClient.calls = []
        FakeClient.timeouts = []
        FakeClient.by_key = {}

    def tearDown(self):
        self.httpx.Client, core.usage_rows, core.key_rows, core._config, core.time.time = self.saved

    def test_whole_answer_without_keys(self):
        key = "oc_" + "k" * 48
        body = core.build(runtime=lambda name, *a: {"api_key": key} if name == "opencode-go" else None)
        text = json.dumps(body)
        self.assertNotIn(key, text)
        self.assertEqual(body["version"], core.PLUGIN_VERSION)
        [go] = body["providers"]
        self.assertEqual(go["kind"], "opencode-go")
        self.assertTrue(go["ok"])
        self.assertIsNone(go["plan"])
        self.assertTrue(go["catalog"])
        self.assertFalse(body["shell_stale"])
        self.assertEqual([w["id"] for w in go["windows"]], ["rolling", "weekly", "monthly"])
        self.assertNotIn("account", go)  # a single key: nothing to tell apart
        self.assertAlmostEqual(go["windows"][0]["estimate"], round(REAL_USD, 4), places=4)  # 0.75% of $100
        self.assertEqual(go["windows"][0]["resets_at"], "2026-11-20T05:50:37+00:00")
        # Hermes doesn't know OpenCode Go's price: the 24-hour spending comes from the catalog.
        self.assertAlmostEqual(go["spent"]["day"]["cost"], REAL_USD, places=6)
        # The catalog is asked for WITHOUT the key; the usage, with it.
        heads = {u: h for u, h in FakeClient.calls}
        self.assertNotIn("Authorization", heads[core.GO_MODELS_URL])
        self.assertEqual(heads[core.GO_USAGE_URL]["Authorization"], f"Bearer {key}")
        # The catalog is remembered: a second reading doesn't ask for it again.
        FakeClient.calls = []
        core.build(runtime=lambda name, *a: {"api_key": key} if name == "opencode-go" else None)
        self.assertNotIn(core.GO_MODELS_URL, [u for u, _h in FakeClient.calls])

    def test_used_up_and_without_state_db(self):
        FakeClient.usage = {"usage": {"rolling": {"status": "rate-limited", "percent": 100, "resetsAt": "2026-11-20T05:50:37Z"}}}
        core.usage_rows = lambda since: None
        try:
            body = core.build(runtime=lambda name, *a: {"api_key": "oc_" + "z" * 40} if name == "opencode-go" else None)
        finally:
            FakeClient.usage = Build.usage_original
        [go] = body["providers"]
        self.assertEqual(go["windows"], [{"id": "rolling", "label": "5 h", "percent": 100.0, "resets_at": "2026-11-20T05:50:37+00:00"}])
        self.assertIsNone(go["spent"])


    def _two_keys(self, first=None, extra=None, strategy="fill_first", current=0, pool=True):
        """OpenCode Go with two keys in Hermes's pool; → (rows of the answer, whole answer, keys)."""
        a, b = cred("OPENCODE_GO_API_KEY", "a", source="env:OPENCODE_GO_API_KEY", **(first or {})), cred("OpenCode Go (extra)", "b", priority=1, **(extra or {}))
        rt = {"api_key": (a, b)[current].runtime_api_key, "base_url": GO_URL, "credential_pool": Pool([a, b], strategy) if pool else None}
        body = core.build(runtime=lambda name, *args: rt if name == "opencode-go" else None)
        return body["providers"], body, (a.runtime_api_key, b.runtime_api_key)

    IDLE = {"usage": {"rolling": {"status": "ok", "percent": 0, "resetsAt": datetime.fromtimestamp(NOW + 5 * 3600, UTC).isoformat()},
                      "weekly": {"status": "ok", "percent": 0, "resetsAt": "2026-11-23T00:00:00Z"},
                      "monthly": {"status": "ok", "percent": 0, "resetsAt": "2026-12-02T08:00:00Z"}}}

    def test_two_keys_are_two_quotas(self):
        rows, body, keys = self._two_keys()
        self.assertEqual([r["name"] for r in rows], ["OpenCode Go", "OpenCode Go (extra)"])
        self.assertEqual([r["account"] for r in rows], [
            {"id": "id-a", "n": 1, "of": 2, "active": True, "resting": False, "until": None, "hidden": 0},
            {"id": "id-b", "n": 2, "of": 2, "active": False, "resting": False, "until": None, "hidden": 0}])
        # Each one is asked with its own key, and neither goes out in the answer.
        sent = [h["Authorization"] for u, h in FakeClient.calls if u == core.GO_USAGE_URL]
        self.assertEqual(sent, [f"Bearer {k}" for k in keys])
        for k in keys:
            self.assertNotIn(k, json.dumps(body))
        # Hermes's records don't say which key it was: the total, once, in a field that earlier Pedilas don't read.
        self.assertEqual([r["spent"] for r in rows], [None, None])
        self.assertAlmostEqual(rows[0]["spent_all"]["day"]["cost"], REAL_USD, places=6)
        self.assertNotIn("spent_all", rows[1])
        # Both 5-hour windows are open, so it isn't known whose is what: no decimals.
        self.assertTrue(all("estimate" not in w for r in rows for w in r["windows"]))

    def test_decimals_with_several_keys(self):
        FakeClient.by_key = {"oc_" + "b" * 48: self.IDLE}
        rows, _b, _k = self._two_keys()
        # The extra one's 5-hour window hasn't started: what was spent in the first one's is the first one's.
        self.assertAlmostEqual(rows[0]["windows"][0]["estimate"], round(REAL_USD, 4), places=4)
        self.assertEqual([w["id"] for r in rows for w in r["windows"] if "estimate" in w], ["rolling"])
        # A window that started 3 minutes ago also says 0%, but it's being used.
        FakeClient.by_key["oc_" + "b" * 48] = json.loads(json.dumps(self.IDLE).replace(datetime.fromtimestamp(NOW + 5 * 3600, UTC).isoformat(), datetime.fromtimestamp(NOW + 5 * 3600 - 180, UTC).isoformat()))
        rows, _b, _k = self._two_keys()
        self.assertTrue(all("estimate" not in w for r in rows for w in r["windows"]))
        # A key that couldn't be read isn't known to be idle.
        FakeClient.by_key["oc_" + "b" * 48] = {"usage": "garbage"}
        rows, _b, _k = self._two_keys()
        self.assertTrue(all("estimate" not in w for r in rows for w in r["windows"]))

    def test_the_first_one_used_up(self):
        reset = NOW + 3600
        rows, _b, _k = self._two_keys(first={"last_status": "exhausted", "last_status_at": NOW - 60, "last_error_reset_at": reset}, current=1)
        self.assertEqual([(r["account"]["active"], r["account"]["resting"]) for r in rows], [(False, True), (True, False)])
        self.assertEqual(rows[0]["account"]["until"], datetime.fromtimestamp(reset, UTC).isoformat())
        # When its time comes, it isn't resting anymore (Hermes clears it in its next request).
        rows, _b, _k = self._two_keys(first={"last_status": "exhausted", "last_status_at": NOW - 60, "last_error_reset_at": NOW - 1})
        self.assertEqual([(r["account"]["active"], r["account"]["resting"]) for r in rows], [(True, False), (False, False)])
        # Without knowing until when, Hermes doesn't leave it alone (and an impossible date doesn't take the panel down).
        rows, _b, _k = self._two_keys(first={"last_status": "exhausted"})
        self.assertFalse(rows[0]["account"]["resting"])
        self.assertIsNone(core._iso_at(9.9e14))
        self.assertIsNone(core._iso_at(None))
        rows, _b, _k = self._two_keys(first={"last_status": "dead"}, current=1)
        self.assertEqual((rows[0]["account"]["resting"], rows[0]["account"]["until"]), (True, None))

    def test_both_used_up(self):
        # Hermes resolves with the key of .env and without its pool, which plugin_api.py reads apart: both show, and
        # neither is in use.
        out = {"last_status": "exhausted", "last_status_at": NOW - 60, "last_error_reset_at": NOW + 600}
        rows, _b, _k = self._two_keys(first=out, extra=out)
        self.assertEqual([(r["account"]["active"], r["account"]["resting"]) for r in rows], [(False, True), (False, True)])
        # If that pool couldn't be read either, the key of .env alone.
        rows, _b, _k = self._two_keys(first=out, extra=out, pool=False)
        self.assertEqual([r["name"] for r in rows], ["OpenCode Go"])
        self.assertNotIn("account", rows[0])

    def test_keys_that_take_turns_and_one_that_fails(self):
        rows, _b, _k = self._two_keys(strategy="round_robin")
        self.assertEqual([r["account"]["active"] for r in rows], [None, None])
        # A key that isn't valid doesn't take the other one down.
        original = FakeClient.get

        def get(self, url, headers=None, timeout=None):
            if url == core.GO_USAGE_URL and headers["Authorization"].endswith("b"):
                return _Resp(401, {})
            return original(self, url, headers, timeout)
        FakeClient.get = get
        try:
            rows, _b, _k = self._two_keys()
        finally:
            FakeClient.get = original
        self.assertEqual([r["ok"] for r in rows], [True, False])
        self.assertIn("isn't valid", rows[1]["error"])

    def test_two_providers_with_the_same_api(self):
        # Two providers of config.yaml aren't a pool: Hermes doesn't go from one to the other, so neither is "in use".
        core._config = lambda: {"custom_providers": [{"name": "my-go", "base_url": GO_URL}]}
        rts = {n: {"api_key": "oc_" + n * 8, "base_url": GO_URL} for n in ("opencode-go", "my-go")}
        rows = core.build(runtime=lambda name, *a: rts.get(name))["providers"]
        self.assertEqual([r["name"] for r in rows], ["OpenCode Go", "OpenCode Go · my-go"])
        self.assertTrue(all("account" not in r for r in rows))
        self.assertEqual([r["spent"] for r in rows], [None, None])
        self.assertIn("spent_all", rows[0])

    def test_more_keys_than_the_ones_shown(self):
        creds = [cred(f"k{i}", chr(97 + i), priority=i) for i in range(9)]
        rt = {"api_key": creds[0].access_token, "base_url": GO_URL, "credential_pool": Pool(creds)}
        FakeClient.usage = self.IDLE
        try:
            rows = core.build(runtime=lambda name, *a: rt if name == "opencode-go" else None)["providers"]
        finally:
            FakeClient.usage = Build.usage_original
        self.assertEqual(len(rows), core.MAX_KEYS)
        self.assertEqual([r["account"]["hidden"] for r in rows], [0] * (core.MAX_KEYS - 1) + [9 - core.MAX_KEYS])
        self.assertEqual({r["account"]["of"] for r in rows}, {9})
        # The ones that weren't read may be in use: no decimals.
        self.assertTrue(all("estimate" not in w for r in rows for w in r["windows"]))

    def test_the_time_is_for_all_the_queries_together(self):
        clock = [1000.0]
        real_get = FakeClient.get

        def slow(self, url, headers=None, timeout=None):
            clock[0] += 12
            return real_get(self, url, headers, timeout)
        with mock.patch.object(core.time, "monotonic", lambda: clock[0]), mock.patch.object(FakeClient, "get", slow):
            rows, _b, _k = self._two_keys()
        # The catalog (12 s) and the first key (24 s) use it up: the second isn't even asked about.
        self.assertEqual([r["ok"] for r in rows], [True, False])
        self.assertIn("took too long", rows[1]["error"])
        self.assertEqual(len([u for u, _h in FakeClient.calls if u == core.GO_USAGE_URL]), 1)
        self.assertEqual([t.read for t in FakeClient.timeouts], [10, 8])

    def test_an_api_that_doesnt_answer_doesnt_hold_the_others_back(self):
        clock = [1000.0]
        real_get = FakeClient.get
        core._config = lambda: {"custom_providers": [{"name": "venice", "base_url": "https://api.venice.ai/api/v1"}]}
        go = Pool([cred("one", "a"), cred("two", "b"), cred("three", "c")])
        rts = {"opencode-go": {"api_key": "oc_" + "a" * 48, "base_url": GO_URL, "credential_pool": go},
               "openrouter": {"api_key": "sk-or-" + "r" * 40, "base_url": "https://openrouter.ai/api/v1"},
               "venice": {"api_key": "vn-" + "v" * 40, "base_url": "https://api.venice.ai/api/v1"}}
        for exc, error in ((self.httpx.ReadTimeout("slow"), "took too long"), (self.httpx.ConnectError("no"), "couldn't reach")):
            asked = []

            def get(self_, url, headers=None, timeout=None):
                asked.append(url)
                if url == core.GO_USAGE_URL:
                    clock[0] += 10
                    raise exc
                if "venice" in url or "openrouter" in url:
                    return _Resp(200, {"data": {"balances": {"USD": 1.0}, "usage": 1.0}})
                return real_get(self_, url, headers, timeout)
            with mock.patch.object(core.time, "monotonic", lambda: clock[0]), mock.patch.object(FakeClient, "get", get):
                rows = core.build(runtime=lambda name, *a: rts.get(name))["providers"]
            self.assertEqual({r["kind"]: r["ok"] for r in rows}, {"openrouter": True, "venice": True, "opencode-go": False})
            self.assertEqual(asked.count(core.GO_USAGE_URL), 1)  # its other two keys aren't waited for
            self.assertEqual([error in r["error"] for r in rows if r["kind"] == "opencode-go"], [True] * 3)

    def test_an_impossible_date_doesnt_take_the_card_down(self):
        for when in ("0001-01-01T00:00:00Z", "1969-12-31T00:00:00Z", "9999-12-31T23:59:59Z", "garbage"):
            FakeClient.usage = json.loads(json.dumps(Build.usage_original))
            for w in FakeClient.usage["usage"].values():
                w["resetsAt"] = when
            try:
                body = core.build(runtime=lambda name, *a: {"api_key": "oc_" + "k" * 48} if name == "opencode-go" else None)
            finally:
                FakeClient.usage = Build.usage_original
            self.assertEqual([p["ok"] for p in body["providers"]], [True], when)
            self.assertIsNotNone(body["providers"][0]["spent"], when)
            # If it's only the month's, the others still have their decimals.
            FakeClient.usage = json.loads(json.dumps(Build.usage_original))
            FakeClient.usage["usage"]["monthly"]["resetsAt"] = when
            try:
                [go] = core.build(runtime=lambda name, *a: {"api_key": "oc_" + "k" * 48} if name == "opencode-go" else None)["providers"]
            finally:
                FakeClient.usage = Build.usage_original
            self.assertAlmostEqual(go["windows"][0]["estimate"], round(REAL_USD, 4), places=4)
        # Nor does a row of Hermes's records with its time in milliseconds, or anything worked out from them.
        core.usage_rows = lambda since: [REAL, dict(REAL, first=1.79e12, last=1.79e12)]
        body = core.build(runtime=lambda name, *a: {"api_key": "oc_" + "k" * 48} if name == "opencode-go" else None)
        self.assertTrue(body["providers"][0]["ok"])
        self.assertAlmostEqual(body["providers"][0]["spent"]["day"]["cost"], REAL_USD * 2, places=6)
        with mock.patch.object(core, "spent_by_kind", lambda *a: 1 / 0):
            body = core.build(runtime=lambda name, *a: {"api_key": "oc_" + "k" * 48} if name == "opencode-go" else None)
        self.assertEqual((body["providers"][0]["ok"], body["providers"][0]["spent"]), (True, None))

    def test_the_fixed_part_on_disk_is_another(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            f = tmp / "plugin_api.py"
            f.write_text('SHELL_VERSION = "1.3.0"\n', encoding="utf-8")
            self.assertTrue(core.shell_stale({"shell": "1.2.0", "shell_file": str(f)}))
            self.assertFalse(core.shell_stale({"shell": "1.3.0", "shell_file": str(f)}))
            f.write_text("nothing", encoding="utf-8")
            self.assertFalse(core.shell_stale({"shell": "1.2.0", "shell_file": str(f)}))
            self.assertFalse(core.shell_stale({"shell": "1.2.0", "shell_file": str(tmp / "none.py")}))
            self.assertFalse(core.shell_stale({}))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


Build.usage_original = FakeClient.usage


class UsageByKey(unittest.TestCase):
    """recorder.py (which key each answer was made with) and how it's told apart."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.home = types.ModuleType("hermes_constants")
        self.home.get_hermes_home = lambda: self.tmp
        self.mods = mock.patch.dict(sys.modules, {"hermes_constants": self.home})
        self.mods.start()
        self.rec = load(DASH.parent / "recorder.py", "pedila_recorder_test")

    def tearDown(self):
        self.mods.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def usage(self, i=0, o=0, cr=0, cw=0):
        return types.SimpleNamespace(input_tokens=i, output_tokens=o, cache_read_tokens=cr, cache_write_tokens=cw)

    def recorder(self):
        r = self.rec.Recorder(core.kind_of)
        r.start = lambda: None  # without its thread
        return r

    def fp(self, key):
        return core.hashlib.sha256(key.encode()).hexdigest()[:16]

    def test_it_adds_up_by_hour_key_and_model(self):
        a, b = cred("one", "a").access_token, cred("two", "b").access_token
        r = self.recorder()
        for key, when, inp in ((a, NOW, 10), (a, NOW + 5, 20), (b, NOW, 7), (a, NOW - 7200, 1)):
            r.note(GO_URL + "/", key, "glm-5.3", self.usage(inp, 2, 100, 3), now=when)
        r.note("http://127.0.0.1:8080/v1", a, "m", self.usage(5), now=NOW)       # local: it isn't a paid API
        r.note(GO_URL, lambda: "x", "m", self.usage(5), now=NOW)                 # a key that can't be told
        r.note(GO_URL, a, "m", self.usage(), now=NOW)                            # nothing was spent
        with mock.patch.object(self.rec.time, "time", lambda: NOW):
            r.flush()
        since, rows = core.key_rows(NOW - 86400)
        got = sorted((x["key"] == self.fp(a), x["input"], x["output"], x["cache_read"], x["cache_write"], x["calls"], x["model"], x["last"]) for x in rows)
        self.assertEqual(got, [(False, 7, 2, 100, 3, 1, "glm-5.3", NOW), (True, 1, 2, 100, 3, 1, "glm-5.3", NOW - 7200), (True, 30, 4, 200, 6, 2, "glm-5.3", NOW + 5)])
        self.assertEqual(since, NOW - 7200)
        # The keys are nowhere in what was stored, and the beginning isn't moved by going on.
        data = b"".join(f.read_bytes() for f in (self.tmp / "plugin-data" / "pedila").iterdir())
        self.assertNotIn(a.encode(), data)
        r.note(GO_URL, a, "m", self.usage(1), now=NOW + 50)
        r.flush()
        self.assertEqual(core.key_rows(0)[0], NOW - 7200)

    def test_each_profile_has_its_own(self):
        other = Path(tempfile.mkdtemp())
        try:
            r = self.recorder()
            key = cred("one", "a").access_token
            r.note(GO_URL, key, "mine", self.usage(5))
            self.home.get_hermes_home = lambda: other
            r.note(GO_URL, key, "theirs", self.usage(6))
            r.flush()
            self.assertEqual([x["model"] for x in core.key_rows(0)[1]], ["theirs"])
            self.home.get_hermes_home = lambda: self.tmp
            self.assertEqual([x["model"] for x in core.key_rows(0)[1]], ["mine"])
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_the_thread_writes_and_stops(self):
        r = self.rec.Recorder(core.kind_of)
        with mock.patch.object(self.rec, "FLUSH_SECONDS", 0.01):
            for n in range(40):
                r.note(GO_URL, cred("one", "a").access_token, "m", self.usage(1))
                time.sleep(0.001)
            for _ in range(200):
                got = core.key_rows(0)
                if got and sum(x["input"] for x in got[1]) == 40:
                    break
                time.sleep(0.02)
        self.assertEqual(sum(x["input"] for x in core.key_rows(0)[1]), 40)
        r.note(GO_URL, cred("one", "a").access_token, "last", self.usage(2))
        r.stop()  # what was pending is written before it ends
        self.assertIn("last", [x["model"] for x in core.key_rows(0)[1]])
        r.thread.join(5)
        self.assertFalse(r.thread.is_alive())

    def test_nothing_is_lost_when_the_process_ends(self):
        script = ("import importlib.util,sys,types,atexit\n"
                  "m=types.ModuleType('hermes_constants'); m.get_hermes_home=lambda: sys.argv[2]; sys.modules['hermes_constants']=m\n"
                  "s=importlib.util.spec_from_file_location('r',sys.argv[1]); r=importlib.util.module_from_spec(s); s.loader.exec_module(r)\n"
                  "x=r.Recorder(lambda u:'opencode-go'); atexit.register(x.flush)\n"
                  "x.note('u','k'*20,'m',types.SimpleNamespace(input_tokens=5)); import time; time.sleep(float(sys.argv[3]))\n")
        for wait in ("0", "0.1"):
            subprocess.run([sys.executable, "-I", "-c", script, str(DASH.parent / "recorder.py"), str(self.tmp), wait], check=True, timeout=30)
        self.assertEqual(sum(x["calls"] for x in core.key_rows(0)[1]), 2)

    def test_what_is_old_goes_away(self):
        r = self.recorder()
        key = cred("one", "a").access_token
        r.note(GO_URL, key, "old", self.usage(5), now=time.time() - 41 * 86400)
        r.note(GO_URL, key, "new", self.usage(5), now=time.time() - 39 * 86400)
        r.flush()
        self.assertEqual([x["model"] for x in core.key_rows(0)[1]], ["new"])

    def test_without_a_record(self):
        self.assertIsNone(core.key_rows(0))
        (self.tmp / "plugin-data" / "pedila").mkdir(parents=True)
        (self.tmp / "plugin-data" / "pedila" / "usage.db").write_bytes(b"this isn't a database, it only looks like one")
        self.assertIsNone(core.key_rows(0))
        r = self.recorder()
        r.note(GO_URL, cred("one", "a").access_token, "m", self.usage(5))
        r.flush()  # it can't be written: nothing happens

    def hermes(self):
        """A make-believe Hermes: the functions recorder.py listens to."""
        calls = self.calls = []

        def add_session_usage(agent, usage, *, prompt_tokens=0, completion_tokens=0, total_tokens=0):
            calls.append(("chat", prompt_tokens))
            return "chat"

        def record_aux_usage(response, task, *, provider=None, base_url=None, serving=None):
            calls.append(("aux", task))
            return "aux"

        class ServingCredential:
            of = staticmethod(lambda client: client)

        class PromptCacheWarmer:
            def _record(self, run, usage):
                if usage is None:
                    raise ValueError("a keep-alive that fails")
                return pkg.turn_usage.add_session_usage(self.agent, usage)

        async def relay_async(client, kwargs, *, provider=None):
            return kwargs["answer"]
        pkg = types.ModuleType("agent")
        pkg.turn_usage = types.SimpleNamespace(add_session_usage=add_session_usage)
        pkg.aux_accounting = types.SimpleNamespace(record_aux_usage=record_aux_usage, ServingCredential=ServingCredential, _EXCLUDED_TASKS=frozenset({"moa_reference"}))
        pricing = types.ModuleType("agent.usage_pricing")
        pricing.normalize_usage = lambda raw, provider=None: raw
        aux = types.ModuleType("agent.auxiliary_client")
        aux._relay_sync_completion = lambda client, kwargs, *, provider=None: kwargs["answer"]
        aux._relay_async_completion = relay_async
        warmer = types.ModuleType("agent.prompt_cache_lifecycle.warmer")
        warmer.PromptCacheWarmer = PromptCacheWarmer
        return pkg, {"agent": pkg, "agent.usage_pricing": pricing, "agent.auxiliary_client": aux, "agent.prompt_cache_lifecycle.warmer": warmer}

    def test_it_wraps_hermes_without_changing_what_it_does(self):
        pkg, mods = self.hermes()
        a, b = cred("one", "a").access_token, cred("two", "b").access_token
        with mock.patch.dict(sys.modules, mods):
            self.assertTrue(self.rec.install(core.kind_of))
            first = pkg.turn_usage.add_session_usage
            # Another version of the file takes over: it's wrapped once, and only the new one notes down.
            old = self.rec._current["rec"]
            again = load(DASH.parent / "recorder.py", "pedila_recorder_test_2")
            self.assertTrue(again.install(core.kind_of))
            self.rec.stop()
            self.assertTrue(old.stopped)
            old.note(GO_URL, a, "on-its-way", self.usage(1))  # an answer that was on its way isn't lost
            self.assertIs(pkg.turn_usage.add_session_usage, first)
            rec = again._current["rec"]
            rec.start = lambda: None
            ag = types.SimpleNamespace(base_url=GO_URL, api_key=a, model="glm-5.3", provider="opencode-go")
            self.assertEqual(first(ag, self.usage(5, 1), prompt_tokens=5, completion_tokens=1, total_tokens=6), "chat")
            ag.api_key = b  # Hermes moved on to the next key
            first(ag, self.usage(8, 1), prompt_tokens=8, completion_tokens=1, total_tokens=9)
            first(types.SimpleNamespace(base_url=GO_URL, api_key=a, model="mix", provider="moa"), self.usage(99), prompt_tokens=99)
            first(None, None)  # something unexpected doesn't reach Hermes
            aux = pkg.aux_accounting.record_aux_usage
            serving = types.SimpleNamespace(base_url=GO_URL, api_key=b)
            resp = types.SimpleNamespace(usage=self.usage(3, 3), model="glm-5.3-flash")
            self.assertEqual(aux(resp, "vision", provider="opencode-go", serving=serving), "aux")
            aux(resp, "moa_reference", serving=serving)
            aux(resp, "vision", serving=None)
            aux(types.SimpleNamespace(usage=None), "vision", serving=serving)
            self.assertEqual(self.calls, [("chat", 5), ("chat", 8), ("chat", 99), ("chat", 0), ("aux", "vision"), ("aux", "moa_reference"), ("aux", "vision"), ("aux", "vision")])
            # With an error of Hermes's own, the error is the same and nothing is noted down.
            with self.assertRaises(TypeError):
                first()
            rec.flush()
        got = sorted((x["model"], x["key"] == self.fp(a), x["input"]) for x in core.key_rows(0)[1])
        self.assertEqual(got, [("glm-5.3", False, 8), ("glm-5.3", True, 5), ("glm-5.3-flash", False, 3), ("on-its-way", True, 1)])

    def test_auxiliary_calls_tried_again_with_another_key(self):
        """Hermes doesn't say which client answered when it had to try again."""
        pkg, mods = self.hermes()
        a, b = cred("one", "a").access_token, cred("two", "b").access_token
        client = lambda k: types.SimpleNamespace(base_url=GO_URL, api_key=k)  # noqa: E731
        answer = lambda n: types.SimpleNamespace(usage=self.usage(n), model="m")  # noqa: E731
        with mock.patch.dict(sys.modules, mods):
            self.assertTrue(self.rec.install(core.kind_of))
            rec = self.rec._current["rec"]
            rec.start = lambda: None
            aux, record = mods["agent.auxiliary_client"], pkg.aux_accounting.record_aux_usage
            one = aux._relay_sync_completion(client(b), {"answer": answer(10)}, provider="opencode-go")
            record(one, "compression")
            record(one, "compression")  # it isn't known any more: it isn't given to anybody
            aux._relay_sync_completion(client(a), {"answer": answer(50)})
            record(answer(50), "image_generation")  # another answer, which didn't come through there

            async def turn():
                two = await aux._relay_async_completion(client(a), {"answer": answer(7)})
                await asyncio.to_thread(record, two, "vision")
            asyncio.run(turn())
            rec.flush()
        got = sorted((x["key"] == self.fp(a), x["input"]) for x in core.key_rows(0)[1])
        self.assertEqual(got, [(False, 10), (True, 7)])

    def test_a_cache_keep_alive_goes_with_what_it_was_sent_with(self):
        pkg, mods = self.hermes()
        a, b = cred("one", "a").access_token, cred("two", "b").access_token
        with mock.patch.dict(sys.modules, mods):
            self.assertTrue(self.rec.install(core.kind_of))
            rec = self.rec._current["rec"]
            rec.start = lambda: None
            w = mods["agent.prompt_cache_lifecycle.warmer"].PromptCacheWarmer()
            w.agent = types.SimpleNamespace(base_url=GO_URL, api_key=a, model="now", provider="opencode-go")
            run = types.SimpleNamespace(billing={"base_url": GO_URL, "api_key": b, "model": "then"})
            w._record(run, self.usage(4))
            with self.assertRaises(ValueError):
                w._record(run, None)
            pkg.turn_usage.add_session_usage(w.agent, self.usage(6))  # afterwards, the agent's again
            rec.flush()
        got = sorted((x["model"], x["key"] == self.fp(a), x["input"]) for x in core.key_rows(0)[1])
        self.assertEqual(got, [("now", True, 6), ("then", False, 4)])

    def test_a_hermes_without_those_functions(self):
        pkg = types.ModuleType("agent")
        pkg.turn_usage = types.SimpleNamespace()
        pkg.aux_accounting = types.SimpleNamespace()
        with mock.patch.dict(sys.modules, {"agent": pkg}):
            self.assertFalse(self.rec.install(core.kind_of))
        self.assertIsNone(core.key_rows(0))

    def answer(self, rows, noted, entries, since=0.0):
        try:
            import httpx
        except ImportError:
            self.skipTest("without httpx (tested with the Python of Hermes)")
        rt = lambda name, *x: {"api_key": entries[0].access_token, "base_url": GO_URL, "credential_pool": Pool(entries)} if name == "opencode-go" else None  # noqa: E731
        with mock.patch.object(httpx, "Client", FakeClient), mock.patch.object(core, "usage_rows", lambda s: rows), mock.patch.object(core, "_config", lambda: {}), \
                mock.patch.object(core.time, "time", lambda: NOW), mock.patch.object(core, "key_rows", lambda s: (since, noted) if noted is not None else None):
            return core.build(runtime=rt)["providers"]

    def models(self, sp, span="month"):
        return [(m["model"], m["tokens"]) for m in sp[span]["models"]] if sp else None

    def test_each_key_with_its_own(self):
        a, b = cred("one", "a"), cred("OpenCode Go (extra)", "b")
        noted = [{**row("glm-5.3", inp=100, out=50, calls=2, first=NOW - 600, last=NOW - 60), "key": self.fp(a.access_token)},
                 {**row("glm-5.3-flash", inp=7, out=0, calls=1, first=NOW - 60, last=NOW - 60), "key": self.fp(b.access_token)},
                 {**row("other", kind="venice", inp=9, last=NOW), "key": self.fp(a.access_token)}]
        rows = [row("glm-5.3", inp=100, out=50, calls=2, first=NOW - 600, last=NOW - 60), row("glm-5.3-flash", inp=7, first=NOW - 60, last=NOW - 60)]
        one, two = self.answer(rows, noted, [a, b])
        self.assertEqual((self.models(one["spent"], "day"), self.models(two["spent"], "day")), ([("glm-5.3", 150)], [("glm-5.3-flash", 7)]))
        self.assertTrue("spent_all" not in one and "spent_rest" not in one and "spent_rest" not in two)
        # Nothing noted down yet: the same as before, all the keys together.
        for nothing in (None, [], noted[2:]):
            one, two = self.answer(rows, nothing, [a, b])
            self.assertEqual((one["spent"], self.models(one["spent_all"])), (None, [("glm-5.3", 150), ("glm-5.3-flash", 7)]))
        # With a single key, what Hermes recorded (all of it is that one's).
        [only] = self.answer(rows, noted[:1], [a])
        self.assertEqual(self.models(only["spent"]), [("glm-5.3", 150), ("glm-5.3-flash", 7)])

    def test_what_isnt_known_is_said_apart(self):
        a, b = cred("one", "a"), cred("two", "b")
        key = lambda c, *x, **k: {**row(*x, **k), "key": self.fp(c.access_token)}  # noqa: E731
        spans = lambda sp: [sp[s]["tokens"] for s in ("day", "week", "month")]  # noqa: E731
        # A chat from five days ago that goes on: what's from before there was a record is 3 million of its 10.
        rows = [row("m", inp=10_010_000, calls=110, first=NOW - 5 * 86400, last=NOW), row("only-before", inp=400, calls=4, first=NOW - 9 * 86400, last=NOW - 8 * 86400)]
        noted = [key(a, "m", inp=7_010_000, calls=60, first=NOW - 3500, last=NOW)]
        one, two = self.answer(rows, noted, [a, b], since=NOW - 3600)
        self.assertEqual(self.models(one["spent"]), [("m", 7_010_000)])
        self.assertIsNone(two["spent"])
        self.assertEqual(self.models(two["spent_rest"]), [("m", 3_000_000), ("only-before", 400)])
        # A lot from before doesn't make the chats that were noted down look unknown, and no span is above a longer one.
        rows = [row("m", inp=60_000_000, first=NOW - 10 * 86400, last=NOW - 9 * 86400), row("m", inp=1_000_000, first=NOW - 40 * 3600, last=NOW)]
        noted = [key(a, "m", inp=900_000, first=NOW - 40 * 3600, last=NOW - 39 * 3600), key(a, "m", inp=100_000, first=NOW - 7200, last=NOW)]
        self.assertEqual(spans(self.answer(rows, noted, [a, b], since=NOW - 41 * 3600)[1]["spent_rest"]), [0, 0, 60_000_000])
        # A chat that was noted down and then deleted doesn't hide what's from before.
        rows = [row("m", inp=1_000_000, last=NOW - 5 * 86400)]
        self.assertEqual(spans(self.answer(rows, [key(a, "m", inp=1_000_000, last=NOW - 60)], [a, b], since=NOW - 86400)[1]["spent_rest"]), [0, 1_000_000, 1_000_000])
        # A chat of months, all of it noted down since the record covers the 30 days: nothing is missing.
        rows = [row("m", inp=60_000_000, first=NOW - 60 * 86400, last=NOW)]
        self.assertNotIn("spent_rest", self.answer(rows, [key(a, "m", inp=5_000_000, first=NOW - 29 * 86400, last=NOW)], [a, b], since=NOW - 31 * 86400)[1])
        # Something that Hermes recorded and wasn't noted down (a process without the plugin).
        rows = [row("m", inp=500, first=NOW - 60, last=NOW - 50), row("n", inp=80, first=NOW - 60, last=NOW - 50)]
        self.assertEqual(self.models(self.answer(rows, [key(a, "m", inp=495, last=NOW - 50)], [a, b], since=NOW - 86400)[1]["spent_rest"], "day"), [("n", 80)])

    def test_a_single_key_left(self):
        a = cred("one", "a")
        noted = [{**row("m", inp=2, last=NOW - 10), "key": self.fp(a.access_token)}, {**row("m", inp=20, last=NOW - 10), "key": "0" * 16}]
        [only] = self.answer([row("m", inp=22, last=NOW - 10)], noted, [a])
        self.assertEqual((self.models(only["spent"]), self.models(only["spent_rest"])), ([("m", 2)], [("m", 20)]))

    def test_keys_that_arent_shown(self):
        a, b = cred("one", "a"), cred("two", "b")
        noted = [{**row("m", inp=5, last=NOW - 10), "key": self.fp(a.access_token)}, {**row("m", inp=9000, calls=3, last=NOW - 10), "key": "0" * 16},
                 {**row("gone", inp=40, last=NOW - 10), "key": "0" * 16}]
        one, two = self.answer([row("m", inp=9005, last=NOW - 10)], noted, [a, b])
        self.assertEqual((self.models(one["spent"]), self.models(two["spent_rest"])), ([("m", 5)], [("m", 9000), ("gone", 40)]))

    def test_the_cost(self):
        rows = [row("Dear", kind="openrouter", inp=800, out=200, cost=2.0), row("dear", kind="openrouter", inp=1000, cost=2.0), row("free", kind="openrouter", inp=10)]
        got = core.with_cost([{**row("dear", kind="openrouter", inp=400, out=100), "key": "x"}, {**row("free", kind="openrouter", inp=5), "key": "x"}], rows)
        self.assertEqual([r["cost"] for r in got], [1.0, 0.0])

    def test_decimals_of_each_key(self):
        a, b = cred("one", "a"), cred("two", "b")
        noted = [{**REAL, "key": self.fp(a.access_token)}]
        one, two = self.answer([REAL], noted, [a, b], since=NOW - 40 * 86400)
        self.assertAlmostEqual(one["windows"][0]["estimate"], round(REAL_USD, 4), places=4)
        self.assertEqual((one["windows"][2]["cost"], two["windows"][2]["cost"]), (round(REAL_USD, 6), 0))
        # In the windows that started before there was a record, there's no telling.
        one, _two = self.answer([REAL], noted, [a, b], since=NOW - 3600)
        self.assertNotIn("estimate", one["windows"][2])
        self.assertIsNotNone(one["windows"][0]["estimate"])
        # Another process spent with one of them and it wasn't noted down: the record isn't enough for the decimals. With
        # the other key idle, all of it is this one's, as before there was a record.
        more = row(inp=150000, out=50000, cr=1200000, calls=32, first=REAL["first"], last=REAL["last"])
        self.assertNotIn("estimate", self.answer([REAL, more], noted, [a, b], since=NOW - 40 * 86400)[0]["windows"][2])
        idle = {"usage": {"rolling": {"status": "ok", "percent": 0, "resetsAt": core._iso_at(NOW + 5 * 3600)}}}
        with mock.patch.object(FakeClient, "by_key", {b.access_token: idle}):
            one, _two = self.answer([REAL, more], noted, [a, b], since=NOW - 40 * 86400)
        self.assertEqual(one["windows"][0]["cost"], round(REAL_USD * 2, 6))

class ModelsUsed(unittest.TestCase):
    """What Hermes spent with each API, model by model."""

    def test_by_model_and_time(self):
        rows = [row("Big", kind="venice", inp=100, out=50, cr=1000, cw=10, calls=3, last=NOW - 3600),
                row("big", kind="venice", inp=10, out=5, calls=1, last=NOW - 2 * 86400),
                row("Small", kind="venice", inp=1, out=1, calls=1, last=NOW - 3600, cost=0.25),
                row("Old", kind="venice", inp=500, out=0, calls=9, last=NOW - 20 * 86400),
                row("", kind="deepseek", inp=4, out=4, last=NOW - 60)]
        out = core.spent_by_kind(rows, NOW)
        v = out["venice"]
        self.assertEqual([(m["model"], m["tokens"], m["cache"], m["calls"]) for m in v["day"]["models"]], [("Big", 150, 1010, 3), ("Small", 2, 0, 1)])
        self.assertEqual([(m["model"], m["tokens"]) for m in v["week"]["models"]], [("Big", 165), ("Small", 2)])
        self.assertEqual([(m["model"], m["tokens"]) for m in v["month"]["models"]], [("Old", 500), ("Big", 165), ("Small", 2)])
        self.assertEqual((v["month"]["tokens"], v["month"]["calls"], v["month"]["cost"], v["month"]["cache"]), (667, 14, 0.25, 1010))
        self.assertEqual((v["day"]["models"][0]["input"], v["day"]["models"][0]["output"]), (100, 50))
        self.assertIsNone(v["day"]["others"])
        self.assertEqual(out["deepseek"]["day"]["models"][0]["model"], "?")

    def test_a_long_chat_is_split_by_the_time(self):
        # 10 days of chat, up to now: a tenth in the last 24 h and seven in the last 7 days.
        out = core.spent_by_kind([row("m", kind="venice", inp=1000, out=0, calls=100, first=NOW - 10 * 86400, last=NOW)], NOW)["venice"]
        self.assertEqual([(out[p]["tokens"], out[p]["calls"], out[p]["models"][0]["tokens"]) for p in ("day", "week", "month")], [(100, 10, 100), (700, 70, 700), (1000, 100, 1000)])

    def test_more_models_than_the_ones_told_apart(self):
        rows = [row(f"m{i:02d}", kind="venice", inp=100 - i, last=NOW) for i in range(core.MAX_MODELS + 3)]
        day = core.spent_by_kind(rows, NOW)["venice"]["day"]
        self.assertEqual(len(day["models"]), core.MAX_MODELS)
        self.assertEqual(day["models"][0]["model"], "m00")
        self.assertEqual(day["others"], {"models": 3, "tokens": 88 + 87 + 86})
        self.assertEqual(sum(m["tokens"] for m in day["models"]) + day["others"]["tokens"], day["tokens"])

    def test_nothing(self):
        self.assertEqual(core.spent_by_kind([], NOW), {})
        # Used long ago: there's nothing in any of the three.
        out = core.spent_by_kind([row("m", kind="venice", inp=5, last=NOW - 31 * 86400), row("z", kind="venice", calls=0, last=NOW)], NOW)["venice"]
        self.assertEqual([out[p]["models"] for p in ("day", "week", "month")], [[], [], []])


class NewProviders(unittest.TestCase):
    """DeepSeek and Openference."""
    ME = {"userId": 7, "status": "active", "planId": None, "email": "someone@example.com", "firstName": "Some", "apiKey": "sk-of-of-the-account",
          "planExpiresAt": None, "usage": {"totalRequests": 8, "totalTokens": 25529, "totalCost": 0},
          "credits": {"balanceUsd": 0, "totalPurchasedUsd": 0},
          "plan": {"name": "Promo", "windowHours": None, "requestsPerWeek": None, "requestsPerWindow": None, "tokensPerWeek": None},
          "limits": {"windowLimit": None, "windowRequests": 0, "weekTokens": 25009, "requestsPerWeek": None, "tokensPerWeek": None,
                     "windowResetAt": None, "weeklyResetAt": None, "allowance": None}}
    MODELS = {"data": [{"id": "Free-1", "is_free": True, "free_until": "2026-12-04"}, {"id": "Free-2", "is_free": True, "free_until": "soon"},
                       {"id": "Paid"}, {"id": "Odd", "is_free": "yes"}, None, {"is_free": True}]}

    def setUp(self):
        core._free.update(at=0.0, failed_at=0.0, models=None)
        self.calls = []

    def client(self, routes):
        def get(url, headers=None, timeout=None):
            self.calls.append((url, dict(headers or {})))
            r = routes.get(url, (404, {}))
            if isinstance(r, Exception):
                raise r
            return _Resp(*r)
        return types.SimpleNamespace(get=get)

    def test_addresses(self):
        for url, kind in (("https://api.deepseek.com", "deepseek"), ("https://api.deepseek.com/anthropic", "deepseek"), ("http://api.deepseek.com/v1", None),
                          ("https://api.deepseek.com.evil.example/v1", None), ("https://api.openference.com/v1", "openference"),
                          ("https://api.openference.com/", "openference"), ("https://openference.com.example", None)):
            self.assertEqual(core.kind_of(url), kind, url)

    def test_orcarouter(self):
        for url, kind in (("https://api.orcarouter.ai/v1", "orcarouter"), ("https://orcarouter.ai/api/v1", "orcarouter"), ("http://api.orcarouter.ai/v1", None),
                          ("https://api.orcarouter.ai.evil.example/v1", None), ("https://notorcarouter.ai/v1", None)):
            self.assertEqual(core.kind_of(url), kind, url)
        # Its real answer (2026-11-27): /key and /credits are OpenRouter's, under /api/v1 and not under /v1, where the chats go.
        key = {"data": {"label": "hermes", "limit": None, "limit_remaining": None, "limit_reset": None, "usage": 0, "usage_daily": 0, "usage_weekly": 0,
                        "usage_monthly": 0, "is_free_tier": True, "is_management_key": False, "workspace_id": "1000", "rate_limit": {"requests": -1, "interval": "10s"}}}
        routes = {"https://api.orcarouter.ai/api/v1/key": (200, key), "https://api.orcarouter.ai/api/v1/credits": (200, {"data": {"total_credits": 5, "total_usage": 1.25}})}
        e = {"base": "https://api.orcarouter.ai/v1/", "key": "sk-orca-key-of-the-test"}
        self.assertEqual(core.fetch_orcarouter(self.client(routes), e), {
            "credits_total": 5.0, "credits_used": 1.25, "balance": 3.75, "free_tier": True, "key_limit": None,
            "key_usage": {"total": 0.0, "day": 0.0, "week": 0.0, "month": 0.0}})
        self.assertEqual([u for u, _h in self.calls], list(routes))
        self.assertTrue(all(h["Authorization"] == "Bearer sk-orca-key-of-the-test" for _u, h in self.calls))
        # Without the balance it goes on; without /key, it fails without saying the key.
        del routes["https://api.orcarouter.ai/api/v1/credits"]
        self.assertIsNone(core.fetch_orcarouter(self.client(routes), e)["balance"])
        with self.assertRaises(core._Fail) as err:
            core.fetch_orcarouter(self.client({}), e)
        self.assertNotIn("sk-orca", str(err.exception))
        self.assertIs(core.FETCHERS["orcarouter"], core.fetch_orcarouter)
        self.assertEqual(core.NAMES["orcarouter"], "OrcaRouter")

    def test_deepseek(self):
        url = "https://api.deepseek.com/user/balance"
        e = {"base": "https://api.deepseek.com/v1", "key": "sk-deepseek-key"}
        body = {"is_available": False, "balance_infos": [{"currency": "USD", "total_balance": "0.00", "granted_balance": "0.00", "topped_up_balance": "0.00"},
                                                         {"currency": "EUR", "total_balance": "1.50"}, {"currency": "CNY", "total_balance": "x"}, None]}
        self.assertEqual(core.fetch_deepseek(self.client({url: (200, body)}), e), {"available": False, "balances": [
            {"currency": "USD", "total": 0.0, "granted": 0.0, "topped_up": 0.0}, {"currency": "", "total": 1.5, "granted": None, "topped_up": None}]})
        self.assertEqual(self.calls[0][1]["Authorization"], "Bearer sk-deepseek-key")
        for bad in ((200, {}), (200, {"balance_infos": "x"}), (401, {}), (500, {})):
            with self.assertRaises(core._Fail):
                core.fetch_deepseek(self.client({url: bad}), e)

    def test_openference_without_a_plan(self):
        e = {"base": "https://api.openference.com/v1", "key": "sk-openference-key"}
        out = core.fetch_openference(self.client({"https://api.openference.com/api/user/me": (200, self.ME), core.OPENFERENCE_MODELS_URL: (200, self.MODELS)}), e)
        self.assertEqual(out, {"balance": 0.0, "credits_total": 0.0, "plan_name": "Promo", "subscribed": False, "expires_at": None, "active": True,
                               "windows": [], "account_usage": {"requests": 8.0, "tokens": 25529.0, "cost": 0.0},
                               "free_models": [{"model": "Free-1", "until": "2026-12-04"}, {"model": "Free-2", "until": None}]})
        text = json.dumps(out)
        for private in ("someone", "Some", "sk-", "userId"):
            self.assertNotIn(private, text)
        # The catalog is asked for WITHOUT the key, and remembered.
        heads = dict(self.calls)
        self.assertNotIn("Authorization", heads[core.OPENFERENCE_MODELS_URL])
        self.assertEqual(heads["https://api.openference.com/api/user/me"]["Authorization"], "Bearer sk-openference-key")
        self.calls.clear()
        core.fetch_openference(self.client({"https://api.openference.com/api/user/me": (200, self.ME)}), e)
        self.assertEqual([u for u, _h in self.calls], ["https://api.openference.com/api/user/me"])

    def test_openference_without_the_catalog(self):
        e = {"base": "https://api.openference.com/v1", "key": "sk-openference-key"}
        for broken in ((500, {}), (200, ValueError("no json")), (200, []), OSError("down")):
            core._free.update(at=0.0, failed_at=0.0, models=None)
            out = core.fetch_openference(self.client({"https://api.openference.com/api/user/me": (200, self.ME), core.OPENFERENCE_MODELS_URL: broken}), e)
            self.assertIsNone(out["free_models"])
            self.assertEqual(out["balance"], 0.0)
        for bad in ((401, {}), (200, {}), (200, {"plan": "x", "credits": 3})):
            with self.assertRaises(core._Fail):
                core.fetch_openference(self.client({"https://api.openference.com/api/user/me": bad}), e)

    def test_openference_plans(self):
        w = core.openference_windows
        self.assertEqual(w({}), [])
        self.assertEqual(w({"limits": "x", "plan": 3}), [])
        # A token plan: percentages. The reset may come as a date or as a number, and 0 is "not known".
        got = w({"plan": {"windowHours": None}, "limits": {"allowance": {"windowPercent": 34, "weeklyPercent": 148.2, "monthlyPercent": None,
                 "windowResetAt": "2026-11-24T19:00:00.000Z", "weeklyResetAt": 1795960800000, "monthlyResetAt": 0}}})
        self.assertEqual([(x["id"], x["percent"], x["hours"], x["limit"]) for x in got], [("rolling", 34.0, 5, None), ("weekly", 100.0, None, None)])
        self.assertEqual(got[0]["resets_at"], "2026-11-24T19:00:00+00:00")
        self.assertEqual(got[1]["resets_at"], datetime.fromtimestamp(1795960800, UTC).isoformat())
        # One of the old request plans: count against limit.
        got = w({"plan": {"windowHours": 4, "requestsPerWeek": 1000}, "limits": {"windowLimit": 200, "windowQuotaUsed": 50, "windowRequests": 9,
                 "weekQuotaUsed": None, "weekRequests": 10, "weekTokens": 5, "tokensPerWeek": 0, "windowResetAt": 0}})
        self.assertEqual(got, [{"id": "rolling", "percent": 25.0, "resets_at": None, "hours": 4.0, "used": 50.0, "limit": 200.0, "unit": "requests"},
                               {"id": "weekly", "percent": 1.0, "resets_at": None, "hours": None, "used": 10.0, "limit": 1000.0, "unit": "requests"}])

    def test_the_whole_answer(self):
        try:
            import httpx
        except ImportError:
            self.skipTest("without httpx (tested with the Python of Hermes)")
        routes = {"https://api.deepseek.com/user/balance": (200, {"is_available": True, "balance_infos": [{"currency": "USD", "total_balance": "4.20"}]}),
                  "https://api.openference.com/api/user/me": (200, self.ME), core.OPENFERENCE_MODELS_URL: (200, self.MODELS)}
        fake = self.client(routes)
        keys = {"deepseek": "sk-deepseek-secret", "openference": "sk-openference-secret"}
        cfg = {"providers": {"openference": {"api": "https://api.openference.com/v1", "key_env": "X"}}}
        with mock.patch.object(httpx, "Client", lambda *a, **k: mock.MagicMock(__enter__=lambda s: fake, __exit__=lambda *x: False)), \
                mock.patch.object(core, "usage_rows", lambda since: [row("deepseek-flash", kind="deepseek", inp=5, out=5)]), mock.patch.object(core, "_config", lambda: cfg), \
                mock.patch.object(core, "key_rows", lambda since: None):  # (not this PC's real record)
            body = core.build(runtime=lambda name, *a: {"api_key": keys[name]} if name in keys else None)
        self.assertEqual([(p["kind"], p["name"], p["ok"]) for p in body["providers"]], [("deepseek", "DeepSeek", True), ("openference", "Openference", True)])
        self.assertIsNotNone(body["providers"][0]["spent"])
        for k in keys.values():
            self.assertNotIn(k, json.dumps(body))

    def test_a_name_of_hermes_at_another_api(self):
        cfg = {"providers": {"deepseek": {"base_url": "https://api.openference.com/v1", "key_env": "X"}}}
        [e] = core.detect(lambda name, url, b: {"api_key": "sk-the-key", "base_url": "https://api.openference.com/v1"} if name == "deepseek" else None, cfg, NOW)
        self.assertEqual((e["kind"], e["base"]), ("openference", "https://api.openference.com/v1"))


class Keys(unittest.TestCase):
    """Which keys Hermes has for a provider, and what each account is called."""

    def keys(self, entries, current=None, strategy="fill_first", base=GO_URL, kind="opencode-go"):
        return core.keys_of({"api_key": current, "base_url": base, "credential_pool": Pool(entries, strategy)}, kind, GO_URL, NOW)

    def test_one_key_without_a_pool(self):
        self.assertEqual(core.keys_of(None, "opencode-go", GO_URL, NOW), [])
        self.assertEqual(core.keys_of({}, "opencode-go", GO_URL, NOW), [])
        self.assertEqual(core.keys_of({"api_key": "no-key-required"}, "opencode-go", GO_URL, NOW), [])
        [k] = core.keys_of({"api_key": lambda: " oc_from-a-command "}, "opencode-go", GO_URL, NOW)
        self.assertEqual((k["key"], k["active"], k["base"]), ("oc_from-a-command", True, GO_URL))

    def test_what_stays_out(self):
        a, proxy = cred("one", "a"), cred("proxy", "p", base_url="https://proxy.example/v1")
        oauth, empty = cred("login", "o", auth_type="oauth"), cred("empty", "v")
        empty.access_token = ""
        self.assertEqual([k["key"] for k in self.keys([a, proxy, oauth, empty, cred("again", "a")], current=a.access_token)], [a.access_token])
        # A pool that fails to be read doesn't take down the key in use.
        broken = types.SimpleNamespace(entries=lambda: 1 / 0)
        [k] = core.keys_of({"api_key": "oc_the-usual-one", "credential_pool": broken}, "opencode-go", GO_URL, NOW)
        self.assertEqual(k["key"], "oc_the-usual-one")

    def test_a_key_for_another_address_isnt_sent_to_this_one(self):
        proxy = "https://proxy.example/v1"
        # Hermes sends this provider to a proxy: the rows of its pool still carry the usual address (the ones of .env
        # do), but none of them is for here. And its command isn't even run.
        env = cred("OPENCODE_GO_API_KEY", "a", source="env:OPENCODE_GO_API_KEY")
        self.assertEqual(self.keys([env], current=env.access_token, base=proxy), [])
        self.assertEqual(self.keys([env, cred("extra", "b")], current="oc_from-elsewhere", base=proxy), [])
        self.assertEqual(self.keys([], current="oc_the-proxys", base=proxy), [])
        ran = []
        self.assertEqual(self.keys([env], current=lambda: ran.append(1) or "oc_of-the-proxy", base=proxy), [])
        self.assertEqual(ran, [])
        # Not even if the one in use is another, with that address of its own: the ones of .env always carry the usual one.
        own = cred("proxy", "p", base_url=proxy)
        self.assertEqual(self.keys([own, env], current=own.access_token, base=proxy), [])
        # A key without an address is its provider's: only with one of Hermes's own that it resolved here.
        loose = cred("old", "o", base_url=None)
        ask = lambda used_at, builtin: [k["key"] for k in core.keys_of({"api_key": None, "base_url": used_at, "credential_pool": Pool([loose, env])}, "opencode-go", GO_URL, NOW, builtin)]  # noqa: E731
        self.assertEqual(ask(GO_URL, True), [loose.access_token, env.access_token])
        for used_at, builtin in ((GO_URL, False), (None, True), (None, False)):
            self.assertEqual(ask(used_at, builtin), [env.access_token])
        # Not in the clear, either; and another API's isn't this one's.
        self.assertIsNone(core.kind_of("http://openrouter.ai/api/v1"))
        self.assertIsNone(core.kind_of("openrouter.ai/api/v1"))
        self.assertIsNone(core.kind_of("https://[broken"))
        self.assertEqual(self.keys([], current="sk-of-openrouter", base="https://openrouter.ai/api/v1"), [])

    def test_the_one_in_use_outside_the_pool_goes_first(self):
        a = cred("one", "a")
        self.assertEqual([(k["key"], k["active"]) for k in self.keys([a], current="oc_from-elsewhere")], [("oc_from-elsewhere", True), (a.access_token, False)])

    def test_how_long_it_rests(self):
        """It's Hermes who says it; with an older one, without `sole_credential`; without Hermes, the time it gave."""
        e = cred("one", "a", last_status="exhausted", last_error_reset_at=1.9e12)  # in milliseconds
        calls = []

        def module(fn):
            m = types.ModuleType("agent.credential_pool")
            if fn:
                m._exhausted_until = fn
            return mock.patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.credential_pool": m})
        with module(lambda entry, sole_credential=False: calls.append(sole_credential) or 50.0):
            self.assertEqual(core._resting_until(e, True), 50.0)
        with module(lambda entry: 60.0):
            self.assertEqual(core._resting_until(e, True), 60.0)
        with module(None):
            self.assertEqual(core._resting_until(e, True), 1.9e9)
        self.assertEqual(calls, [True])

    def test_labels(self):
        key = "oc_sk_d346969651c2_" + "aB3" * 10
        lab = lambda label, **k: core.label_of(cred(label, "a", **k), [key])  # noqa: E731
        self.assertEqual(lab("OpenCode Go (extra)"), "OpenCode Go (extra)")
        self.assertEqual(lab("  Ann's \n work  key "), "Ann's work key")
        for mine in ("WORK", "1", "2", "A", "oc", "a subscription for the house", "my-second-subscription-of-all", "opencode_go_extra_key_two"):
            self.assertEqual(lab(mine), mine[:40])
        for auto in ("api-key-2", "key #3", "opencode-go-oauth-1", "", key, f"mine {key}", key[:12], "sk-or-v1-0a1b2c3d4e5f6a7b8c9d"):
            self.assertEqual(lab(auto), "", auto)
        self.assertEqual(lab("OPENCODE_GO_API_KEY", source="env:OPENCODE_GO_API_KEY"), "")
        self.assertEqual(lab("My provider", source="config:My provider"), "")
        self.assertEqual(len(lab("a long label " * 5)), 40)

    def test_titles(self):
        group = lambda *es: [{"kind": "opencode-go", "name": n, "label": l} for n, l in es]  # noqa: E731
        go = "opencode-go"
        self.assertEqual(core.titles_of(group((go, ""))), ["OpenCode Go"])
        self.assertEqual(core.titles_of(group((go, ""), (go, "OpenCode Go (extra)"))), ["OpenCode Go", "OpenCode Go (extra)"])
        self.assertEqual(core.titles_of(group((go, ""), (go, "work"), (go, ""))), ["OpenCode Go", "OpenCode Go · work", "OpenCode Go 3"])
        self.assertEqual(core.titles_of(group((go, "home"), (go, "home"))), ["OpenCode Go · home", "OpenCode Go · home (2)"])
        self.assertEqual(core.titles_of(group((go, ""), ("my-go", ""))), ["OpenCode Go", "OpenCode Go · my-go"])
        self.assertTrue(all(len(t) <= 40 for t in core.titles_of(group((go, "x" * 40), (go, "x" * 40)))))

    def test_same_key_under_two_names_counts_once_and_there_is_a_limit(self):
        many = Pool([cred(f"k{i}", f"k{i}", priority=i) for i in range(9)])
        rt = {"api_key": "oc_" + "k8" * 24, "base_url": GO_URL, "credential_pool": many}
        cfg = {"providers": {"my-go": {"api": GO_URL, "models": ["glm-5.3"]}}}
        acc = core.detect(lambda name, *a: rt if name in ("opencode-go", "my-go") else None, cfg, NOW)
        self.assertEqual(len(acc), 9)
        self.assertEqual(len({e["name"] for e in acc}), 1)
        shown = core.shown_of(acc)
        self.assertEqual(len(shown), core.MAX_KEYS + 1)  # the first ones and, beyond the limit, the one in use
        self.assertTrue(shown[-1]["active"])
        # In use under one name and in reserve under the other: it's in use.
        a, b = cred("one", "a"), cred("two", "b")
        rts = {"opencode-go": {"api_key": a.access_token, "base_url": GO_URL, "credential_pool": Pool([a, b])}, "my-go": {"api_key": b.access_token, "base_url": GO_URL}}
        acc = core.detect(lambda name, *x: rts.get(name), cfg, NOW)
        self.assertEqual({e["key"]: e["active"] for e in acc}, {a.access_token: True, b.access_token: True})

    def test_which_providers_are_asked_for(self):
        asked = lambda cfg: [(n, u, b) for n, u, _m, b in core._candidates(cfg)]  # noqa: E731
        own = [("openrouter", "https://openrouter.ai/api/v1", True), ("opencode-go", GO_URL, True), ("opencode-zen", "https://opencode.ai/zen/v1", True),
               ("deepseek", "https://api.deepseek.com/v1", True)]
        self.assertEqual(asked({}), own)
        self.assertEqual(asked({"providers": "garbage", "custom_providers": 3}), own)
        # Turned off in config.yaml: it isn't asked for, even if it's one of Hermes's own.
        self.assertEqual(asked({"providers": {"OpenCode-Go": {"enabled": False}, "venice": {"api": "https://api.venice.ai/api/v1", "enabled": "no"}},
                                "custom_providers": [{"name": "or2", "base_url": "https://openrouter.ai/api/v1", "enabled": 0}]}), [own[0], own[2], own[3]])
        # One of Hermes's own that config.yaml redefines, and one of its names at another API.
        got = asked({"providers": {"openrouter": {"base_url": "https://openrouter.ai/api/v1", "key_env": "MINE"}, "deepseek": {"base_url": "https://openrouter.ai/api/v1"},
                                   "local": {"base_url": "http://192.168.1.50:8080/v1"}}})
        self.assertEqual(got, [("openrouter", "https://openrouter.ai/api/v1", False), *own[1:3], ("deepseek", "https://openrouter.ai/api/v1", False)])


class Shell(unittest.TestCase):
    """plugin_api.py: the reading of keys, which must not change anything in Hermes."""

    KEYS = ["oc_" + c * 48 for c in "ab"]

    def setUp(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("without fastapi (tested with the Python of Hermes)")
        outer = self
        self.stored, self.counted, self.events = [], [], []

        class CredentialPool:
            def __init__(self, entries, strategy="round_robin"):
                self._entries, self._strategy = entries, strategy

            def entries(self):
                return list(self._entries)

            def select(self, *, model=None):
                outer.counted.append(1)
                self._entries.append(self._entries.pop(0))
                self._persist()
                return self._entries[0]

            def peek(self, *, model=None):
                outer.events.append(("peek", model))
                self._persist()  # looking at it also stores what it tidies up
                return self._entries[0]

            def _persist(self):
                outer.stored.append(1)

        self.Pool = CredentialPool
        self.pool = CredentialPool([cred("one", "a"), cred("two", "b")])
        self.answer = lambda name: {"api_key": self.pool.select(model="m").runtime_api_key, "base_url": GO_URL, "provider": name, "source": "pool", "credential_pool": self.pool, "secret": "other"}
        self.views = []

        def load_runtime_pool(provider, base_url, requested=None):
            self.views.append((provider, base_url, requested))
            self.pool._persist()
            return self.pool
        mods = {n: types.ModuleType(n) for n in ("agent", "agent.credential_pool", "agent.custom_entry_pool", "hermes_cli", "hermes_cli.runtime_provider")}
        mods["agent.credential_pool"].CredentialPool = CredentialPool
        mods["agent.credential_pool"].load_pool = lambda name: self.views.append(("load_pool", name)) or self.pool
        mods["agent.custom_entry_pool"].load_runtime_pool = load_runtime_pool
        mods["hermes_cli.runtime_provider"].resolve_runtime_provider = lambda requested: self.answer(requested)
        self.mods = mods
        p = mock.patch.dict(sys.modules, mods)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(lambda: sys.modules.pop("hermes_dashboard_plugin_pedila_core", None))
        self.shell = load(DASH / "plugin_api.py", "pedila_shell_test")

    def test_it_reads_without_counting_rotating_or_storing(self):
        rt = self.shell._runtime("opencode-go", GO_URL, True)
        self.assertEqual(rt, {"api_key": self.KEYS[0], "base_url": GO_URL, "provider": "opencode-go", "source": "pool", "credential_pool": self.pool, "error": ""})
        self.assertEqual((self.counted, self.stored, self.events), ([], [], [("peek", "m")]))
        # As soon as it's done, and meanwhile in the other threads, Hermes goes on as always.
        self.pool.select()
        self.assertEqual((len(self.counted), len(self.stored)), (1, 1))
        seen = []

        def answer(name):
            t = threading.Thread(target=lambda: seen.append(self.pool.select().access_token))
            t.start()
            t.join()
            return {"api_key": "oc_x", "credential_pool": self.pool}
        self.answer = answer
        self.shell._runtime("opencode-go")
        self.assertEqual((seen, len(self.counted), len(self.stored)), ([self.KEYS[0]], 2, 2))

    def test_a_failure_leaves_everything_as_it_was(self):
        class AuthError(Exception):
            pass

        def fails(exc):
            def answer(name):
                raise exc
            return answer
        for exc, pool in ((AuthError("no key"), self.pool), (ValueError("turned off"), None), (RuntimeError("boom"), None)):
            self.answer = fails(exc)
            self.views.clear()
            rt = self.shell._runtime("venice", "https://api.venice.ai/api/v1")
            self.assertIs(rt["credential_pool"], pool)
            self.assertEqual((rt["error"], rt["api_key"]), (type(exc).__name__, None))
            # Only if there's no key to use now (all of them resting) is its pool read, as Hermes sees it.
            self.assertEqual(self.views, [("venice", "https://api.venice.ai/api/v1", "venice")] if pool else [])
            self.assertFalse(self.shell._tl.peek)
        self.assertEqual(self.stored, [])
        self.pool.select()
        self.assertEqual(len(self.counted), 1)

    def test_the_pool_when_hermes_resolves_without_it(self):
        self.answer = lambda name: {"api_key": self.KEYS[0], "base_url": GO_URL, "provider": "custom"}
        rt = self.shell._runtime("My Go", "https://opencode.ai/zen/go/v1/")
        self.assertIs(rt["credential_pool"], self.pool)
        self.assertEqual(self.views, [("custom", GO_URL, "My Go")])
        # A Hermes from before that view: only its own providers that config.yaml doesn't redefine.
        with mock.patch.dict(sys.modules, {"agent.custom_entry_pool": None}):
            self.views.clear()
            self.assertIsNone(self.shell._runtime("deepseek", "https://openrouter.ai/api/v1", False)["credential_pool"])
            self.assertEqual(self.views, [])
            self.assertIs(self.shell._runtime("opencode-go", GO_URL, True)["credential_pool"], self.pool)
            self.assertEqual(self.views, [("load_pool", "opencode-go")])
        self.assertEqual(self.stored, [])

    def test_a_name_that_hermes_takes_for_another_provider(self):
        # With a local address in config.yaml, Hermes may resolve any name as another provider: its pool isn't this one's.
        self.answer = lambda name: {"api_key": self.KEYS[0], "base_url": "http://192.168.1.50:8080/v1", "provider": "openrouter"}
        self.assertIsNone(self.shell._runtime("opencode-go", GO_URL, True)["credential_pool"])
        self.assertEqual(self.views, [])
        for same in ("opencode-go", "OpenCode-Go", "custom", "custom:opencode-go"):
            self.answer = lambda name, same=same: {"api_key": self.KEYS[0], "base_url": GO_URL, "provider": same}
            self.assertIs(self.shell._runtime("opencode-go", GO_URL, True)["credential_pool"], self.pool)

    def test_what_hermes_says_while_its_read(self):
        """A key that has been dead for a day: Hermes says that it removes it, but here nothing is stored."""
        heard = []
        handler = logging.Handler(level=0)
        handler.emit = lambda r: heard.append(r.getMessage())
        log = logging.getLogger("agent.credential_pool")
        log.addHandler(handler)
        self.addCleanup(log.removeHandler, handler)
        self.addCleanup(lambda: [log.removeFilter(f) for f in list(log.filters)])

        def peek(pool, model=None):
            log.warning("credential pool: pruning DEAD manual entry %s", "two")
            log.warning("credential pool: something else")
            return pool._entries[0]
        self.Pool.peek = peek
        self.shell._runtime("opencode-go")
        self.assertEqual(heard, ["credential pool: something else"])
        self.pool.peek()  # anywhere else it's said as always
        self.assertEqual(len(heard), 3)

    def test_other_versions_of_hermes(self):
        # peek() without arguments.
        self.Pool.peek = lambda s: s._entries[0]
        self.assertEqual(self.shell._runtime("opencode-go")["api_key"], self.KEYS[0])
        # Without a pool at all.
        self.answer = lambda name: {"api_key": "oc_only-one", "base_url": GO_URL}
        with mock.patch.dict(sys.modules, {"agent.credential_pool": None, "agent.custom_entry_pool": None}):
            self.assertEqual(self.shell._runtime("opencode-go", GO_URL, True)["api_key"], "oc_only-one")
        # Without anything that can be resolved.
        self.answer = lambda name: None
        self.assertIsNone(self.shell._runtime("opencode-go")["api_key"])

    def test_loaded_twice_in_the_same_process(self):
        again = load(DASH / "plugin_api.py", "pedila_shell_test_2")
        self.shell._runtime("opencode-go")
        guarded = self.Pool.select
        again._runtime("opencode-go")
        self.shell._runtime("opencode-go")
        self.assertIs(self.Pool.select, guarded)  # it isn't put on top of itself in each reading
        self.assertEqual((self.counted, self.stored), ([], []))

    def test_no_key_in_the_answer_the_errors_or_the_log(self):
        import httpx
        logged = []
        handler = logging.Handler(level=0)
        handler.emit = lambda r: logged.append(r.getMessage())
        root = logging.getLogger()
        level = root.level
        root.addHandler(handler)
        root.setLevel(0)

        class Client(FakeClient):
            def get(self, url, headers=None, timeout=None):
                raise RuntimeError("it broke with " + headers.get("Authorization", "nothing"))
        try:
            with mock.patch.object(httpx, "Client", Client):
                core2 = self.shell._core()
                with mock.patch.object(core2, "usage_rows", lambda since: None), mock.patch.object(core2, "_config", dict):
                    body = self.shell.cuotas(fresh=1)
        finally:
            root.removeHandler(handler)
            root.setLevel(level)
        self.assertEqual([p["ok"] for p in body["providers"] if p["kind"] == "opencode-go"], [False, False])
        text = json.dumps(body) + "\n".join(logged)
        for k in self.KEYS:
            self.assertNotIn(k, text)
        self.assertIn("RuntimeError", "\n".join(logged))

    def test_a_calculation_that_loads_but_fails(self):
        good = types.SimpleNamespace(build=lambda runtime, **info: {"plugin": "pedila", "version": "good", "shell": info["shell"], "file": info["shell_file"]})
        bad = types.SimpleNamespace(build=lambda runtime, **info: 1 / 0)
        # Without an earlier one that worked, the failure is what there is.
        self.assertRaises(ZeroDivisionError, self.shell._build, bad)
        body = self.shell._build(good)
        self.assertEqual((body["version"], body["shell"], Path(body["file"])), ("good", self.shell.SHELL_VERSION, DASH / "plugin_api.py"))
        self.assertEqual(self.shell._build(bad)["version"], "good")


class ReadStateDb(unittest.TestCase):
    def test_rows_of_session_model_usage(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            con = sqlite3.connect(tmp / "state.db")
            con.execute("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT, "
                        "billing_mode TEXT, task TEXT, api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, "
                        "cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, "
                        "actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL)")
            rows = [("s1", "glm-5.3", "opencode-go", "https://opencode.ai/zen/go/v1/", "", "", 25, 106000, 35000, 1020000, 0, 28000, 0, 0, "unknown", "none", NOW - 1000, NOW - 10),
                    ("s1", "qwen", "custom", "http://192.168.1.50:8080/v1/", "", "compression", 1, 4000, 100, 0, 0, 0, 0.5, 0, None, None, NOW - 900, NOW - 900),
                    ("s1", "/models/Qwen3-VL-8B-Q4_K_M.gguf", "custom", "http://192.168.1.50:8080/v1", "", "vision", 2, 10, 5, 0, 0, 0, 0, 0, None, None, NOW - 800, NOW - 800),
                    ("s1", "some-model", "custom", "https://api.example.com/v1", "", "", 1, 7, 7, 0, 0, 0, 0, 0, None, None, NOW - 700, NOW - 700),
                    ("s1", "gpt-oss:120b-cloud", "custom", "http://localhost:11434/v1", "", "", 1, 99000, 7, 0, 0, 0, 0, 0, None, None, NOW - 700, NOW - 700),
                    ("s1", "kimi:Cloud ", "custom", "http://localhost:11434/v1", "", "", 1, 99000, 7, 0, 0, 0, 0, 0, None, None, NOW - 700, NOW - 700),
                    ("s1", "lost", "custom", "", "", "", 1, 7, 7, 0, 0, 0, 0, 0, None, None, NOW - 700, NOW - 700),
                    ("s2", "or-model", "openrouter", "https://openrouter.ai/api/v1", "", "", 4, 30000, 1500, 0, 0, 0, 0.0001, 0.0008, None, None, NOW - 90 * 86400, NOW - 40 * 86400)]
            con.executemany("INSERT INTO session_model_usage VALUES (" + ",".join("?" * 18) + ")", rows)
            con.commit()
            con.close()
            fake = types.ModuleType("hermes_constants")
            fake.get_hermes_home = lambda: tmp
            saved = sys.modules.get("hermes_constants")
            sys.modules["hermes_constants"] = fake
            try:
                got = core.usage_rows(NOW - 32 * 86400)
            finally:
                if saved is None:
                    sys.modules.pop("hermes_constants", None)
                else:
                    sys.modules["hermes_constants"] = saved
            # What is 40 days old stays out, and so does what isn't a known API or on one's own network, or is Ollama's cloud.
            self.assertEqual([(r["kind"], r["model"]) for r in got], [("opencode-go", "glm-5.3"), ("local", "qwen"), ("local", "Qwen3-VL-8B-Q4_K_M")])
            self.assertEqual((got[0]["input"], got[0]["output"], got[0]["cache_read"], got[0]["calls"]), (106000, 35000, 1020000, 25))
            self.assertNotIn("place", got[0])
            # One's own AI isn't billed by the token, whatever Hermes reckons.
            self.assertEqual([(r["place"], r["cost"]) for r in got[1:]], [(("192.168.1.50", 8080), 0.0)] * 2)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Local(unittest.TestCase):
    """The AI on one's own network: what is, what it's called and which models were used."""

    def test_what_is_on_ones_own_network(self):
        p = core.place_of
        self.assertEqual(p("http://192.168.1.50:8080/v1/"), ("192.168.1.50", 8080))
        self.assertEqual([p(" http://10.0.0.7:8123/v1 "), p("http://10.0.0.7:8123 ")], [("10.0.0.7", 8123)] * 2)
        self.assertEqual(p("https://172.16.3.4/v1"), ("172.16.3.4", 443))
        self.assertEqual(p("http://100.101.1.2:11434"), ("100.101.1.2", 11434))  # a VPN such as Tailscale
        self.assertEqual(p("http://169.254.3.4:80"), ("169.254.3.4", 80))
        for u in ("http://localhost:11434/v1", "http://127.0.0.1:11434", "http://[::1]:11434/v1", "http://0.0.0.0:11434", "http://127.8.9.1:11434",
                  "http://ollama.localhost:11434", "http://LOCALHOST.:11434", "http://[::ffff:127.0.0.1]:11434"):
            self.assertEqual(p(u), ("localhost", 11434), u)
        self.assertEqual(p("http://[fd00::5]:8000/v1"), ("fd00::5", 8000))
        self.assertEqual(p("http://[::ffff:192.168.1.50]:8080"), ("192.168.1.50", 8080))
        self.assertEqual(p("http://llama-swap:8080/v1"), ("llama-swap", 8080))  # another container
        self.assertEqual(p("http://Server.LAN:8123"), ("server.lan", 8123))
        self.assertEqual([p("http://box.tail1234.ts.net:11434/v1"), p("https://nas.fritz.box")], [("box.tail1234.ts.net", 11434), ("nas.fritz.box", 443)])
        self.assertEqual(p("http://host.docker.internal:8080"), ("host.docker.internal", 8080))
        for u in ("https://api.venice.ai/api/v1", "https://llm.example.com/v1", "http://8.8.8.8:80", "http://100.128.0.1", "http://172.32.0.1",
                  "http://[2606:4700::1111]/v1", "http://evil.example.lan.example.com", "https://ts.net.example.com", "ftp://192.168.1.50", "192.168.1.50:8080", "", None, 7,
                  "http://", "http://[::1", "http://192.168.1.50:99999/v1", "file:///models"):
            self.assertIsNone(p(u), u)

    def test_a_models_file(self):
        f = core.file_model
        self.assertEqual(f("/models/a/Qwen3-8B-Q4_K_M.gguf"), "Qwen3-8B-Q4_K_M")
        self.assertEqual(f("C:\\models\\x.SafeTensors"), "x")
        self.assertEqual(f(" deepseek/deepseek-v4.1 "), "deepseek/deepseek-v4.1")
        self.assertEqual([f(None), f("a.gguf")], ["", "a.gguf"])

    def test_what_config_yaml_calls_it(self):
        cfg = {"providers": {"homelab": {"name": " My  server ", "api": "http://10.0.0.7:8123/v1", "key_env": "X"}, "ollama": {"base_url": "http://127.0.0.1:11434"},
                             "venice": {"name": "Venice", "api": "https://api.venice.ai/api/v1"}, "odd": 3, 7: {"url": "http://nas:9000"},
                             "same": {"name": "Second", "api": "http://10.0.0.7:8123/other"}},
               "custom_providers": [{"name": "My server", "base_url": "http://192.168.1.50:8123/v1"}, "x", {"base_url": "http://192.168.1.51:1"}]}
        self.assertEqual(core.local_names(cfg), {("10.0.0.7", 8123): "My server", ("localhost", 11434): "ollama", ("nas", 9000): "7", ("192.168.1.50", 8123): "My server"})
        self.assertEqual([core.local_names(c) for c in ({}, {"providers": [], "custom_providers": {}})], [{}, {}])

    def local(self, model, place, **k):
        return {**row(model, kind="local", **k), "place": place}

    def test_each_provider_with_its_models(self):
        home, vpn, pc, gone = ("192.168.1.50", 8123), ("10.0.0.7", 8123), ("localhost", 11434), ("fd00::5", 8000)
        cfg = {"providers": {"homelab": {"name": "Homelab", "api": "http://10.0.0.7:8123/v1"}, "ollama": {"base_url": "http://localhost:11434/v1"}},
               "custom_providers": [{"name": "HOMELAB", "base_url": "http://192.168.1.50:8123/v1"}]}
        rows = [self.local("qwen", home, inp=100, out=50, cr=900, calls=3, last=NOW - 3600),
                self.local("Qwen", vpn, inp=10, out=5, cr=90, calls=1, last=NOW - 2 * 86400),
                self.local("small", vpn, inp=20, out=0, calls=1, last=NOW - 20 * 86400),
                self.local("gemma", pc, inp=400, out=4, calls=1, last=NOW - 60),
                self.local("old", gone, inp=9, out=0, calls=1, last=NOW - 40 * 86400),
                self.local("rare", gone, inp=1, out=0, calls=1, last=NOW - 5 * 86400),
                row("paid", kind="venice", inp=10 ** 9, last=NOW)]
        got = core.local_spent(rows, cfg, NOW)
        self.assertEqual([x["name"] for x in got], ["ollama", "Homelab", "[fd00::5]:8000"])
        homelab = got[1]["spent"]
        self.assertEqual([(m["model"], m["tokens"], m["cache"], m["calls"]) for m in homelab["month"]["models"]], [("qwen", 165, 990, 4), ("small", 20, 0, 1)])
        self.assertEqual([homelab[s]["tokens"] for s in ("day", "week", "month")], [150, 165, 185])
        self.assertEqual([homelab[s]["cost"] for s in ("day", "week", "month")], [0.0, 0.0, 0.0])
        self.assertEqual([m["model"] for m in got[2]["spent"]["month"]["models"]], ["rare"])
        # Without names, each address by itself; what is older than 30 days doesn't count.
        self.assertEqual([x["name"] for x in core.local_spent(rows[:3], {}, NOW)], ["192.168.1.50:8123", "10.0.0.7:8123"])
        self.assertEqual(core.local_spent([rows[4], rows[6]], cfg, NOW), [])
        many = [self.local("m", ("10.0.0.%d" % i, 80), inp=100 - i, last=NOW) for i in range(core.MAX_LOCAL + 2)]
        self.assertEqual([x["name"] for x in core.local_spent(many, {}, NOW)], ["10.0.0.%d:80" % i for i in range(core.MAX_LOCAL)])


class LocalInTheAnswer(Build):
    """What build() says of the local AI (it inherits the make-believe Hermes of Build, not its tests)."""

    def answer(self, rows, cfg=None):
        core.usage_rows = lambda since: rows
        core._config = lambda: cfg or {}
        return core.build(runtime=lambda *a: None)

    def test_local_goes_apart_from_the_providers(self):
        place = ("192.168.1.50", 8123)
        mine = {**row("qwen", kind="local", inp=100, out=50, last=NOW - 60), "place": place}
        body = self.answer([REAL, mine], {"providers": {"homelab": {"name": "Homelab", "api": "http://192.168.1.50:8123/v1"}}})
        self.assertEqual(body["providers"], [])
        [x] = body["local"]
        self.assertEqual((x["name"], x["spent"]["day"]["tokens"], x["spent"]["day"]["models"][0]["model"]), ("Homelab", 150, "qwen"))
        self.assertEqual(FakeClient.calls, [])  # nothing is asked of the local AI
        self.assertNotIn("192.168.1.50", json.dumps(body))
        # With a paid API too: each one its own, and the API's tokens don't change.
        key = "oc_" + "k" * 48
        core.usage_rows = lambda since: [REAL, mine]
        both = core.build(runtime=lambda name, *a: {"api_key": key} if name == "opencode-go" else None)
        self.assertEqual([p["spent"]["day"]["tokens"] for p in both["providers"]], [200000])
        self.assertEqual(len(both["local"]), 1)

    def test_without_records_or_with_bad_ones(self):
        self.assertEqual(self.answer([])["local"], [])
        self.assertIsNone(self.answer(None)["local"])
        # Something odd in the local AI's rows doesn't take the quotas down.
        self.assertIsNone(self.answer([{**row("qwen", kind="local", inp=1, last=NOW), "place": None}])["local"])


# Only its own tests: Build's would be repeated.
for _name in [n for n in dir(Build) if n.startswith("test_")]:
    setattr(LocalInTheAnswer, _name, None)


class Reload(unittest.TestCase):
    """plugin_api.py loads quotas_core.py again when it changes, without restarting Hermes."""

    def test_reload_and_broken_version(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("without fastapi (tested with the Python of Hermes)")
        tmp = Path(tempfile.mkdtemp())
        try:
            shutil.copy(DASH / "plugin_api.py", tmp / "plugin_api.py")
            src = (DASH / "quotas_core.py").read_text(encoding="utf-8")
            (tmp / "quotas_core.py").write_text(src, encoding="utf-8")
            shell = load(tmp / "plugin_api.py", "pedila_shell_test")
            self.assertEqual(shell.version()["version"], core.PLUGIN_VERSION)
            first = shell._core()
            # A new version on disk (another size and another date): it loads by itself.
            (tmp / "quotas_core.py").write_text(src.replace(f'PLUGIN_VERSION = "{core.PLUGIN_VERSION}"', 'PLUGIN_VERSION = "9.9.9"'), encoding="utf-8")
            os.utime(tmp / "quotas_core.py", (time.time() + 5, time.time() + 5))
            self.assertEqual(shell.version()["version"], "9.9.9")
            self.assertIsNot(shell._core(), first)
            # A broken version doesn't bring the route down: the previous one goes on.
            (tmp / "quotas_core.py").write_text("esto no es python (", encoding="utf-8")
            os.utime(tmp / "quotas_core.py", (time.time() + 10, time.time() + 10))
            self.assertEqual(shell.version()["version"], "9.9.9")
            self.assertEqual(shell.version()["shell"], shell.SHELL_VERSION)
            # /cuotas's cache doesn't serve the body of a calculation that is no longer there.
            seen = []
            stub = types.SimpleNamespace(build=lambda runtime, **info: seen.append(1) or {"plugin": "pedila", "version": "x", "providers": []})
            shell._core_state.update(mod=stub, sig=shell._core_state["sig"])
            shell._cache.update(at=time.time(), body={"plugin": "pedila", "version": "viejo", "providers": []}, core=object())
            self.assertEqual(shell.cuotas()["version"], "x")
            self.assertEqual(shell.cuotas()["version"], "x")
            self.assertEqual(len(seen), 1)
        finally:
            sys.modules.pop("hermes_dashboard_plugin_pedila_core", None)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=1)
