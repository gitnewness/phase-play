import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Phase Play backend (Supabase project "phase-play").
// Public:        register, counts, activity (totals + anonymous feed for the main page),
//                join_list (the "join the list for next camp" form),
//                wl_interphase (a just-waitlisted family adds the $35 Interphase workouts)
// Player link:   ip_load, ip_save            (token from the player's private Interphase link)
// Coach code:    admin, save_teams, add_player, update_player, ip_admin
// Check-in:      checkin_roster, check_in (public, QR code at the door; first check-in signs the releases);
//                checkin_admin, checkin_undo (coach code)
// Day 2 teams:   teams_admin, teams_save, teams_publish (coach code); my_team (player's private link, published only)
// Feedback:      fb_load, fb_save (player's private link, or no link + player name); fb_admin (coach code)
const COHORTS = ["10 & Under", "5th/6th Girls", "5th/6th Boys", "7th/8th Girls", "7th/8th Boys"];
// 10 & Under was first called "9 & Under"; pages cached under the old name still work.
const U10 = "10 & Under";
function cohortName(v: unknown): string {
  const c = clean(v, 40);
  return c === "9 & Under" ? U10 : c;
}
// 10 & Under (game day only, $50) asks for an experience level: 1 some experience,
// 2 plays recreational, 3 plays competitively. Accepts 2 or "2 — Plays recreational".
function skillLevel(v: unknown): number | null {
  const n = parseInt(String(v ?? "").trim(), 10);
  return n >= 1 && n <= 3 ? n : null;
}
// Camp check-in sessions (Pacific time). Rosters come from active camp registrations:
// Day 1 7th/8th Boys are split by registrations.day1_group ('am'/'pm'); a boy with no group
// shows on both Day 1 lists until the coach sets one. extra_sessions adds a player to another
// session (Billy Nunes also plays the 10 & Under game).
const SESSIONS = [
  { key: "d1-am", day: "Day 1, Mon Nov 23", title: "Morning session", time: "10 AM - 12 PM", who: "7th/8th Girls and the 7th/8th Boys morning group", start: "2026-11-23T10:00:00-08:00", end: "2026-11-23T12:00:00-08:00" },
  { key: "d1-pm", day: "Day 1, Mon Nov 23", title: "Afternoon session", time: "1 - 3 PM", who: "5th/6th Boys and the 7th/8th Boys afternoon group", start: "2026-11-23T13:00:00-08:00", end: "2026-11-23T15:00:00-08:00" },
  { key: "d2-boys", day: "Day 2, Tue Nov 24", title: "7th/8th Boys round robin", time: "10:00 - 11:55 AM", who: "Warm-up at 9:45", start: "2026-11-24T09:45:00-08:00", end: "2026-11-24T11:55:00-08:00" },
  { key: "d2-girls", day: "Day 2, Tue Nov 24", title: "7th/8th Girls game", time: "12:10 - 1:10 PM", who: "", start: "2026-11-24T12:10:00-08:00", end: "2026-11-24T13:10:00-08:00" },
  { key: "d2-u10", day: "Day 2, Tue Nov 24", title: "10 & Under game", time: "1:15 - 2:15 PM", who: "", start: "2026-11-24T13:15:00-08:00", end: "2026-11-24T14:15:00-08:00" },
  { key: "d2-56", day: "Day 2, Tue Nov 24", title: "5th/6th Boys game", time: "2:20 - 3:20 PM", who: "", start: "2026-11-24T14:20:00-08:00", end: "2026-11-24T15:20:00-08:00" },
];
// Check-in at the door is Day 1 only (Day 2 games have no check-in). SESSIONS still drives Day 2 teams.
const CHECKIN_SESSIONS = SESSIONS.filter((s) => s.key.startsWith("d1-"));
type CheckReg = { id: string; player: string; cohort: string; signup_type?: string | null; day1_group: string | null; extra_sessions: string[] | null };
function inSession(r: CheckReg, key: string): boolean {
  // "-<key>" takes a player out of one session (e.g. sick for a Day 2 game) without cancelling them.
  if ((r.extra_sessions ?? []).includes("-" + key)) return false;
  if ((r.extra_sessions ?? []).includes(key)) return true;
  // Waitlist / Interphase-only players are only on the sessions listed in their extra_sessions.
  if (r.signup_type && r.signup_type !== "reserve") return false;
  const c = r.cohort, g = r.day1_group;
  switch (key) {
    case "d1-am": return c === "7th/8th Girls" || (c === "7th/8th Boys" && g !== "pm");
    case "d1-pm": return c === "5th/6th Boys" || c === "5th/6th Girls" || (c === "7th/8th Boys" && g !== "am");
    case "d2-boys": return c === "7th/8th Boys";
    case "d2-girls": return c === "7th/8th Girls";
    case "d2-u10": return c === U10;
    case "d2-56": return c === "5th/6th Boys";
  }
  return false;
}
// Registered players, plus waitlist / Interphase-only players the coach added to a session (extra_sessions).
async function checkRegs(): Promise<CheckReg[]> {
  const { data, error } = await db.from("registrations").select("id, player, cohort, signup_type, day1_group, extra_sessions")
    .eq("status", "active").eq("is_test", false);
  if (error) throw error;
  return ((data ?? []) as CheckReg[]).filter((r) => r.signup_type === "reserve" || (r.extra_sessions ?? []).length > 0);
}
// Public lists show first name + last initial only.
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? "";
  const first = parts[0], last = parts[parts.length - 1];
  return first.charAt(0).toUpperCase() + first.slice(1) + " " + last.charAt(0).toUpperCase() + ".";
}
function sessionMeta(s: typeof SESSIONS[number]) {
  return { key: s.key, day: s.day, title: s.title, time: s.time, who: s.who, start: s.start, end: s.end };
}
// Day 2 games: ranking + team split. Ranks and teams are coach-only; a parent sees their own
// kid's team and game times (my_team, via the player's private link) only once that game is published.
const TEAM_GAMES: Record<string, { teams: number; slots?: { label: string; time: string; a: number; b: number }[] }> = {
  "d2-boys": { teams: 3, slots: [
    { label: "Game 1", time: "10:00 - 10:35 AM", a: 1, b: 2 },
    { label: "Game 2", time: "10:40 - 11:15 AM", a: 1, b: 3 },
    { label: "Game 3", time: "11:20 - 11:55 AM", a: 2, b: 3 },
  ] },
  "d2-girls": { teams: 2 },
  "d2-u10": { teams: 2 },
  "d2-56": { teams: 2 },
};
const PHOTO_BUCKET = "check-in-photos";
// Liability + media releases (text: check-in/releases.html). A parent signs once per player per version,
// the first time they check that player in. Change the version whenever the wording changes.
const WAIVER_VERSION = "2026-11-v1";
async function waiverIds(): Promise<Set<string>> {
  const { data, error } = await db.from("waivers").select("registration_id").eq("version", WAIVER_VERSION);
  if (error) throw error;
  return new Set((data ?? []).map((w) => w.registration_id as string));
}
// Base64 JPEG (with or without a data: prefix), at most 1.5 MB.
function photoBytes(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || v.length > 2_100_000) return null;
  const b64 = v.replace(/^data:image\/jpeg;base64,/, "");
  let bin: string;
  try { bin = atob(b64); } catch { return null; }
  if (bin.length < 2000 || bin.length > 1_500_000) return null;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out[0] === 0xff && out[1] === 0xd8 ? out : null;
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
// Public check-in list: short names, grouped by cohort (e.g. 7th/8th Girls, 7th/8th Boys) in COHORTS order.
// A player added to another group's session (extra_sessions) is listed under that session's group.
function rosterGroups(regs: CheckReg[], key: string, signed: Set<string>) {
  const own = new Set(regs.filter((r) => !(r.extra_sessions ?? []).includes(key)).map((r) => r.cohort));
  const first = COHORTS.find((c) => own.has(c)) ?? "";
  return regs.map((r) => ({ id: r.id, name: shortName(r.player), group: own.has(r.cohort) ? r.cohort : first, waiver: signed.has(r.id) }))
    .sort((a, b) => (COHORTS.indexOf(a.group) - COHORTS.indexOf(b.group)) || byName(a, b));
}

