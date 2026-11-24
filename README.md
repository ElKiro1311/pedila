<p align="center"><img src="docs/banner.jpg" alt="A messenger with winged golden sandals runs across the sky with a letter, drawn in ink"></p>

<p align="center"><img src="docs/icon.png" width="112" alt="Pedila's icon: a winged sandal at full speed, in ink with a touch of gold"></p>

<h1 align="center">Pedila, the messenger</h1>

<p align="center"><b>A simple window for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>: the one on your PC and the one on your server. In English and Spanish.</b><br>
<i>Unofficial client. Pedila is not made or endorsed by Nous Research.</i></p>

<p align="center"><b>English</b> · <a href="README.es.md">Español</a></p>

## The name

**Pedila** comes from the Greek **πέδιλα** (*pédila*), Hermes's winged sandals. The Romans called them *talaria*. With them Hermes, the messenger of the gods, carried messages from one world to another. Homer tells it twice with the same lines, when Zeus sends him on an errand (*Odyssey* 5.44–46; *Iliad* 24.340–342):

> αὐτίκ᾽ ἔπειθ᾽ ὑπὸ ποσσὶν ἐδήσατο καλὰ πέδιλα,
> ἀμβρόσια χρύσεια, τά μιν φέρον ἠμὲν ἐφ᾽ ὑγρὴν
> ἠδ᾽ ἐπ᾽ ἀπείρονα γαῖαν ἅμα πνοιῇς ἀνέμοιο.
>
> "At once he tied on his feet the beautiful sandals, immortal, golden, that carried him over the sea and over the boundless earth as fast as the breaths of the wind."

That is what this app wants to be: the sandals that carry your messages to Hermes, whether it is on your PC or on your server.

**Pedila, the messenger.** In the app the sandals come to life: Pedila is a girl who puts them on and runs back and forth with your messages. She is the app's pet. She waits calmly with her letter, runs while Hermes works, reads her scroll while Hermes uses tools, offers you the letter when Hermes needs your permission, jumps for joy when it finishes and gets sad if something fails.

<p align="center"><img src="docs/pet/still.png" height="150" alt="Pedila, standing with her letter"> <img src="docs/pet/run-1.png" height="130" alt="Pedila running with the letter"> <img src="docs/pet/read.png" height="150" alt="Pedila reading a scroll"> <img src="docs/pet/jump.png" height="140" alt="Pedila jumping for joy"></p>

**The icon, the banner and Pedila** are drawn in manga-style ink, with the gold of the sandals as the only color: on the icon, a winged sandal at full speed; on the banner, Pedila crossing the sky with a letter. Hermes itself made them with a local image model (Qwen-Image), and then they were cropped for the app ([`docs/icon.png`](docs/icon.png), [`docs/banner.jpg`](docs/banner.jpg), [`docs/pet/`](docs/pet)). Pedila's poses were made on a green background; `scripts/make-pet.js` removes the green and builds the animated sheet.

## What it does

- **Your Hermes in one window:**
  - **This PC** uses the same Hermes as Hermes Desktop, with the same chats. It only shows up if Hermes is installed on the PC.
  - **Server** is a Hermes on another machine (`hermes dashboard` with a username and password). It only shows up once you set its address in Settings → Server.
  - With a single Hermes there is no switch: that one is used.
- **Your APIs' quotas:** if your Hermes uses OpenRouter, Venice, OpenCode, DeepSeek or Openference, the panel shows what is left of each one:
  - **OpenRouter:** credit balance; the key's limit, when it resets and what was spent today, this week and this month.
  - **Venice:** USD balance, plan credits and DIEM; when the DIEM resets; limits per model.
  - **OpenCode Go:** % used of the 5-hour, weekly and monthly windows (with a decimal when it can be worked out), and when they reset. OpenCode doesn't publish **OpenCode Zen**'s balance.
  - **DeepSeek:** the balance left, and a notice when it isn't enough to use the API.
  - **Openference:** credit balance and plan; with a paid plan, % used of its windows and when they reset; which models are free and until when.
  - If you gave Hermes **several keys for the same API** (`hermes auth add`), each one is a quota of its own, with its label: which one is in use, which ones are in reserve and which ones are resting until their limit resets.
  - For each one, what Hermes has spent in 24 hours, 7 days and 30 days.
  - A small Pedila plugin reads it inside Hermes ([hermes-plugin/pedila](hermes-plugin/pedila)): your keys never leave Hermes, only numbers come out. It is installed with the panel's "Turn on quotas" button, without restarting Hermes, and updated from there too (going from a version before 1.2.0, Hermes has to restart once). APIs you don't have don't show up.
