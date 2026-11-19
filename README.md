# Phase Play

Michael Nunes presents Phase Play — a mandatory two-day basketball camp, $150, Mon Nov 23 & Tue Nov 24, 2026, at Athletic Club of Bend.

## Site

- `index.html` is the whole site (single file, exported from Muse).
- The reserve form is a Netlify Form named `phase-play-reserve`. It submits via POST to `/` and shows "Thanks for joining!" on submit.
- Enrollment counts live in the JSON block with `id="phase-play-enrollments"` inside `index.html`. Update those numbers there, and the page counters, cohort buttons, and waitlist logic follow.
  - Current counts: 5th/6th Girls 3/12, 5th/6th Boys 11/12, 7th/8th Girls 9/12, 7th/8th Boys 10/12 — 27 of 48 (7/8 Girls includes +1 added by hand via "extra" in the JSON; 5/6 Girls has extra -1 so it shows 3 of 12 with 4 sign-ups, one of them a duplicate of Jade Martinez; 5/6 Boys has extra -1 so it shows 11 of 12 with 12 signed up, opening 1 spot; 7/8 Boys has extra -2 so it shows 10 of 12 with 12 actually signed up, opening 2 spots; live sign-ups add on top) total.
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