const IP_BLOCKS = ["stationary", "motion", "form", "pickup", "pullup", "finishing", "passing"];
// THE 100 shooting test: 10 stations x 10 shots; each shot 0 (miss) or 1-3 points.
const TEST_STATIONS = ["classic_r", "classic_l", "ext_r", "ext_l", "rev_r", "rev_l", "ft10", "ft15", "ft20", "ft_free"];
function scoreTest(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const shots: Record<string, number[]> = {};
  let makes = 0, points = 0, taken = 0;
  for (const id of TEST_STATIONS) {
    const arr = (raw as any)[id];
    if (!Array.isArray(arr) || arr.length !== 10) return null;
    const clean = arr.map((v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3 ? (v as number) : -1));
    if (clean.some((v) => v < 0)) return null;
    shots[id] = clean;
    for (const v of clean) { taken++; if (v > 0) { makes++; points += v; } }
  }
  const pct = taken ? (makes / taken) * 100 : 0;
  const ovr = Math.min(100, Math.round((points * (pct / 100)) / 2));
  return { shots, makes, points, ovr };
}
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function clean(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken(len = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// The coach code is checked against ADMIN_CODE (if that secret exists) or else a salted hash in admin_config.
async function codeMatches(code: string): Promise<boolean | null> {
  const envCode = (Deno.env.get("ADMIN_CODE") ?? "").trim();
  if (envCode.length >= 4) return safeEqual(code, envCode);
  const { data, error } = await db.from("admin_config").select("salt, code_hash").eq("id", 1).maybeSingle();
  if (error || !data) return null;
  return safeEqual(await sha256Hex(data.salt + code), data.code_hash);
}

async function checkCode(code: unknown): Promise<Response | null> {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count } = await db.from("admin_attempts").select("id", { count: "exact", head: true }).eq("ok", false).gte("at", since);
  if ((count ?? 0) >= 8) return json({ error: "locked", message: "Too many wrong codes. Try again in 15 minutes." }, 429);
  const given = typeof code === "string" ? code.trim() : "";
  const match = await codeMatches(given);
  if (match === null) return json({ error: "admin_code_not_set" }, 503);
  await db.from("admin_attempts").insert({ ok: match });
  if (!match) {
    await sleep(900);
    return json({ error: "wrong_code" }, 401);
  }
  return null;
}

async function counts() {
  const { data, error } = await db.from("registrations").select("cohort, created_at").eq("signup_type", "reserve").eq("status", "active").eq("is_test", false);
  if (error) throw error;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000; // "recent" window: 24 hours
  const out: Record<string, { enrolled: number; recent: string[] }> = {};
  for (const c of COHORTS) out[c] = { enrolled: 0, recent: [] };
  for (const r of data ?? []) {
    const o = out[r.cohort];
    if (!o) continue;
    o.enrolled++;
    if (Date.parse(r.created_at) >= dayAgo) o.recent.push(r.created_at);
  }
  out["9 & Under"] = out[U10]; // old name, for pages loaded before the rename
  return out;
}

// Look up the player behind an Interphase link: the 8-character code, or
// the original 24-character token (old links keep working).
async function playerForToken(token: unknown) {
  const t = clean(token, 64);
  if (!/^[A-Za-z0-9]+$/.test(t) || (t.length !== 8 && t.length < 20)) return null;
  const { data } = await db.from("interphase_access")
    .select("registration_id, active, registrations(player, cohort, status)")
    .eq(t.length === 8 ? "code" : "token", t).maybeSingle();
  if (!data || !data.active) return null;
  const reg = (data as any).registrations;
  if (!reg || reg.status === "cancelled") return null;
  return { id: data.registration_id as string, player: reg.player as string, cohort: reg.cohort as string };
}

// Make sure every active, reserved player (and every Interphase-only player) has an Interphase link.
// signup_type "interphase" = the $35 standalone: gets a workout link but never takes a camp spot.
// Waitlisted players who added Interphase (interphase_addon) get a link too.
async function ensureTokens() {
  const { data: regs, error } = await db.from("registrations").select("id").eq("status", "active")
    .or("signup_type.in.(reserve,interphase),and(signup_type.eq.waitlist,interphase_addon.eq.true)");
  if (error) throw error;
  const { data: have } = await db.from("interphase_access").select("registration_id");
  const got = new Set((have ?? []).map((r) => r.registration_id));
  const rows = (regs ?? []).filter((r) => !got.has(r.id)).map((r) => ({ registration_id: r.id, token: newToken(), code: newToken(8) }));
  if (rows.length) {
    const { error: e2 } = await db.from("interphase_access").insert(rows);
    if (e2) throw e2;
  }
}

// Public Interphase activity for the main page: totals and an anonymous
// feed only. No names, tokens or scores. Cohorts with fewer than 3 players
// are shown as "a Phase Play player" so nobody can be singled out.
async function activity() {
  const { data: regs, error: rErr } = await db.from("registrations")
    .select("id, cohort").eq("status", "active").eq("is_test", false);
  if (rErr) throw rErr;
  const cohortOf = new Map<string, string>();
  const size: Record<string, number> = {};
  for (const r of regs ?? []) { cohortOf.set(r.id, r.cohort); size[r.cohort] = (size[r.cohort] ?? 0) + 1; }
  const ids = [...cohortOf.keys()];
  if (!ids.length) return { sessions: 0, players: 0, tests: 0, feed: [] };
  const [{ data: sess, error: sErr }, { data: tests, error: tErr }] = await Promise.all([
    db.from("interphase_sessions").select("registration_id, block_key, session_no, level, updated_at")
      .not("completed_on", "is", null).in("registration_id", ids),
    db.from("test_results").select("registration_id, created_at").in("registration_id", ids),
  ]);
  if (sErr) throw sErr;
  if (tErr) throw tErr;
  const who = (id: string) => { const c = cohortOf.get(id) ?? ""; return (size[c] ?? 0) >= 3 ? c : ""; };
  const players = new Set<string>();
  const feed: { kind: string; cohort: string; block?: string; session?: number; level?: number | null; at: string }[] = [];
  for (const s of sess ?? []) {
    players.add(s.registration_id);
    feed.push({ kind: "session", cohort: who(s.registration_id), block: s.block_key, session: s.session_no, level: s.level ?? null, at: s.updated_at });
  }
  for (const t of tests ?? []) {
    players.add(t.registration_id);
    feed.push({ kind: "test", cohort: who(t.registration_id), at: t.created_at });
  }
  feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { sessions: sess?.length ?? 0, players: players.size, tests: tests?.length ?? 0, feed: feed.slice(0, 6) };
}

// Post-camp feedback. The next camp offered on the form: Christmas break, Dec 21 & 22.
const FB_NEXT_CAMP = "Christmas break camp, Dec 21 & 22";
const FB_WORKOUTS = ["yes", "some", "no"];
const FB_NEXT = ["yes", "maybe", "no"];
// Families who answer Yes or Maybe for the next camp also go on next_camp_list (once per email).
async function fbJoinList(parent: string, email: string, player: string, grade: string, choice: string) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  const note = "Feedback form: " + (choice === "yes" ? "Yes" : "Maybe") + ", " + FB_NEXT_CAMP;
  const { data: have } = await db.from("next_camp_list").select("id").eq("email", email).like("notes", "Feedback form:%").limit(1);
  if (have?.length) { await db.from("next_camp_list").update({ notes: note }).eq("id", have[0].id); return; }
  await db.from("next_camp_list").insert({ parent: parent || email, email, player: player || null, grade: grade || null, notes: note, source: "feedback" });
}

