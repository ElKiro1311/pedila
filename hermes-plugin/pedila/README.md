# "pedila" plugin for Hermes

The [Pedila](https://github.com/ElKiro1311/pedila) app installs it from its panel ("Quotas → Turn on quotas").
It serves `GET /api/plugins/pedila/cuotas` on Hermes's web page: what's left of each paid API connected to that
Hermes. (The route keeps its Spanish name, "quotas": the installed versions of the app ask for it.)

| API | What it gives |
|---|---|
| OpenRouter | credit balance; the key's limit, spending (day, week, month) and reset |
| Venice | USD, DIEM and included-credit balances; plan; next DIEM reset; limits per model |
| OpenCode Go | % used of the 5-hour, weekly and monthly windows, and when they reset; with decimals if they can be worked out (see below) |
| OpenCode Zen | OpenCode doesn't publish the balance: only what Hermes has spent with it |
| DeepSeek | balance (granted and topped up) and whether it's enough to use the API |
| Openference | credit balance and plan; with a paid plan, % used of its windows and when they reset; the free models and until when they're free |

A provider may have several keys (`hermes auth add`, Hermes's credential pool): each one comes out as a quota of its
own, with which one Hermes uses now and which ones are resting until their limit resets. They're called after
their label (`--label`), except the first one and the ones Hermes named by itself.

OpenCode Go gives its usage in whole numbers rounded down (0% until it gets to 1%). The plugin works the
decimals out from the tokens Hermes records for each model and the price and the monthly limit of each model
that OpenCode publishes (`/zen/go/v1/models`, without a key): the 5-hour window is 20% of the month and the
week 50%. They're only given when they agree with OpenCode's whole number (they don't if the account is also used
from somewhere else, or if OpenCode changes its limits). Hermes doesn't record which key each thing was spent with:
with several, they're only worked out in the 5-hour window of one while the others are idle, and what Hermes
spent is said once, for all of them.

Openference doesn't document an address for its balance: the plugin asks the one its own web page uses
(`/api/user/me`), which takes the API key too and might change without notice. That answer also has personal data:
only the numbers and the plan's name are taken from it.

`plugin_api.py` is the fixed part (the one Hermes loads once); the calculation is in `quotas_core.py`, which
is loaded again by itself when it changes: a new version of the plugin takes effect without restarting Hermes
(from 1.2.0 on; going from 1.0.x takes one restart).

Also, for each one, what Hermes spent in 24 h, 7 and 30 days, in all and model by model (tokens, what was read from
the cache, calls and estimated cost), taken from its own records. Hermes records the first and the last call of each
chat and model: a chat longer than that time counts in proportion, so it's approximate.

Only the APIs that have a key show up. The keys don't leave Hermes: the plugin uses them to ask the provider and
returns numbers. A key is only sent, over https, to the address Hermes uses it at: if a provider goes through a proxy
or a mirror, it isn't asked about. Reading them changes nothing in Hermes (it doesn't count or rotate them, and it
stores nothing). It adds no tools, hooks or prompt text.

By hand: `hermes plugins install ElKiro1311/pedila/hermes-plugin/pedila --enable`.
