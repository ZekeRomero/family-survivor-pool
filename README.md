# Family NFL Survivor Pool

A dead-simple survivor pool website. Open the link, tap your name, enter your PIN, tap a team. That's it.

## How it's built

- **`index.html`** — the whole website (one file, no build step). Hosted on GitHub Pages.
- **`supabase/functions/survivor/`** — the backend (a Supabase Edge Function). Stores players, picks and scores; pulls results from ESPN automatically; enforces the rules (one team once, picks lock at kickoff, eliminations).
- **`supabase/migrations/`** — database tables (`survivor_settings`, `survivor_players`, `survivor_picks`, `survivor_games`, `survivor_log`).

Picks and scores live in the database, so nobody has to re-send anything. Scores refresh from ESPN whenever someone opens the site during games, and eliminations are computed from results on the fly.

## Commissioner cheat sheet

Everything you'd ever need is on the site itself: scroll to the bottom → **Commissioner** → enter the admin PIN.

- **Add players** — type names separated by commas. Each person picks their own 4-digit PIN the first time they sign in.
- **Someone forgot their PIN** — hit **Reset** next to their name; they choose a new one next time.
- **Someone texted you a pick instead of using the site** — use the "Wk N pick" dropdown next to their name. This bypasses the kickoff lock, so it's on you to be fair.
- **Track money** — tick the **Paid** box as buy-ins come in. The pot shown on the site is buy-in × number of players.
- **Scores look wrong / stuck** — "Pull scores from ESPN now", or enter a final score by hand.
- **Weeks 16–18 kickoff times** — the NFL sets those in December. Hit "Re-pull full schedule from ESPN" once around then.
- **Rules** — tie = loss, missed pick = loss, 1 life, and the "everyone loses → nobody's out" reset are all toggles in settings. Changing a rule recomputes standings instantly.

## Updating the site

Edit `index.html` and push to `main`; GitHub Pages redeploys in about a minute.

To change the backend, edit `supabase/functions/survivor/index.ts` and redeploy the function (Supabase dashboard → Edge Functions, or `supabase functions deploy survivor --no-verify-jwt`).
