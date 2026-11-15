import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Phase Play backend (Supabase project "phase-play").
// Public:        register, counts, activity (totals + anonymous feed for the main page)
// Player link:   ip_load, ip_save            (token from the player's private Interphase link)
// Coach code:    admin, save_teams, add_player, update_player, ip_admin
const COHORTS = ["5th/6th Girls", "5th/6th Boys", "7th/8th Girls", "7th/8th Boys"];
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
function newToken(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
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
  const dayAgo = Date.now() - 48 * 60 * 60 * 1000; // "recent" window: 48 hours
  const out: Record<string, { enrolled: number; recent: string[] }> = {};
  for (const c of COHORTS) out[c] = { enrolled: 0, recent: [] };
  for (const r of data ?? []) {
    const o = out[r.cohort];
    if (!o) continue;
    o.enrolled++;
    if (Date.parse(r.created_at) >= dayAgo) o.recent.push(r.created_at);
  }
  return out;
}

// Look up the player behind an Interphase link token.
async function playerForToken(token: unknown) {
  const t = clean(token, 64);
  if (t.length < 20) return null;
  const { data } = await db.from("interphase_access")
    .select("registration_id, active, registrations(player, cohort, status)")
    .eq("token", t).maybeSingle();
  if (!data || !data.active) return null;
  const reg = (data as any).registrations;
  if (!reg || reg.status === "cancelled") return null;
  return { id: data.registration_id as string, player: reg.player as string, cohort: reg.cohort as string };
}

// Make sure every active, reserved player has an Interphase link.
async function ensureTokens() {
  const { data: regs, error } = await db.from("registrations").select("id").eq("status", "active").eq("signup_type", "reserve");
  if (error) throw error;
  const { data: have } = await db.from("interphase_access").select("registration_id");
  const got = new Set((have ?? []).map((r) => r.registration_id));
  const rows = (regs ?? []).filter((r) => !got.has(r.id)).map((r) => ({ registration_id: r.id, token: newToken() }));
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
    db.from("interphase_sessions").select("registration_id, block_key, session_no, updated_at")
      .not("completed_on", "is", null).in("registration_id", ids),
    db.from("test_results").select("registration_id, created_at").in("registration_id", ids),
  ]);
  if (sErr) throw sErr;
  if (tErr) throw tErr;
  const who = (id: string) => { const c = cohortOf.get(id) ?? ""; return (size[c] ?? 0) >= 3 ? c : ""; };
  const players = new Set<string>();
  const feed: { kind: string; cohort: string; block?: string; session?: number; at: string }[] = [];
  for (const s of sess ?? []) {
    players.add(s.registration_id);
    feed.push({ kind: "session", cohort: who(s.registration_id), block: s.block_key, session: s.session_no, at: s.updated_at });
  }
  for (const t of tests ?? []) {
    players.add(t.registration_id);
    feed.push({ kind: "test", cohort: who(t.registration_id), at: t.created_at });
  }
  feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { sessions: sess?.length ?? 0, players: players.size, tests: tests?.length ?? 0, feed: feed.slice(0, 6) };
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
      const cohort = clean(body.cohort, 40);
      if (!player || !COHORTS.includes(cohort)) return json({ error: "invalid" }, 400);
      const signup_type = clean(body.signup_type, 20) === "waitlist" ? "waitlist" : "reserve";
      const { error } = await db.from("registrations").insert({
        parent: clean(body.parent, 120), email: clean(body.email, 200).toLowerCase(), player, cohort,
        package: clean(body.package, 120), signup_type, source: "site",
      });
      if (error) throw error;
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
          .select("block_key, session_no, completed_on, drills, test_score, notes")
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

    // ---- Coach backend (code required) ----
    const denied = await checkCode(body.code);
    if (denied) return denied;

    if (action === "admin") {
      const { data: regs, error } = await db.from("registrations")
        .select("id, created_at, parent, email, player, cohort, package, signup_type, status, paid, notes, source")
        .eq("is_test", false)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const { data: teams, error: tErr } = await db.from("day2_teams").select("registration_id, team");
      if (tErr) throw tErr;
      return json({ registrations: regs ?? [], teams: teams ?? [] });
    }

    if (action === "ip_admin") {
      await ensureTokens();
      const { data: access, error } = await db.from("interphase_access").select("registration_id, token, active, last_opened_at");
      if (error) throw error;
      const { data: sess, error: sErr } = await db.from("interphase_sessions").select("registration_id, block_key, session_no, completed_on, test_score");
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
      const cohort = clean(body.cohort, 40);
      if (!player || !COHORTS.includes(cohort)) return json({ error: "invalid" }, 400);
      const { data, error } = await db.from("registrations").insert({
        parent: clean(body.parent, 120), email: clean(body.email, 200).toLowerCase(), player, cohort,
        package: clean(body.package, 120), signup_type: clean(body.signup_type, 20) === "waitlist" ? "waitlist" : "reserve",
        source: "admin", notes: clean(body.notes, 500) || null,
      }).select("id").single();
      if (error) throw error;
      return json({ ok: true, id: data.id });
    }

    if (action === "update_player") {
      const id = clean(body.id, 60);
      if (!id) return json({ error: "invalid" }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.paid === "boolean") patch.paid = body.paid;
      if (body.status === "active" || body.status === "cancelled") patch.status = body.status;
      if (body.signup_type === "reserve" || body.signup_type === "waitlist") patch.signup_type = body.signup_type;
      if (typeof body.cohort === "string" && COHORTS.includes(body.cohort)) patch.cohort = body.cohort;
      if (typeof body.notes === "string") patch.notes = clean(body.notes, 500);
      if (typeof body.player === "string" && clean(body.player, 120)) patch.player = clean(body.player, 120);
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
