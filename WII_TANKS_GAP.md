# Wii Play Tanks — gap assessment for Infinity Snip3 main play

Date: 2026-11-17. Design direction (Gary): "infinity snipe is supposed to be like
the wii tank game in the main play" — Wii Play Tanks (Tanks! mini-game) is the
reference for the main play.

## What Wii Play Tanks is

Top-down arena tank combat. You drive a small tank (move + aim independently),
fire shells that ricochet off walls with a limited number of bounces, and destroy
enemy tanks that spawn in waves across 20 levels. Enemy types behave differently
(basic, fast, multi-shot, armoured, mine-laying). One hit kills YOUR tank; you
have limited lives. Banked shots around corners are the core skill. The feel is
clean and quiet: a small plink on a bounce, a modest puff on a kill, no
screen-filling effects. No trails. Rectangular block-wall arenas.

## What Snip3 main play (SNIP3 mode) is today

- 1 player, keyboard/mouse (WASD move, mouse aim, click/Space fire) + gamepad.
  Shift dash, hold-to-charge shot (0.85 s).
- Fires lasers that ricochet off barriers (1 per pie-slice) and screen edges:
  2 bounces, 3rd collision explodes.
- Player leaves a neon trail (visual only, 32 points — Tron look, not gameplay).
- **No enemies at all.** No enemy spawn, no AI, no waves, no levels anywhere
  in the code. The only threat is your own ricocheting laser.
- **No objective.** Score (0) and lives (3) exist as fields but are never read
  or changed — dead code. No win, no game over.
- **Self-hit is not lethal.** Your own laser hitting you after a bounce triggers
  an explosion + a 12-mini-laser spray, but you survive (no alive=false, no
  lives lost). In Wii Tanks your own ricochet kills you.
- VS mode (2–4 players, last alive wins) is the closest thing to tank combat,
  but it is player-vs-player, not the main play.

## What already matches Wii Tanks

- Top-down arena, independent move + aim (twin-stick feel).
- Projectiles ricochet off obstacles and walls; bounce limit; banked shots.
- VS mode is tank-vs-tank combat.
- The ricochet tone-down in this batch follows the Wii Tanks feel: a bounce is
  now a small pale-cyan glint + a soft throttled tick, and the big explosion
  (with the zap sound) is reserved for the final collision, elimination, and
  self-hit — modest, not constant orange blasts.

## The gap (biggest first)

1. **No enemies, no levels.** The main play has nothing to shoot at and nowhere
   to progress to. This is the whole game in Wii Tanks.
2. **Lives/score don't work.** One-hit death + limited lives is the Wii Tanks
   stakes; here the fields are dead.
3. **Self-hit isn't lethal.** Your own ricochet should be able to kill you.
4. **Arena shape.** Pie-slice radial barriers vs Wii Tanks' rectangular block
   walls and room layouts.
5. **Trails + neon density.** The Tron trail and heavy particles are the opposite
   of Wii Tanks' clean toy look (visual only, no gameplay effect).
6. **Dash + charge shot.** Wii Tanks has neither; tanks move at one steady speed
   and fire one shell at a time.

## What it would take to close the gap (for Gary to decide — NOT built in this batch)

- Enemy tank AI + enemy types (basic / fast / multi-shot / armoured / mine-laying),
  spawning in waves.
- A levels system (arena layout + enemy composition per level, clear-to-advance).
- Lives + score wired up (one hit kills, limited lives, game over, score per kill).
- Self-hit = death.
- Arena layouts (rectangular block walls) per level.
- Optional: drop the trail and the dash/charge to match the Wii Tanks feel.
  These are feel decisions, not correctness — Gary's call.

This batch deliberately stays at feel/tuning only (ricochet effect, explosion
size, sound repetition). No enemy AI, no levels system, no trail removal, no
gameplay-rule changes were made.
