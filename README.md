# SIMKL for Salvage

A [Salvage](https://github.com/aliyss/salvage-web) plugin that adds a
**Watchlist** canvas to your account. Your shows, anime and films are read from
SIMKL by the **Salvage Helper** on your own computer, and nothing about them
reaches the server: no poster, no title, no score, no history. A card is built
again on every visit, and if the plugin cannot be reached you still see your
notes.

## What it adds

- A canvas, which works like any other: a URL, an entry in the canvas switcher,
  and a page of its own. You name it and choose its route in the plugin's
  settings.
- One card per item in the lists you picked, for shows, anime or films.
- The account's own score on the card, and the bucket it sits in — a canvas of
  several lists dims everything that is not being watched, the way a finished
  task note is dimmed.
- A note for any card. Notes are ordinary Salvage notes — Markdown, tags,
  mentions, Trash — stored on the canvas the plugin added.

The canvas disappears from your account when the plugin is not connected. It is
hidden rather than deleted, so reinstalling the plugin brings it back with every
note still on it.

## Requirements

- Salvage with the desktop helper paired
- A SIMKL app, created once at
  [simkl.com/settings/developer](https://simkl.com/settings/developer/)

## Signing in

The sign-in happens on this computer, and the token never exists on your
account:

1. Create the app on SIMKL. It gets a client id.
2. Register the redirect URL the plugin's sign-in page shows. SIMKL matches it
   exactly, and a loopback address is matched without its port, so
   `http://127.0.0.1/v1/plugins/salvage-plugin-simkl/oauth/callback` covers any
   port the helper runs on.
3. Paste the client id into the plugin and press **Sign in with SIMKL**.

The helper opens SIMKL's consent page with a PKCE challenge and a state it
generated, receives the code at its own callback, and exchanges it at
`api.simkl.com` — the verifier and the token stay in the helper's process and
its secrets file. SIMKL's access tokens last a week, so the refresh token it
issues is kept beside the token and a new access token is fetched silently when
one runs out. If SIMKL ever refuses both, the settings page says so and the
sign-in is repeated.

Older helper versions cannot finish the exchange. There, the plugin still works
with a token pasted by hand: finish SIMKL's pin flow yourself
(`https://api.simkl.com/oauth/pin?client_id=…`, enter the code at
`https://simkl.com/pin/`, then `https://api.simkl.com/oauth/pin/USER_CODE?client_id=…`)
and paste the access token into the plugin's settings.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| SIMKL client id | — | From the app you created; kept on this computer |
| SIMKL access token | — | Written by the helper when you approve this computer |
| SIMKL refresh token | — | Written by the helper too, so the canvas keeps working |
| Shows, anime or films | TV shows | Which library the canvas shows |
| Which of my lists | watching, plan to watch, completed | Only these buckets are drawn; none ticked means all |
| How many entries | 30 | Between 5 and 50 |

| Canvas name | Watchlist | The name the canvas starts with |
| Canvas route | watchlist | Its URL segment, under your own space |

## How the sync works

SIMKL's API asks apps to sync in two phases, and this plugin follows it to the
letter — the alternative is a client id that gets suspended for downloading the
whole library on every visit.

1. **The gate.** Every visit asks `GET /sync/activities`, a tiny answer of
   last-modified timestamps. If this library's timestamp is the one the last
   sync was taken at, the copy on this computer is current and nothing else is
   requested.
2. **The delta.** When it moved, the library is read with
   `GET /sync/all-items/{type}?date_from=<the timestamp that library was pulled
   at>`, which returns only the items that changed — not the library. The delta
   is merged into the copy here.
3. **The deletions.** `date_from` never reports a deleted item, so when the
   `removed_from_list` timestamp moves the plugin reads the library's ids only
   (`extended=simkl_ids_only`) and compares. An item the account deleted stops
   being drawn but is remembered, so a note written about it keeps its poster.
4. **The first sync.** With nothing stored, the whole library of the one type
   this canvas shows is read once. The snapshot is saved only after the pull
   succeeded, and read before it, so a change made mid-sync is never skipped.

Only the canvas's own library is ever pulled: SIMKL asks single-type apps to
call one type, and each library keeps its own snapshot so one cannot advance
past a change another never read.

The store lives in `SALVAGE_PLUGIN_DATA/sync.json`, beside the covers filed in
`media/`. A page of cards costs no request to SIMKL at all: the covers are
already on disk and the helper serves them.

A canvas asks once per page, so the gate's answer is trusted for two minutes at
a time; the canvas itself refreshes every 15.

## What a card knows

SIMKL's sync endpoint answers watch state, not catalog metadata: a title, a
poster, a year, the account's score and the bucket. It does not send genres, a
synopsis or the site's average score, and the API rules do not allow asking for
each item's detail page to fill them in. Cards are drawn from what the sync does
report, and the date view places each one at the moment the account last
touched it.

The colour view has nothing to sort by for the same reason — a sync reports no
cover colour — so it reads in the date view's order.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build     # writes dist/plugin.js
```

The plugin talks to the helper over stdin/stdout with the small SDK in
`src/sdk.ts`; `SALVAGE_PLUGIN_DATA` is the folder it may use for its own store.

## Publishing

`.github/workflows/release.yml` builds, typechecks and tests every push to
`master`, then publishes `manifest.json` and `dist/plugin.js` on a release
tagged `v<version>` from the manifest. Bump the manifest version to cut a new
release; the helper installs a plugin from a repository that publishes both
assets.

## Data

This product uses the SIMKL API but is not endorsed or certified by SIMKL. The
plugin is not affiliated with SIMKL.