- **Model and effort of a chat that has already started:** they can be changed with the chat going (Hermes changes them with its `/model` and `/reasoning` commands), with reasoning levels up to "maximum".
- **Tools as in Claude Code:** consecutive ones go together on one line that opens ("Ran 2 commands, read screenshot.png · +12 −3 · 1 failed"). Inside, each one with its title, what it was given (the command, the code or the change in green and red), what it returned and, if it failed, in red. The images it looks at or makes come out right there.
- **Images:** the ones you attach show in your message and in the writing box; a click opens them big.
- **Chats:**
  - list and search, by title and in their contents;
  - pin, rename, archive (with its view of archived ones) and delete, with confirmation;
  - export to Markdown.
- **Chat:**
  - live answer, collapsible reasoning and tools in progress;
  - a stop button, and permission and question cards;
  - copy, duration and tokens per second;
  - a chat memory bar that warns at 80%.
- **While writing:**
  - images (attach, paste or drag);
  - "Read only";
  - reasoning level;
  - a model picker that marks the ones in the cloud with ☁;
  - quick phrases with "/".
- **Notifications:** Windows notifications, a sound of its own when it finishes, a dot on the taskbar icon, and flashing if Windows notifications are off.
- **More:**
  - a panel on the right, like Claude Panel's, with what Hermes is doing, the open chat's memory and tokens, today's and the last 7 days' usage, the models that have spent the most tokens (summarizing memory, writing titles or looking at images count too) and the connections (it folds with ◨);
  - the time of Hermes's last answer and how long ago it was (or, if it's working, since when), even if Hermes Desktop started the task;
  - "Tasks", as in Claude Code: Hermes's plan (its task list, with subtasks) and how much is done, what it's doing now, the running tools and its subagents;
  - the chat list and the panel get wider or narrower by dragging their line (or with the arrow keys; double-click: the default width);
  - "Your usage", worked out only from your data;
  - system tray and **Ctrl+Alt+H** shortcut; "Start with Windows" in Settings → Window and in the tray icon's menu;
  - updates from GitHub Releases, which install themselves when you aren't using Pedila (10 minutes without touching it, nothing typed and not sent, and Hermes not working) and open it again the way it was, without taking the focus;
  - **Hermes versions:** Pedila checks every 6 hours whether there's a new one (the "Connections" card and Settings → About say so). This PC's Hermes, if it's an installation Hermes knows how to update (the official installer's), updates itself with its own `hermes update` command after 10 minutes unused: no chats working or active. A Hermes in Docker (a server) can't update itself: Pedila gives notice, and it's updated from its server;
  - Pedila, the pet, who reacts to what Hermes does; if you prefer another one, there are more than 5,000 to choose from on [Petdex](https://petdex.dev).
- **Your own layout** (Settings → Layout): sort and hide the tabs (This PC/Server), choose which panel cards show and in what order, hide the buttons you don't use and put the chat list on the right if you like. The tabs and the cards can also be dragged right where they are.
- **Quotas with the same design for all:** every provider (OpenRouter, Venice, OpenCode, DeepSeek and Openference) looks the same: what's left, big, and below it each measure with its bar and when it resets. For balances without a total (Venice, DeepSeek, and Openference if no credits were bought), the bar counts what was spent since the highest balance Pedila has seen.
- **Themes:** six, each in dark and light mode, with a preview in Settings → Appearance:
  - **Messenger** (the default): ink, grays and gold, like Pedila;
  - **Classic**: cool grays and violet, from the first versions;
  - **Aegean**: night blue and gold;
  - **Amphora**: black and terracotta;
  - **Olive**: calm greens;
  - **Claude**: slate, ivory and terracotta, like Claude.
  - The accent color can be the theme's or one of your choice.
- **In English and Spanish:** the app follows the system's language, or the one you choose in Settings → Appearance.

## Installing

1. Download `Pedila-Setup.exe` from [Releases](../../releases).
2. Open it. It installs for your user, without asking for administrator rights.
   - The installer isn't signed, so Windows may say "Windows protected your PC". Click **More info** and then **Run anyway**.
3. **This PC** only works if you have Hermes Agent installed (with Hermes Desktop or the official installer).
4. **Server**: put the address of its `hermes dashboard` in Settings → Server and sign in with its username and password. The password isn't stored; the session is, encrypted with Windows (DPAPI).

**Requirements:** Windows 10 or 11 and Hermes Agent 0.22 or 0.23 (tested with 0.22.5 on the server and 0.23.0 on the PC). Pedila speaks the internal protocol Hermes Desktop uses, so a new Hermes version may need a Pedila update.

## How it talks to Hermes (the same way as Hermes Desktop)

| | This PC | Server |
|---|---|---|
| Address | `hermes gateway ensure --json` (it starts the gateway if needed) | The one in Settings → Server; the first is tried and, if it doesn't answer, the alternative one |
| Signing in | No password. Single-use tickets come out of the gateway's private pipe, asked for with Hermes's Python | `POST /auth/password-login`; the `hermes_session_*` cookies are stored encrypted |
| Live chat | `/api/ws`, with the ticket as a subprotocol next to `hermes-gateway-v1` | `/api/ws?ticket=` (from `POST /api/auth/ws-ticket`) |
| List, search and changes | REST `/api/sessions…`, with a `native-http` ticket per request | REST with the cookies |
| Tokens per model | `GET /api/analytics/usage?days=365` (what Hermes Desktop's usage page shows); without that route, the sum of the chat list | Same, with the cookies |

Changes to a chat (rename, pin, archive, delete) use Hermes's protected edits: first `/mutation-snapshot` and then `request_id` + `expected_revision` + `expected_generation`. Both gateway protocols are spoken, the new one (`session_authority`) and the classic one.

## Development

```
npm install                # if the Electron binary is missing: node node_modules/electron/install.js
npm run assets             # icons from docs/icon.png, Pedila's sheet from docs/pet, and a copy of marked/DOMPurify
npm test                   # tests of the pure parts
npm start                  # opens the app
npm run dist               # installer in dist/ (NSIS, per user)
```

Only in development:
- `PEDILA_CDP=9334` opens a debugging port. `node scripts/cdp.mjs 9334 eval "<js>"` reads or drives the window.
- `PEDILA_DEMO=1` uses made-up data.
- `PEDILA_DATA=<folder>` uses another data folder.
- `PEDILA_DEBUG=1` also writes the log to the console.

**The texts.** The code has every text in English, `tr('…')`, and [`src/shell/es.json`](src/shell/es.json) has the Spanish ones; `npm test` checks that none is missing or left over. The page (`index.html`) is written in English and translated when it opens.

**Publishing a version:** upload to the Release `Pedila-Setup.exe` and a `version.json` with `{"version": "0.16.0-beta", "sha256": "<the installer's sha256>", "notes": "…", "notas": "…"}` (the notes in English and in Spanish; versions before 0.16 only read `notas`). The version must be exactly the one in `package.json`, with its -alpha/-beta suffix if it has one: otherwise the installed app would still see a "new" version after updating. The Release goes as a normal one, not as a pre-release: the app looks at GitHub's latest (`releases/latest`), which skips pre-releases. The app compares the version (as in Semantic Versioning), downloads the installer, checks the SHA-256 and updates silently.

## Credits and license

- Pedila's code: [MIT](LICENSE).
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) is by Nous Research (MIT). Pedila doesn't include its code; it uses the same way in as its desktop app.
- [Electron](https://www.electronjs.org/) (MIT), [marked](https://marked.js.org/) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0).
- **Pedila**, the pet, belongs to the project (MIT, like the code) and travels in the installer.
- **The other pets** belong to their authors on [Petdex](https://petdex.dev), and the app downloads them from there when you choose them; they aren't in the repository or in the installer.
- The Greek text is by Homer (public domain). The translation is the project's.