// Email to Coach Michael for every saved feedback (Resend). Needs the secrets RESEND_API_KEY and FB_NOTIFY_TO
// (the inbox to send to). RESEND_FROM is optional (defaults to Resend's sandbox sender until
// phaseplayhoops.com is verified in Resend). Never throws: a failed email must not fail the parent's submit.
async function fbNotify(f: { player: string; parent: string; email: string; rating: number; liked: string | null; change: string | null;
  workouts: string | null; next_camp: string | null; quote_ok: boolean }) {
  try {
    const key = (Deno.env.get("RESEND_API_KEY") ?? "").trim();
    // Tolerates quotes, spaces, "mailto:" and "Name <addr>" in the secret.
    const raw = (Deno.env.get("FB_NOTIFY_TO") ?? "").trim();
    const to = ((raw.match(/[^\s<>"'`:,;]+@[^\s<>"'`:,;]+/) ?? [""])[0]).toLowerCase();
    if (!key || !to) { console.error("fbNotify: RESEND_API_KEY or FB_NOTIFY_TO not set"); return; }
    const from = (Deno.env.get("RESEND_FROM") ?? "").trim() || "Phase Play Feedback <onboarding@resend.dev>";
    const work = { yes: "Yes", some: "Some", no: "Not yet" } as Record<string, string>;
    const next = { yes: "Yes", maybe: "Maybe", no: "Not this time" } as Record<string, string>;
    const lines = [
      ...(f.next_camp === "yes" ? ["WANTS A SPOT — December camp Dec 21-22", ""] : []),
      "Player: " + f.player,
      "Parent: " + (f.parent || "(not given)"),
      "Parent email: " + (f.email || "(not on file)"),
      "",
      "Recommend rating: " + f.rating + "/10",
      "",
      "What they liked most:",
      f.liked || "(blank)",
      "",
      "What to change / do better:",
      f.change || "(blank)",
      "",
      "Interphase workouts at home: " + (f.workouts ? work[f.workouts] : "(no answer)"),
      "Next camp, Dec 21-22: " + (f.next_camp ? next[f.next_camp] : "(no answer)"),
      "OK to share comments publicly: " + (f.quote_ok ? "Yes" : "No"),
    ];
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: "Phase Play feedback: " + f.player + " — " + f.rating + "/10", text: lines.join("\n") }),
      signal: AbortSignal.timeout(8000),
    });
    // Masked recipient in the log (first letter, length, domain) so a wrong secret can be spotted.
    const masked = to.charAt(0) + "*(" + to.split("@")[0].length + ")@" + (to.split("@")[1] ?? "") + " raw_len=" + raw.length;
    if (!res.ok) console.error("fbNotify: Resend " + res.status + " to=" + masked + " " + (await res.text()).slice(0, 300));
    else console.log("fbNotify: sent to=" + masked);
  } catch (e) {
    console.error("fbNotify failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = clean(body.action, 40);
  try {
    if (action === "counts") return json({ cohorts: await counts() });
    if (action === "activity") return json(await activity());

    if (action === "register") {
      if (clean(body.bot, 10)) return json({ ok: true });
      const player = clean(body.player, 120);
      const cohort = cohortName(body.cohort);
      if (!player || !COHORTS.includes(cohort)) return json({ error: "invalid" }, 400);
      // The $35 standalone never takes a camp spot, whatever the page sent.
      const standalone = /^Repping & Testing/.test(clean(body.package, 120));
      // After registration closes (8:30 PM Pacific, Nov 21) a page left open can't take a camp spot.
      const closed = Date.now() >= Date.parse("2026-11-22T04:30:00Z");
      const signup_type = standalone ? "interphase" : closed || clean(body.signup_type, 20) === "waitlist" ? "waitlist" : "reserve";
      const { data: row, error } = await db.from("registrations").insert({
        parent: clean(body.parent, 120), email: clean(body.email, 200).toLowerCase(), player, cohort,
        school: clean(body.school, 120) || null,
        package: clean(body.package, 120), signup_type, source: "site",
        skill_level: cohort === U10 ? skillLevel(body.skill_level) : null,
      }).select("id").single();
      if (error) throw error;
      // Waitlist sign-ups get their id back so the thank-you screen can offer Interphase.
      return json(signup_type === "waitlist" ? { ok: true, id: row.id } : { ok: true });
    }

    // "Join the list for next camp": a family asks to hear about the next camp.
    if (action === "join_list") {
      if (clean(body.bot, 10)) return json({ ok: true });
      const parent = clean(body.parent, 120), email = clean(body.email, 200).toLowerCase();
      if (!parent || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid" }, 400);
      const { error } = await db.from("next_camp_list").insert({
        parent, email, phone: clean(body.phone, 40) || null, player: clean(body.player, 120) || null,
        grade: clean(body.grade, 40) || null, notes: clean(body.notes, 500) || null,
      });
      if (error) throw error;
      return json({ ok: true });
    }

    // A parent's view of their own kid's Day 2 team(s): player's private link, published games only.
    if (action === "my_team") {
      const who = await playerForToken(body.token);
      if (!who) { await sleep(400); return json({ error: "bad_link" }, 404); }
      const { data: r } = await db.from("registrations").select("id, player, cohort, signup_type, day1_group, extra_sessions, status").eq("id", who.id).maybeSingle();
      if (!r || r.status !== "active") return json({ error: "bad_link" }, 404);
      const keys = Object.keys(TEAM_GAMES).filter((k) => inSession(r as CheckReg, k));
      const [{ data: pub }, { data: tm }] = await Promise.all([
        db.from("game_publish").select("game, published").in("game", keys.length ? keys : ["-"]),
        db.from("game_teams").select("game, team").eq("registration_id", r.id),
      ]);
      const isPub = new Set((pub ?? []).filter((x) => x.published).map((x) => x.game));
      const teamOf: Record<string, number> = {};
      for (const t of tm ?? []) teamOf[t.game] = t.team;
      const games = keys.map((k) => {
        const s = SESSIONS.find((x) => x.key === k)!;
        const team = isPub.has(k) ? teamOf[k] ?? null : null;
        const slots = team && TEAM_GAMES[k].slots
          ? TEAM_GAMES[k].slots!.filter((g) => g.a === team || g.b === team).map((g) => ({ label: g.label, time: g.time, opponent: "Team " + (g.a === team ? g.b : g.a) }))
          : [];
        return { key: k, title: s.title, day: s.day, time: s.time, who: s.who, published: isPub.has(k) && !!team, team: team ? "Team " + team : null, slots };
      });
      return json({ player: r.player.split(/\s+/)[0], games });
    }

    // ---- Camp check-in (public: names only, never who has checked in) ----
    if (action === "checkin_roster") {
      const [regs, signed] = await Promise.all([checkRegs(), waiverIds()]);
      return json({ waiver_version: WAIVER_VERSION, sessions: CHECKIN_SESSIONS.map((s) => ({ ...sessionMeta(s),
        players: rosterGroups(regs.filter((r) => inSession(r, s.key)), s.key, signed) })) });
    }
    if (action === "check_in") {
      const id = clean(body.id, 60), key = clean(body.session, 20);
      const s = CHECKIN_SESSIONS.find((x) => x.key === key);
      if (!s || !/^[0-9a-f-]{36}$/.test(id)) return json({ error: "invalid" }, 400);
      const { data: r } = await db.from("registrations").select("id, player, cohort, day1_group, extra_sessions, signup_type, status, is_test").eq("id", id).maybeSingle();
      if (!r || r.status !== "active" || r.is_test || !inSession(r as CheckReg, key)) return json({ error: "not_on_list" }, 404);
      const done = { ok: true, name: shortName(r.player), session: s.title, time: s.time, day: s.day };
      const { data: prev } = await db.from("check_ins").select("id, photo_path").eq("registration_id", id).eq("session", key).maybeSingle();
      if (prev?.photo_path) return json({ ...done, already: true });
      // Releases: required before the first check-in. Saved before the photo, so a retry doesn't ask twice.
      const { data: onFile } = await db.from("waivers").select("id").eq("registration_id", id).eq("version", WAIVER_VERSION).maybeSingle();
      if (!onFile) {
        const w = (body.waiver ?? {}) as Record<string, unknown>;
        const signer = clean(w.signer, 120);
        if (w.version !== WAIVER_VERSION || w.guardian !== true || w.liability !== true || w.media !== true || signer.length < 3) {
          return json({ error: "waiver_required", version: WAIVER_VERSION }, 400);
        }
        const { error: wErr } = await db.from("waivers").upsert({
          registration_id: id, version: WAIVER_VERSION, signer_name: signer, is_guardian: true,
          liability_accepted: true, media_accepted: true,
          ip: clean((req.headers.get("x-forwarded-for") ?? "").split(",")[0], 60) || null,
          user_agent: clean(req.headers.get("user-agent"), 300) || null,
        }, { onConflict: "registration_id,version", ignoreDuplicates: true });
        if (wErr) throw wErr;
      }
      // The parent's photo: a JPEG the page has already shrunk (no location data). Required to check in.
      const photo = photoBytes(body.photo);
      if (!photo) return json({ error: "photo_required" }, 400);
      const path = `${key}/${id}.jpg`;
      const { error: upErr } = await db.storage.from(PHOTO_BUCKET).upload(path, photo, { contentType: "image/jpeg", upsert: true });
      if (upErr) throw upErr;
      if (prev) {
        const { error } = await db.from("check_ins").update({ photo_path: path }).eq("id", prev.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("check_ins")
          .upsert({ registration_id: id, session: key, player: r.player, photo_path: path }, { onConflict: "registration_id,session", ignoreDuplicates: true });
        if (error) throw error;
      }
      return json({ ...done, already: !!prev });
    }

    // A family that just joined a waitlist adds the $35 Interphase workouts.
    // Only for a waitlist row created in the last 6 hours.
    if (action === "wl_interphase") {
      const id = clean(body.id, 60);
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "invalid" }, 400);
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const { data, error } = await db.from("registrations").update({ interphase_addon: true })
        .eq("id", id).eq("signup_type", "waitlist").eq("status", "active").gte("created_at", since).select("id");
      if (error) throw error;
      if (!data?.length) return json({ error: "not_found" }, 404);
      return json({ ok: true });
    }

    // ---- Interphase player app (private link) ----
    if (action === "ip_test_save") {
      const who = await playerForToken(body.token);
      if (!who) { await sleep(400); return json({ error: "bad_link" }, 404); }
      const scored = scoreTest(body.shots);
      if (!scored) return json({ error: "invalid" }, 400);
      const { data, error } = await db.from("test_results").insert({
        registration_id: who.id, shots: scored.shots, makes: scored.makes, points: scored.points, ovr: scored.ovr,
        scored_by: body.scored_by === "coach" ? "coach" : "player",
      }).select("id, created_at, makes, points, ovr").single();
      if (error) throw error;
      return json({ ok: true, result: data });
    }

    if (action === "ip_load" || action === "ip_save") {
      const who = await playerForToken(body.token);
      if (!who) { await sleep(400); return json({ error: "bad_link" }, 404); }
      if (action === "ip_load") {
        await db.from("interphase_access").update({ last_opened_at: new Date().toISOString() }).eq("registration_id", who.id);
        const { data, error } = await db.from("interphase_sessions")
          .select("block_key, session_no, level, completed_on, drills, test_score, notes")
          .eq("registration_id", who.id);
        if (error) throw error;
        const { data: tests } = await db.from("test_results").select("id, created_at, makes, points, ovr, shots, scored_by")
          .eq("registration_id", who.id).order("created_at", { ascending: true });
        return json({ player: who.player.split(/\s+/)[0], cohort: who.cohort, sessions: data ?? [], tests: tests ?? [] });
      }
      const block = clean(body.block, 40);
      const n = Number(body.session_no);
      if (!IP_BLOCKS.includes(block) || !Number.isInteger(n) || n < 1 || n > 10) return json({ error: "invalid" }, 400);
      const completed = clean(body.completed_on, 10);
      const drills = Array.isArray(body.drills) ? body.drills.filter((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) < 40).slice(0, 40) : [];
      const score = body.test_score === null || body.test_score === undefined || body.test_score === "" ? null : Number(body.test_score);
      const row = {
        registration_id: who.id, block_key: block, session_no: n,
        // Stationary has two levels: 1 = 1-ball, 2 = 2-ball. Older pages send no level and show the 2-ball list.
        level: block === "stationary" ? (Number(body.level) === 1 ? 1 : 2) : null,
        completed_on: /^\d{4}-\d{2}-\d{2}$/.test(completed) ? completed : null,
        drills,
        test_score: score !== null && Number.isFinite(score) && score >= 0 && score <= 100 ? Math.round(score) : null,
        notes: clean(body.notes, 1000) || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await db.from("interphase_sessions").upsert(row, { onConflict: "registration_id,block_key,session_no" });
      if (error) throw error;
      return json({ ok: true });
    }

    // ---- Post-camp feedback (public page /feedback/<name>#k=<code>, or /feedback/ with no code) ----
    if (action === "fb_load") {
      if (!clean(body.token, 64)) return json({ player: null, answers: null, next_camp: FB_NEXT_CAMP });
      const who = await playerForToken(body.token);
      if (!who) { await sleep(400); return json({ error: "bad_link" }, 404); }
      const { data } = await db.from("camp_feedback").select("rating, liked, change, workouts, next_camp, quote_ok").eq("registration_id", who.id).maybeSingle();
      return json({ player: who.player.split(/\s+/)[0], answers: data ?? null, next_camp: FB_NEXT_CAMP });
    }
    if (action === "fb_save") {
      if (clean(body.bot, 10)) return json({ ok: true });
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) return json({ error: "invalid" }, 400);
      const workouts = FB_WORKOUTS.includes(clean(body.workouts, 10)) ? clean(body.workouts, 10) : null;
      const next = FB_NEXT.includes(clean(body.next_camp, 10)) ? clean(body.next_camp, 10) : null;
      const row = { rating, liked: clean(body.liked, 2000) || null, change: clean(body.change, 2000) || null, workouts, next_camp: next,
        quote_ok: body.quote_ok === true, updated_at: new Date().toISOString() };
      if (clean(body.token, 64)) {
        const who = await playerForToken(body.token);
        if (!who) { await sleep(400); return json({ error: "bad_link" }, 404); }
        const { data: r } = await db.from("registrations").select("parent, email").eq("id", who.id).maybeSingle();
        const { error } = await db.from("camp_feedback").upsert({ ...row, registration_id: who.id, player_name: who.player, parent_name: r?.parent ?? null }, { onConflict: "registration_id" });
        if (error) throw error;
        if (next === "yes" || next === "maybe") await fbJoinList(r?.parent ?? "", (r?.email ?? "").toLowerCase(), who.player, who.cohort, next);
        await fbNotify({ ...row, player: who.player, parent: r?.parent ?? "", email: r?.email ?? "" });
        return json({ ok: true });
      }
      // No link: the parent types the player's name (and an email, if they want next-camp details).
      const player = clean(body.player, 120);
      if (!player) return json({ error: "invalid" }, 400);
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await db.from("camp_feedback").select("id", { count: "exact", head: true }).is("registration_id", null).gte("created_at", since);
      if ((count ?? 0) >= 40) return json({ error: "busy" }, 429);
      const parent = clean(body.parent, 120);
      const { error } = await db.from("camp_feedback").insert({ ...row, player_name: player, parent_name: parent || null });
      if (error) throw error;
      if (next === "yes" || next === "maybe") await fbJoinList(parent, clean(body.email, 200).toLowerCase(), player, "", next);
      await fbNotify({ ...row, player, parent, email: clean(body.email, 200).toLowerCase() });
      return json({ ok: true });
    }

    // ---- Coach backend (code required) ----
    const denied = await checkCode(body.code);
    if (denied) return denied;

    if (action === "admin") {
      const { data: regs, error } = await db.from("registrations")
        .select("id, created_at, parent, email, player, school, cohort, package, signup_type, interphase_addon, skill_level, status, paid, notes, source")
        .eq("is_test", false)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const { data: teams, error: tErr } = await db.from("day2_teams").select("registration_id, team");
      if (tErr) throw tErr;
      const { data: nextList, error: nErr } = await db.from("next_camp_list").select("created_at, parent, email, phone, player, grade, notes").order("created_at", { ascending: false });
      if (nErr) throw nErr;
      return json({ registrations: regs ?? [], teams: teams ?? [], next_camp: nextList ?? [] });
    }

    if (action === "fb_admin") {
      await ensureTokens();
      const regs = (await checkRegs()).filter((r) => r.player);
      const [{ data: fb, error: e1 }, { data: acc, error: e2 }, { data: info, error: e3 }] = await Promise.all([
        db.from("camp_feedback").select("registration_id, player_name, parent_name, rating, liked, change, workouts, next_camp, quote_ok, created_at, updated_at").order("updated_at", { ascending: false }),
        db.from("interphase_access").select("registration_id, code, active"),
        db.from("registrations").select("id, parent, email").in("id", regs.map((r) => r.id)),
      ]);
      if (e1 || e2 || e3) throw e1 || e2 || e3;
      const code: Record<string, string> = {};
      for (const x of acc ?? []) if (x.active && x.code) code[x.registration_id] = x.code;
      const pe: Record<string, { parent: string; email: string }> = {};
      for (const x of info ?? []) pe[x.id] = { parent: x.parent, email: x.email };
      const answered = new Set((fb ?? []).map((x) => x.registration_id).filter(Boolean));
      const slug = (n: string) => n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const campers = regs.map((r) => ({ id: r.id, player: r.player, cohort: r.cohort, parent: pe[r.id]?.parent ?? "", email: pe[r.id]?.email ?? "",
        link: code[r.id] ? "https://phaseplayhoops.com/feedback/" + slug(r.player) + "#k=" + code[r.id] : null, answered: answered.has(r.id) }))
        .sort((a, b) => a.player.localeCompare(b.player));
      return json({ feedback: fb ?? [], campers });
    }

    if (action === "checkin_admin") {
      const regs = await checkRegs();
      const { data: rows0, error } = await db.from("check_ins").select("registration_id, session, player, checked_in_at, photo_path");
      if (error) throw error;
      // Photos: short-lived signed links (1 hour); the bucket itself is private.
      const paths = (rows0 ?? []).map((x) => x.photo_path).filter(Boolean) as string[];
      const urls: Record<string, string> = {};
      if (paths.length) {
        const { data: signed } = await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
        for (const x of signed ?? []) if (x.path && x.signedUrl) urls[x.path] = x.signedUrl;
      }
      const rows = (rows0 ?? []).map((x) => ({ ...x, photo_url: x.photo_path ? urls[x.photo_path] ?? null : null }));
      const { data: waivers, error: wErr } = await db.from("waivers").select("registration_id, signer_name, signed_at, version").eq("version", WAIVER_VERSION);
      if (wErr) throw wErr;
      return json({ waivers: waivers ?? [], sessions: CHECKIN_SESSIONS.map((s) => ({ ...sessionMeta(s),
        players: regs.filter((r) => inSession(r, s.key)).map((r) => ({ id: r.id, name: r.player, cohort: r.cohort, day1_group: r.day1_group, extra: (r.extra_sessions ?? []).includes(s.key) }))
          .sort(byName) })), check_ins: rows ?? [] });
    }
    if (action === "teams_admin") {
      await ensureTokens();
      const regs = await checkRegs();
      const [{ data: ranks, error: e1 }, { data: tms, error: e2 }, { data: pub, error: e3 }, { data: acc, error: e4 }] = await Promise.all([
        db.from("game_ranks").select("game, registration_id, rank"),
        db.from("game_teams").select("game, registration_id, team"),
        db.from("game_publish").select("game, published, published_at"),
        db.from("interphase_access").select("registration_id, code, active"),
      ]);
      if (e1 || e2 || e3 || e4) throw e1 || e2 || e3 || e4;
      const rk: Record<string, number> = {}, tmOf: Record<string, number> = {}, code: Record<string, string> = {};
      for (const x of ranks ?? []) rk[x.game + "|" + x.registration_id] = x.rank;
      for (const x of tms ?? []) tmOf[x.game + "|" + x.registration_id] = x.team;
      for (const x of acc ?? []) if (x.active && x.code) code[x.registration_id] = x.code;
      return json({ games: Object.keys(TEAM_GAMES).map((k) => {
        const s = SESSIONS.find((x) => x.key === k)!;
        const p = (pub ?? []).find((x) => x.game === k);
        return { ...sessionMeta(s), teams: TEAM_GAMES[k].teams, slots: TEAM_GAMES[k].slots ?? [], published: !!p?.published, published_at: p?.published_at ?? null,
          players: regs.filter((r) => inSession(r, k)).map((r) => ({ id: r.id, name: r.player, cohort: r.cohort,
            rank: rk[k + "|" + r.id] ?? null, team: tmOf[k + "|" + r.id] ?? null, code: code[r.id] ?? null })) };
      }) });
    }
    if (action === "teams_save") {
      const k = clean(body.game, 20);
      if (!TEAM_GAMES[k]) return json({ error: "invalid" }, 400);
      const roster = new Set((await checkRegs()).filter((r) => inSession(r, k)).map((r) => r.id));
      const now = new Date().toISOString();
      const ranks = (Array.isArray(body.ranks) ? body.ranks : []).map((x: any) => ({ game: k, registration_id: clean(x?.id, 60), rank: Number(x?.rank), updated_at: now }))
        .filter((x: any) => roster.has(x.registration_id) && Number.isInteger(x.rank) && x.rank > 0);
      const teams = (Array.isArray(body.teams) ? body.teams : []).map((x: any) => ({ game: k, registration_id: clean(x?.id, 60), team: Number(x?.team), updated_at: now }))
        .filter((x: any) => roster.has(x.registration_id) && Number.isInteger(x.team) && x.team >= 1 && x.team <= TEAM_GAMES[k].teams);
      const d1 = await db.from("game_ranks").delete().eq("game", k); if (d1.error) throw d1.error;
      const d2 = await db.from("game_teams").delete().eq("game", k); if (d2.error) throw d2.error;
      if (ranks.length) { const { error } = await db.from("game_ranks").insert(ranks); if (error) throw error; }
      if (teams.length) { const { error } = await db.from("game_teams").insert(teams); if (error) throw error; }
      return json({ ok: true, ranks: ranks.length, teams: teams.length });
    }
    if (action === "teams_publish") {
      const k = clean(body.game, 20);
      if (!TEAM_GAMES[k] || typeof body.published !== "boolean") return json({ error: "invalid" }, 400);
      const { error } = await db.from("game_publish").upsert({ game: k, published: body.published, published_at: body.published ? new Date().toISOString() : null });
      if (error) throw error;
      return json({ ok: true });
    }
    if (action === "checkin_undo") {
      const id = clean(body.id, 60), key = clean(body.session, 20);
      if (!id || !SESSIONS.some((x) => x.key === key)) return json({ error: "invalid" }, 400);
      const { data: gone, error } = await db.from("check_ins").delete().eq("registration_id", id).eq("session", key).select("photo_path");
      if (error) throw error;
      const paths = (gone ?? []).map((x) => x.photo_path).filter(Boolean) as string[];
      if (paths.length) await db.storage.from(PHOTO_BUCKET).remove(paths);
      return json({ ok: true });
    }

    if (action === "ip_admin") {
      await ensureTokens();
      const { data: access, error } = await db.from("interphase_access").select("registration_id, token, code, active, last_opened_at");
      if (error) throw error;
      const { data: sess, error: sErr } = await db.from("interphase_sessions").select("registration_id, block_key, session_no, level, completed_on, test_score, drills, updated_at");
      if (sErr) throw sErr;
      const { data: tests, error: tErr } = await db.from("test_results").select("registration_id, created_at, makes, points, ovr, scored_by").order("created_at", { ascending: true });
      if (tErr) throw tErr;
      return json({ access: access ?? [], sessions: sess ?? [], tests: tests ?? [] });
    }

    if (action === "ip_toggle") {
      const id = clean(body.id, 60);
      if (!id || typeof body.active !== "boolean") return json({ error: "invalid" }, 400);
      const { error } = await db.from("interphase_access").update({ active: body.active }).eq("registration_id", id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "save_teams") {
      const list = Array.isArray(body.assignments) ? body.assignments : [];
      const rows = list
        .map((a: any) => ({ registration_id: clean(a?.id, 60), team: a?.team === "black" ? "black" : a?.team === "orange" ? "orange" : "", updated_at: new Date().toISOString() }))
        .filter((r: any) => r.registration_id && r.team);
      const clearIds = (Array.isArray(body.clear) ? body.clear : []).map((x: unknown) => clean(x, 60)).filter(Boolean);
      if (rows.length) {
        const { error } = await db.from("day2_teams").upsert(rows, { onConflict: "registration_id" });
        if (error) throw error;
      }
      if (clearIds.length) {
        const { error } = await db.from("day2_teams").delete().in("registration_id", clearIds);
        if (error) throw error;
      }
      return json({ ok: true, saved: rows.length, cleared: clearIds.length });
    }

    if (action === "add_player") {
      const player = clean(body.player, 120);
      const cohort = cohortName(body.cohort);
      if (!player || !COHORTS.includes(cohort)) return json({ error: "invalid" }, 400);
      const { data, error } = await db.from("registrations").insert({
        parent: clean(body.parent, 120), email: clean(body.email, 200).toLowerCase(), player, cohort,
        school: clean(body.school, 120) || null,
        package: clean(body.package, 120), signup_type: ["waitlist", "interphase"].includes(clean(body.signup_type, 20)) ? clean(body.signup_type, 20) : "reserve",
        source: "admin", notes: clean(body.notes, 500) || null,
        skill_level: cohort === U10 ? skillLevel(body.skill_level) : null,
      }).select("id").single();
      if (error) throw error;
      return json({ ok: true, id: data.id });
    }

    if (action === "update_player") {
      const id = clean(body.id, 60);
      if (!id) return json({ error: "invalid" }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.paid === "boolean") patch.paid = body.paid;
      if (typeof body.interphase_addon === "boolean") patch.interphase_addon = body.interphase_addon;
      if (body.status === "active" || body.status === "cancelled") patch.status = body.status;
      if (body.signup_type === "reserve" || body.signup_type === "waitlist" || body.signup_type === "interphase") patch.signup_type = body.signup_type;
      if (typeof body.cohort === "string" && COHORTS.includes(cohortName(body.cohort))) patch.cohort = cohortName(body.cohort);
      if (typeof body.notes === "string") patch.notes = clean(body.notes, 500);
      if (body.skill_level !== undefined) patch.skill_level = skillLevel(body.skill_level);
      if (body.day1_group === "am" || body.day1_group === "pm" || body.day1_group === null) patch.day1_group = body.day1_group;
      if (Array.isArray(body.extra_sessions)) patch.extra_sessions = body.extra_sessions.map((x) => clean(x, 20)).filter((k) => SESSIONS.some((s) => s.key === k.replace(/^-/, "")));
      if (typeof body.player === "string" && clean(body.player, 120)) patch.player = clean(body.player, 120);
      if (typeof body.school === "string") patch.school = clean(body.school, 120) || null;
      if (typeof body.parent === "string") patch.parent = clean(body.parent, 120);
      if (typeof body.email === "string") patch.email = clean(body.email, 200).toLowerCase();
      if (!Object.keys(patch).length) return json({ error: "nothing_to_update" }, 400);
      const { error } = await db.from("registrations").update(patch).eq("id", id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
