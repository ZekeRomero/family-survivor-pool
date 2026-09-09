// Family NFL Survivor Pool — single edge function: serves the page + JSON API.
// Auth is PIN-based (family pool). All DB access uses the service role; RLS blocks everything else.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SEASON = 2026;
const TEAMS: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WSH: "Washington Commanders",
};
const ALIASES: Record<string, string> = { WAS: "WSH", JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
const normTeam = (s: string | null | undefined) => {
  if (!s) return null;
  const t = ALIASES[s.toUpperCase()] || s.toUpperCase();
  return TEAMS[t] ? t : null;
};

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

async function sha(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const pinOk = (pin: unknown) => typeof pin === "string" && /^\d{4}$/.test(pin);
const adminPinOk = (pin: unknown) => typeof pin === "string" && /^\d{4,8}$/.test(pin);
// Player PINs are global (a PIN alone identifies you), so the hash is not tied to the player id.
const hashPlayerPin = (pin: string) => sha(`survivor-pin:${pin}`);
const hashAdminPin = (pin: string) => sha(`admin:${pin}`);

type Game = { week: number; away: string; home: string; kickoff: string; away_score: number; home_score: number; status: string; detail: string; updated_at: string };
type Player = { id: number; name: string; pin_hash: string | null; paid: boolean };
type Pick = { player_id: number; week: number; team: string; updated_at: string };

async function loadAll() {
  const [s, p, k, g] = await Promise.all([
    db.from("survivor_settings").select("*").eq("id", 1).single(),
    db.from("survivor_players").select("*").order("id"),
    db.from("survivor_picks").select("*"),
    db.from("survivor_games").select("*").order("kickoff"),
  ]);
  if (s.error || p.error || k.error || g.error) throw new Error((s.error || p.error || k.error || g.error)!.message);
  return { settings: s.data, players: p.data as Player[], picks: k.data as Pick[], games: g.data as Game[] };
}

// ---- pool logic (port of survivor.py compute/current_week) ----
function weekComplete(games: Game[], w: number) {
  const gs = games.filter((g) => g.week === w);
  return gs.length > 0 && gs.every((g) => g.status === "final");
}
function currentWeek(games: Game[], now: Date) {
  let byTime = 18;
  for (let w = 1; w <= 18; w++) {
    const gs = games.filter((g) => g.week === w);
    if (!gs.length) continue;
    const last = Math.max(...gs.map((g) => Date.parse(g.kickoff)));
    if (now.getTime() < last + 4 * 3600e3) { byTime = w; break; }
  }
  let byGrade = 1;
  for (let w = 1; w <= 18; w++) if (weekComplete(games, w)) byGrade = w + 1;
  return Math.min(18, Math.max(byTime, byGrade));
}
function compute(settings: any, players: Player[], picks: Pick[], games: Game[], now: Date = new Date()) {
  const rules = settings.rules || {};
  const tieIsLoss = (rules.tie || "loss") === "loss";
  const missedIsLoss = (rules.missed_pick || "loss") === "loss";
  const allOutReset = rules.all_out_reset !== false;
  const strikesAllowed = Number(rules.strikes || 1);
  const st: Record<number, { strikes: number; eliminated_week: number | null; weeks: Record<string, any> }> = {};
  for (const p of players) st[p.id] = { strikes: 0, eliminated_week: null, weeks: {} };
  const pickOf = (pid: number, w: number) => picks.find((k) => k.player_id === pid && k.week === w)?.team || null;
  const notes: Record<string, string> = {};
  for (let w = 1; w <= 18; w++) {
    const gs = games.filter((g) => g.week === w);
    const anyResult = gs.some((g) => g.status !== "scheduled");
    const complete = weekComplete(games, w);
    // Once the last game of the week (MNF) has kicked off, nobody can pick anymore -> no pick = missed.
    const allKickedOff = gs.length > 0 && gs.every((g) => Date.parse(g.kickoff) <= now.getTime());
    if (!anyResult && !complete && !allKickedOff) continue;
    const outcome: Record<string, string> = {};
    for (const g of gs) {
      if (g.status !== "final") continue;
      if (g.away_score === g.home_score) { outcome[g.away] = outcome[g.home] = "T"; }
      else { outcome[g.away] = g.away_score > g.home_score ? "W" : "L"; outcome[g.home] = g.home_score > g.away_score ? "W" : "L"; }
    }
    const losers: number[] = [];
    for (const p of players) {
      const s = st[p.id];
      if (s.eliminated_week !== null) continue;
      const pick = pickOf(p.id, w);
      if (!pick) {
        if ((complete || allKickedOff) && missedIsLoss) { s.weeks[w] = { pick: null, result: "MISS" }; losers.push(p.id); }
        else s.weeks[w] = { pick: null, result: null };
        continue;
      }
      const r = outcome[pick] || null;
      s.weeks[w] = { pick, result: r };
      if (r === "L" || (r === "T" && tieIsLoss)) losers.push(p.id);
    }
    const alive = players.filter((p) => st[p.id].eliminated_week === null);
    if (losers.length && allOutReset && complete && losers.length === alive.length && alive.length > 1) {
      notes[w] = `Everyone left lost in Week ${w} — by the reset rule, nobody was eliminated.`;
      for (const id of losers) st[id].weeks[w].saved = true;
      continue;
    }
    for (const id of losers) {
      st[id].strikes += 1;
      if (st[id].strikes >= strikesAllowed) st[id].eliminated_week = w;
    }
  }
  return { st, notes };
}

// ---- ESPN ----
async function fetchEspnWeek(week: number) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${SEASON}`;
  const r = await fetch(url, { headers: { "User-Agent": "family-survivor-pool/2.0" } });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const data = await r.json();
  const out: Partial<Game>[] = [];
  for (const ev of data.events || []) {
    const comp = ev.competitions[0];
    const home = comp.competitors.find((c: any) => c.homeAway === "home");
    const away = comp.competitors.find((c: any) => c.homeAway === "away");
    const state = comp.status?.type?.state; // pre | in | post
    const a = normTeam(away?.team?.abbreviation), h = normTeam(home?.team?.abbreviation);
    if (!a || !h) continue;
    out.push({
      week, away: a, home: h, kickoff: new Date(ev.date).toISOString(),
      away_score: parseInt(away.score || "0") || 0, home_score: parseInt(home.score || "0") || 0,
      status: state === "post" ? "final" : state === "in" ? "live" : "scheduled",
      detail: comp.status?.type?.shortDetail || "",
    });
  }
  return out;
}
async function refreshWeek(week: number) {
  const gs = await fetchEspnWeek(week);
  if (!gs.length) return 0;
  const rows = gs.map((g) => ({ ...g, updated_at: new Date().toISOString() }));
  const { error } = await db.from("survivor_games").upsert(rows, { onConflict: "week,away,home" });
  if (error) throw new Error(error.message);
  return rows.length;
}
// Refresh scores lazily: any week with a game that has kicked off, isn't final, and hasn't been checked in 5 min.
async function autoRefresh(games: Game[], now: Date) {
  const stale = new Set<number>();
  for (const g of games) {
    if (g.status === "final") continue;
    const kicked = Date.parse(g.kickoff) <= now.getTime();
    const checked = Date.parse(g.updated_at);
    if (kicked && now.getTime() - checked > 5 * 60e3) stale.add(g.week);
  }
  if (!stale.size) return false;
  // Stamp first so concurrent requests don't all hit ESPN.
  await db.from("survivor_games").update({ updated_at: now.toISOString() }).in("week", [...stale]).neq("status", "final");
  for (const w of stale) { try { await refreshWeek(w); } catch (e) { console.error("espn", w, e); } }
  return true;
}

// ---- state for the page ----
async function buildState(me: Player | null) {
  const now = new Date();
  let all = await loadAll();
  if (await autoRefresh(all.games, now)) all = await loadAll();
  const { settings, players, picks, games } = all;
  const cw = currentWeek(games, now);
  const { st, notes } = compute(settings, players, picks, games, now);
  const kickoffOf = (w: number, t: string) => games.find((g) => g.week === w && (g.away === t || g.home === t))?.kickoff;
  const schedule: Record<string, [string, string, string][]> = {};
  const results: Record<string, any> = {};
  for (let w = 1; w <= 18; w++) {
    const gs = games.filter((g) => g.week === w);
    if (!gs.length) continue;
    schedule[w] = gs.map((g) => [g.kickoff, g.away, g.home]);
    if (gs.some((g) => g.status !== "scheduled")) results[w] = { complete: weekComplete(games, w), games: gs.map(({ updated_at: _u, ...g }) => g) };
  }
  const hideUntilKickoff = settings.rules?.hide_picks === true;
  const outPlayers = players.map((p) => {
    const mine: Record<string, string> = {}, hidden: Record<string, boolean> = {};
    for (const k of picks.filter((k) => k.player_id === p.id)) {
      const ko = kickoffOf(k.week, k.team);
      const visible = !hideUntilKickoff || (me && me.id === p.id) || !ko || Date.parse(ko) <= now.getTime();
      if (visible) mine[k.week] = k.team; else { mine[k.week] = "?"; hidden[k.week] = true; }
    }
    const weeks: Record<string, any> = {};
    for (const [w, v] of Object.entries(st[p.id].weeks)) weeks[w] = hidden[w] ? { ...v, pick: "?" } : v;
    return { id: p.id, name: p.name, paid: p.paid, has_pin: !!p.pin_hash, picks: mine, hidden, eliminated_week: st[p.id].eliminated_week, strikes: st[p.id].strikes, weeks };
  });
  const alive = outPlayers.filter((p) => p.eliminated_week === null).length;
  return {
    name: settings.name, season: settings.season, commissioner: settings.commissioner, contact: settings.contact,
    buy_in: Number(settings.buy_in || 0), pot: Number(settings.buy_in || 0) * players.length, rules: settings.rules,
    current_week: cw, teams: TEAMS, schedule, results, players: outPlayers, notes, alive,
    me: me ? { id: me.id, name: me.name } : null, server_time: now.toISOString(),
  };
}

async function playerByPin(pin: string): Promise<Player | null> {
  if (!pinOk(pin)) return null;
  const { data } = await db.from("survivor_players").select("*").eq("pin_hash", await hashPlayerPin(pin)).maybeSingle();
  return (data as Player) || null;
}
async function authPlayer(body: any): Promise<Player | null> {
  const p = await playerByPin(String(body?.pin || ""));
  if (!p) return null;
  if (body?.player_id && Number(body.player_id) !== p.id) return null;
  return p;
}
async function authAdmin(pin: unknown) {
  if (!adminPinOk(pin)) return false;
  const { data } = await db.from("survivor_settings").select("admin_pin_hash").eq("id", 1).single();
  return !!data?.admin_pin_hash && (await hashAdminPin(String(pin))) === data.admin_pin_hash;
}
const log = (who: string, action: string, detail: unknown) => db.from("survivor_log").insert({ who, action, detail }).then(() => {});

// ---- handlers ----
// Log in with just a PIN.
async function handleLogin(body: any) {
  const pin = String(body?.pin || "");
  if (!pinOk(pin)) return fail("PIN must be 4 digits.");
  const p = await playerByPin(pin);
  if (!p) return fail("No account with that PIN. Check the digits, or tap “Create my account” if you’re new.", 401);
  return json({ ok: true, player_id: p.id, name: p.name });
}

// Create an account: name + 4-digit PIN. PINs must be unique (the PIN is the login).
async function handleSignup(body: any) {
  const name = String(body?.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const pin = String(body?.pin || "");
  if (name.length < 2) return fail("Please enter your name.");
  if (!pinOk(pin)) return fail("PIN must be exactly 4 digits.");
  const { data: settings } = await db.from("survivor_settings").select("rules").eq("id", 1).single();
  if (settings?.rules?.signups_open === false) return fail("Sign-ups are closed. Ask the commissioner to add you.");
  if (await playerByPin(pin)) return fail("That PIN is already taken — please choose a different 4 digits.");
  const pin_hash = await hashPlayerPin(pin);
  // If the commissioner pre-added this name without a PIN, claim it.
  const { data: existing } = await db.from("survivor_players").select("*").ilike("name", name).maybeSingle();
  if (existing) {
    if (existing.pin_hash) return fail("Someone already has that name. If it’s you, log in with your PIN, or ask the commissioner to reset it.");
    await db.from("survivor_players").update({ pin_hash }).eq("id", existing.id);
    await log(existing.name, "claimed_account", {});
    return json({ ok: true, player_id: existing.id, name: existing.name });
  }
  const { data: p, error } = await db.from("survivor_players").insert({ name, pin_hash }).select("*").single();
  if (error) return fail(error.code === "23505" ? "That PIN or name is already taken." : error.message, 400);
  await log(p.name, "signup", {});
  return json({ ok: true, player_id: p.id, name: p.name });
}

async function handlePick(body: any) {
  const me = await authPlayer(body);
  if (!me) return fail("Please sign in again.", 401);
  const team = normTeam(body?.team);
  if (!team) return fail("Unknown team.");
  const now = new Date();
  const { settings, players, picks, games } = await loadAll();
  const cw = currentWeek(games, now);
  const week = Number(body?.week || cw);
  if (week !== cw) return fail(`Picks are open for Week ${cw} only.`);
  const { st } = compute(settings, players, picks, games, now);
  if (st[me.id].eliminated_week !== null) return fail("You've been eliminated — no more picks. Better luck next year!");
  const g = games.find((x) => x.week === week && (x.away === team || x.home === team));
  if (!g) return fail(`${TEAMS[team]} don't play in Week ${week} (bye week).`);
  if (Date.parse(g.kickoff) <= now.getTime()) return fail(`Too late — the ${TEAMS[team]} game already kicked off.`);
  const used = picks.find((k) => k.player_id === me.id && k.week !== week && k.team === team);
  if (used) return fail(`You already used the ${TEAMS[team]} in Week ${used.week}.`);
  const existing = picks.find((k) => k.player_id === me.id && k.week === week);
  if (existing) {
    const eg = games.find((x) => x.week === week && (x.away === existing.team || x.home === existing.team));
    if (eg && Date.parse(eg.kickoff) <= now.getTime()) return fail(`Your ${TEAMS[existing.team]} pick is locked — that game already started.`);
  }
  const { error } = await db.from("survivor_picks").upsert({ player_id: me.id, week, team, updated_at: now.toISOString() }, { onConflict: "player_id,week" });
  if (error) return fail(error.message, 500);
  await log(me.name, "pick", { week, team, was: existing?.team || null });
  return json({ ok: true, week, team, state: await buildState(me) });
}

async function handleAdmin(body: any) {
  const op = String(body?.op || "");
  const { data: s } = await db.from("survivor_settings").select("admin_pin_hash").eq("id", 1).single();
  if (!s?.admin_pin_hash) {
    if (op === "set_admin_pin" && adminPinOk(body?.new_pin)) {
      await db.from("survivor_settings").update({ admin_pin_hash: await hashAdminPin(String(body.new_pin)) }).eq("id", 1);
      return json({ ok: true, message: "Admin PIN set." });
    }
    return fail("No admin PIN set yet.", 401);
  }
  if (!(await authAdmin(body?.admin_pin))) return fail("Wrong admin PIN.", 401);
  const now = new Date().toISOString();
  const who = "commissioner";
  switch (op) {
    case "check": return json({ ok: true });
    case "set_admin_pin": {
      if (!adminPinOk(body?.new_pin)) return fail("PIN must be 4–8 digits.");
      await db.from("survivor_settings").update({ admin_pin_hash: await hashAdminPin(String(body.new_pin)), updated_at: now }).eq("id", 1);
      return json({ ok: true });
    }
    case "settings": {
      const patch: any = { updated_at: now };
      for (const k of ["name", "commissioner", "contact"]) if (typeof body[k] === "string") patch[k] = body[k].trim();
      if (body.buy_in !== undefined) patch.buy_in = Number(body.buy_in) || 0;
      if (body.rules && typeof body.rules === "object") {
        patch.rules = { tie: body.rules.tie === "win" ? "win" : "loss", missed_pick: body.rules.missed_pick === "skip" ? "skip" : "loss",
          all_out_reset: body.rules.all_out_reset !== false, strikes: Math.max(1, Math.min(3, Number(body.rules.strikes) || 1)),
          hide_picks: body.rules.hide_picks === true, signups_open: body.rules.signups_open !== false };
      }
      const { error } = await db.from("survivor_settings").update(patch).eq("id", 1);
      if (error) return fail(error.message, 500);
      await log(who, "settings", patch);
      return json({ ok: true });
    }
    case "add_player": {
      const names = String(body.names || body.name || "").split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
      if (!names.length) return fail("Give at least one name.");
      const added: string[] = [];
      for (const name of names) {
        const { error } = await db.from("survivor_players").insert({ name });
        if (!error) added.push(name);
      }
      await log(who, "add_player", { added });
      return json({ ok: true, added });
    }
    case "rename_player": {
      const { error } = await db.from("survivor_players").update({ name: String(body.name || "").trim() }).eq("id", Number(body.player_id));
      return error ? fail(error.message) : json({ ok: true });
    }
    case "remove_player": {
      await db.from("survivor_players").delete().eq("id", Number(body.player_id));
      await log(who, "remove_player", { player_id: body.player_id });
      return json({ ok: true });
    }
    case "set_pin": {
      const id = Number(body.player_id);
      const pin = body.pin == null || body.pin === "" ? null : String(body.pin);
      if (pin !== null && !pinOk(pin)) return fail("PIN must be 4 digits.");
      if (pin !== null) { const taken = await playerByPin(pin); if (taken && taken.id !== id) return fail(`That PIN is already used by ${taken.name}.`); }
      await db.from("survivor_players").update({ pin_hash: pin ? await hashPlayerPin(pin) : null }).eq("id", id);
      await log(who, pin ? "set_pin" : "reset_pin", { player_id: id });
      return json({ ok: true });
    }
    case "set_paid": {
      await db.from("survivor_players").update({ paid: !!body.paid }).eq("id", Number(body.player_id));
      return json({ ok: true });
    }
    case "set_pick": { // commissioner override — no kickoff/used checks, but team must play that week
      const id = Number(body.player_id), week = Number(body.week), team = normTeam(body.team);
      if (!team) return fail("Unknown team.");
      const { data: g } = await db.from("survivor_games").select("week").eq("week", week).or(`away.eq.${team},home.eq.${team}`).maybeSingle();
      if (!g) return fail(`${team} doesn't play in Week ${week}.`);
      const { error } = await db.from("survivor_picks").upsert({ player_id: id, week, team, updated_at: now }, { onConflict: "player_id,week" });
      if (error) return fail(error.message, 500);
      await log(who, "set_pick", { player_id: id, week, team });
      return json({ ok: true });
    }
    case "clear_pick": {
      await db.from("survivor_picks").delete().eq("player_id", Number(body.player_id)).eq("week", Number(body.week));
      await log(who, "clear_pick", { player_id: body.player_id, week: body.week });
      return json({ ok: true });
    }
    case "set_result": {
      const week = Number(body.week), away = normTeam(body.away), home = normTeam(body.home);
      if (!away || !home) return fail("Unknown team.");
      const { error } = await db.from("survivor_games").update({ away_score: Number(body.away_score) || 0, home_score: Number(body.home_score) || 0,
        status: body.status === "scheduled" ? "scheduled" : "final", detail: body.status === "scheduled" ? "" : "Final (manual)", updated_at: now })
        .eq("week", week).eq("away", away).eq("home", home);
      if (error) return fail(error.message, 500);
      await log(who, "set_result", { week, away, home, away_score: body.away_score, home_score: body.home_score });
      return json({ ok: true });
    }
    case "refresh_scores": {
      const week = Number(body.week);
      try { const n = await refreshWeek(week); return json({ ok: true, games: n }); }
      catch (e) { return fail("ESPN fetch failed: " + (e as Error).message, 502); }
    }
    case "refresh_schedule": {
      let total = 0;
      for (let w = 1; w <= 18; w++) {
        try { const gs = await fetchEspnWeek(w); if (!gs.length) continue;
          // only update kickoff times (and add missing games); don't touch scores here
          for (const g of gs) {
            const { data: ex } = await db.from("survivor_games").select("status").eq("week", w).eq("away", g.away!).eq("home", g.home!).maybeSingle();
            if (ex) { if (ex.status === "scheduled") await db.from("survivor_games").update({ kickoff: g.kickoff }).eq("week", w).eq("away", g.away!).eq("home", g.home!); }
            else await db.from("survivor_games").insert({ ...g, updated_at: now });
            total++;
          }
        } catch (e) { return fail(`ESPN failed on week ${w}: ${(e as Error).message}`, 502); }
      }
      await log(who, "refresh_schedule", { games: total });
      return json({ ok: true, games: total });
    }
    case "log": {
      const { data } = await db.from("survivor_log").select("*").order("id", { ascending: false }).limit(100);
      return json({ ok: true, log: data });
    }
    default: return fail("Unknown admin op: " + op);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/survivor/, "") || "/";
  try {
    if (req.method === "GET" && (path === "/" || path === "" || path === "/index.html")) {
      // The website itself is hosted on GitHub Pages (Supabase won't serve HTML from its domain).
      const site = Deno.env.get("SITE_URL") || "https://zekeromero.github.io/family-survivor-pool/";
      return new Response(null, { status: 302, headers: { ...CORS, Location: site } });
    }
    if (path === "/api/state") {
      let me: Player | null = null;
      if (req.method === "POST") me = await authPlayer(await req.json().catch(() => ({})));
      return json(await buildState(me));
    }
    if (req.method !== "POST") return fail("Not found", 404);
    const body = await req.json().catch(() => ({}));
    if (path === "/api/login") return await handleLogin(body);
    if (path === "/api/signup") return await handleSignup(body);
    if (path === "/api/pick") return await handlePick(body);
    if (path === "/api/admin") return await handleAdmin(body);
    if (path === "/api/refresh") { // for cron / manual poke: refresh any live weeks
      const { games } = await loadAll();
      const did = await autoRefresh(games, new Date());
      return json({ ok: true, refreshed: did });
    }
    return fail("Not found", 404);
  } catch (e) {
    console.error(e);
    return fail("Server error: " + (e as Error).message, 500);
  }
});
