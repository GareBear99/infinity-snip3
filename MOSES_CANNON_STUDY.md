# Moses Laser Cannon — study (when it goes off and how)

Date: 2026-11-17. File: `audio/the-moses-laser-cannon-182841.mp3` (MP3, 44.1 kHz stereo,
256 kbps, 649,508 bytes, **20.297 s**). Boot sound, `BOOT_SOUND_SRC` (index.html:1489).

## When it goes off

- **NOT on page load.** The page boots into `BOOT_WAIT` ("PRESS ANYTHING TO POWER ON").
  The cannon only starts on the **first user gesture** — pointerdown / keydown, once
  (`firstInteraction()` → `unlockAudio()` + `startBoot()`). This is the autoplay-policy
  gate: audio is locked until a gesture, and `playWithRetry` queues plays until
  `_audioUnlocked`.
- `startBoot()` sets `bootT0 = performance.now()` and fires the play request at t=0
  (`playWithRetry(bootAudioEl, 'boot', { attempts: 10, delayMs: 120, tag: 'MOSES_BOOT' })`).
  Audible sound can lag t=0 by the play-promise/decode time (up to ~1.2 s of retries
  in a bad case). The boot screen's clock (`t` in `drawBootScreen`) starts at the play
  *request*, not at first audible sound.
- The file itself starts with **~0.5 s of digital silence** (RMS 0.000 for the first
  two 0.25 s windows). So even after the gesture, nothing is heard for the first
  half-second.
- `onended` fires at ~20.3 s → `goMenu()` (always past `BOOT_MIN_DURATION_MS` = 5200 ms).
  Fail-safe: duration×1000 + 750 ≈ 21.05 s. So the boot screen lasts **~20.3 s**.
- Menu music starts only after the cannon ends (`scheduleMenuMusicAfterBoot()`, called
  from `goMenu()`; it defers on the boot element's `ended` event, 4500 ms failsafe).

## How it goes off (measured energy envelope, 0.25 s RMS)

| Time | RMS | What it is |
|---|---|---|
| 0.00–0.50 s | 0.000 | **Silence** (leading) |
| 0.50–1.25 s | 0.063 / 0.037 / 0.066 (peak ~0.46) | First zap / charge burst |
| 1.25–2.00 s | 0.014–0.016 | Quiet |
| 2.00–2.75 s | 0.025 / 0.089 / 0.047 (peak ~0.48) | Second zap burst |
| 2.75–4.25 s | 0.005–0.023 | Near-silence |
| 4.25–4.75 s | 0.039 / 0.025 | Third small burst |
| 4.75–8.25 s | 0.010 → 0.038 | Low rumble, slowly building |
| 8.25–12.25 s | 0.038 → 0.119 | Steady build |
| **12.25–13.00 s** | **0.337, peak 0.977** | **THE BLAST — the cannon going off** (3.6× overall RMS) |
| 13.00–16.00 s | 0.258 → 0.021 | Decay |
| 16.50–20.30 s | ~0.000 | **Silence** (trailing, ~3.8 s) |

Overall RMS 0.094, peak 0.977. So the cannon is: silence, a few zaps, a slow
8-second build, **one big blast at ~12.25 s**, a decay, then ~3.8 s of dead air
before the file ends and the menu appears.

## How the sign currently responds (the mismatch Gary spotted)

- The boot screen's neon sign ("NEO-VECTR INC" tube lettering) uses
  `power = clamp(ramp * flick + beat, 0, 1.25)` in `drawBootScreen`.
- `ramp = smoothstep(0.0, 1.1, t)` is **pure wall-clock time**: the sign is fully
  "on" after 1.1 s — i.e. during the file's opening silence and first zap, before
  the sound has really started. It then just sits lit for the remaining ~19 s.
- `beat = 0.40*bootFlash + 0.25*bootEnergySm` is the only audio term, and it is small.
  The blast at 12.25 s barely registers on the sign.
- The analyser (`bootAnalyser`, fftSize 2048) measures the **real** audio output, so
  `computeBootEnergy()` (average of the first 28 frequency bins, dB-scaled 0–255)
  already tracks the sound: ~0.02 in silence, ~0.55–0.67 during the build,
  ~0.92 at the blast. Measured analyser-equivalent values per 0.5 s window:
  silence 0.02, zaps 0.34–0.75, build 0.55–0.67, blast 0.92, decay 0.85→0.73,
  trailing silence → 0.02.
- Because the analyser values are dB-compressed, a linear gain cannot separate the
  build from the blast (ratio only ~1.4×). The sign drive therefore uses a cubic
  curve — `pow(energy, 3) * 1.4` — which maps: silence ~0, zaps 0.05–0.59, build
  0.23–0.42 (dim glow), blast 1.0 (full flare), decay 0.86→0.54, trailing silence ~0.

## What changed (grounded in this study)

- The sign's turn-on ramp is now driven by the cannon's real analyser energy instead
  of the fixed 1.1 s time ramp: the sign stays dim until the sound actually starts,
  flickers with the zaps, glows dimly through the build, flares to full at the
  ~12.25 s blast, and dies with the sound in the trailing silence.
- Fast attack / slow release (peak hold, ×0.985/frame): the tubes light with the
  sound and hold their glow between zaps instead of snapping black.
- No analyser (WebAudio unavailable) → falls back to the old time ramp, so the sign
  still turns on.
- The subtitle / tagline / boot-status text alphas ride the same audio-gated ramp,
  so they no longer appear before the sound starts.
- The sign's look is unchanged (tube lettering, purple shell, palette) — only how
  it turns on / follows the sound changed.
