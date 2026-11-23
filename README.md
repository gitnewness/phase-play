# Phase Play

Michael Nunes presents Phase Play — a mandatory two-day basketball camp, $150, Mon Nov 23 & Tue Nov 24, 2026, at Athletic Club of Bend.

## Site

- `index.html` is the whole site (single file, exported from Muse).
- The reserve form is a Netlify Form named `phase-play-reserve`. It submits via POST to `/` and shows "Thanks for joining!" on submit.
- Enrollment counts live in the JSON block with `id="phase-play-enrollments"` inside `index.html`. Update those numbers there, and the page counters, cohort buttons, and waitlist logic follow.
  - Current counts: 10 & Under 4/14 (new game-day-only product, $50, replaced 5th/6th Girls on the site; experience level 1–3 in registrations.skill_level; real sign-ups: Jade Martinez (moved from 5th/6th Girls) and Benicio Nunes (moved from Interphase only), plus +2 added by hand via "extra" (one is Billy Nunes, who stays registered in 5th/6th Boys); Emery Tapia (refunded) and Braydee Serbus (injured) were cancelled 2026-11-19), 5th/6th Boys 12/12 (full, waitlist), 7th/8th Girls 9/12, 7th/8th Boys 12/12 (full, waitlist) — of 50 (7/8 Girls includes +1 added by hand via "extra" in the JSON; 5/6 Boys is full (13 signed up, extra -1); 7/8 Boys is full (13 signed up, extra 0); live sign-ups add on top) total.
  - A cohort at 12/12 automatically switches to a waitlist signup.

## Editing with Claude Code

1. Clone this repo, open it in Claude Code.
2. Edit `index.html` directly. Keep the copy, pricing ($150 camp, $200 with film breakdown, $35 Training to Test only), dates, and cohort names exactly as they are unless Michael asks for a change.
3. Never use the word "Blended" for cohorts.
4. Deploy to Netlify (see below) to test form submissions — Netlify Forms only capture submissions on a deployed Netlify site, not from a local preview.

## Deploy to Netlify

Option A — Netlify dashboard: drag the repo folder, or connect the GitHub repo and set publish directory to `.` (see `netlify.toml`).

Option B — Netlify CLI:
```
netlify deploy --prod
```

Form submissions will appear in Netlify under Site settings > Forms.

## Camp check-in (QR code at the door)

- Parents scan the QR code (`images/check-in-qr.png` / `.svg`, printable sign at `/check-in/sign.html`) and land on `/check-in/`. The page shows the session running now first (from 45 minutes before it starts), with the other sessions below. Tap a name, take a photo of the player (required; the phone shrinks it to 1024px JPEG, no location data), tap check in. Public lists show first name + last initial only.
- Photos go to the private Storage bucket `check-in-photos` (`<session>/<registration id>.jpg`, path in `check_ins.photo_path`). The coach board shows them through 1-hour signed links; Undo deletes the photo too. Delete the bucket's files after camp.
- Lists come live from `registrations` (active, `signup_type = reserve`, not test). Sessions and who belongs in each are defined in `SESSIONS` / `inSession()` in the edge function.
  - Day 1 7th/8th Boys morning vs afternoon: `registrations.day1_group` (`am` / `pm`). A boy with no group shows on both Day 1 lists until set (coach screen → Check-in tab → AM / PM).
  - A player in an extra session: `registrations.extra_sessions` (Billy Nunes has `{d2-u10}`).
- Check-ins are rows in `check_ins` (one per player per session, unique, so a second tap does not double count). RLS is on with no policies: the browser only reaches it through the edge function (`checkin_roster`, `check_in` public; `checkin_admin`, `checkin_undo` behind the coach code).
- Coach board: coach screen → Check-in tab, or open `phaseplayhoops.com/#checkin`. Refreshes every 10 seconds; Undo removes a check-in.

## Day 2 ranks & teams (coach only until published)

- Coach screen → **Ranks & teams** tab. One card per Day 2 game (7th/8th Boys round robin, 7th/8th Girls, 10 & Under, 5th/6th Boys).
- Rank players 1–N: drag the ≡ handle (desktop), type a number, or use ▲▼ (phone). **Snake draft** deals teams in rank order 1-2-3, 3-2-1, … (3 teams for the 7th/8th Boys round robin, 2 for the other games). Move players by dragging between teams or with the T1/T2/T3 picker. **Save**, then **Publish to parents**.
- Data: `game_ranks`, `game_teams`, `game_publish` (RLS on, no policies; edge function actions `teams_admin`, `teams_save`, `teams_publish`).
- Parents: each family's private link `phaseplayhoops.com/team/<name>#k=<code>` (same code as the player's Interphase link; copy it from "Parent team links" on each card). `my_team` shows only that player's own team and game times, and only for published games. The round robin shows the two games that team plays and the opponent.
