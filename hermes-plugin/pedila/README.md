# "pedila" plugin for Hermes

The [Pedila](https://github.com/ElKiro1311/pedila) app installs it from its panel ("Quotas → Turn on quotas").
It serves `GET /api/plugins/pedila/cuotas` on Hermes's web page: what's left of each paid API connected to that
Hermes. (The route keeps its Spanish name, "quotas": the installed versions of the app ask for it.)

| API | What it gives |
|---|---|
| OpenRouter | credit balance; the key's limit, spending (day, week, month) and reset |
| Venice | USD, DIEM and included-credit balances; plan; next DIEM reset; limits per model |
| OpenCode Go | % used of the 5-hour, weekly and monthly windows, and when they reset |
| OpenCode Zen | OpenCode doesn't publish the balance: only what Hermes has spent with it |

Also, for each one, what Hermes spent in 24 h, 7 and 30 days (tokens, calls and estimated cost), taken from its
own records.

Only the APIs that have a key show up. The keys don't leave Hermes: the plugin uses them to ask the provider and
returns numbers. It adds no tools, hooks or prompt text.

By hand: `hermes plugins install ElKiro1311/pedila/hermes-plugin/pedila --enable`.
