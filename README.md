# Phase Play

Michael Nunes presents Phase Play — a mandatory two-day basketball camp, $150, Mon Nov 23 & Tue Nov 24, 2026, at Athletic Club of Bend.

## Site

- `index.html` is the whole site (single file, exported from Muse).
- The reserve form is a Netlify Form named `phase-play-reserve`. It submits via POST to `/` and shows "Thanks for joining!" on submit.
- Enrollment counts live in the JSON block with `id="phase-play-enrollments"` inside `index.html`. Update those numbers there, and the page counters, cohort buttons, and waitlist logic follow.
  - Current counts: 9 & Under 3/14 (new game-day-only product, $50, replaced 5th/6th Girls on the site; Emery Tapia, Braydee Serbus and Jade Martinez were moved over from 5th/6th Girls on 2026-11-19 and Jade's duplicate was marked cancelled; asks experience level 1–3, stored in registrations.skill_level), 5th/6th Boys 12/12 (full, waitlist), 7th/8th Girls 9/12, 7th/8th Boys 12/12 (full, waitlist) — of 50 (7/8 Girls includes +1 added by hand via "extra" in the JSON; 5/6 Boys is full (13 signed up, extra -1); 7/8 Boys is full (13 signed up, extra 0); live sign-ups add on top) total.
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
