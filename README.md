# pixel-maker

Turn AI-generated "pixel-art-looking" images into actual pixel art — in the
browser, with no upload and no build step.

AI image generators produce pictures that *look* like pixel art but are not:
the cells are not aligned to a grid, the cell size is not an integer, edges
carry anti-aliased sub-pixels, and flat areas are full of near-duplicate
colours. This tool finds the underlying grid, snaps to it, and rebuilds the
image as real dots with a real palette.

Live: https://holometer.net/pixel-maker/

**Everything runs client-side.** No server, no framework, no bundler — open
`index.html` and it works. Images never leave the browser.

## Why this repo exists

There are several good pixel-art correction projects (see `NOTICE.md`). What
seemed missing was a way to tell whether a change actually *helps*. So this
repo also ships **an accuracy bench**: fixtures with exact known dot counts,
driven through the real UI, reporting hit rates. Every claim below is a
number the bench produced, not an impression.

## How it works

1. **Quantise** the image to ≤16 colours (`gridAnalysisPixels`) so cell
   boundaries dominate over texture.
2. **Boundary energy profiles** per axis: `|g(x+1) − g(x−1)|` summed down
   each column and across each row (`gridProfiles`).
3. **Estimate the period** by autocorrelation of those profiles
   (`estimateGridStepByPeriod`), falling back to peak-spacing median.
4. **Walk the cuts** (`walkGridCuts`), then **stabilise** them onto a uniform
   lattice (`stabilizeGridAxes`) and **merge partial edge cells**
   (`mergeEdgeGridCells`).
5. **Vote per cell** — the modal colour of each cell becomes that dot.
6. **Build a palette** (adaptive / median-cut), merge perceptually identical
   entries in **OkLab**, then map every dot through it.

Optional: console palettes (Famicom / Super Famicom RGB555 / Game Boy),
custom palettes, output sizes 16–512, and ZIP batch export.

## Accuracy bench

```bash
python3 tests/make_pixel_fixtures.py   # writes tests/pixel_fixtures/ + expected.json
python3 -m http.server 8899            # from the repo root
open http://localhost:8899/tests/pixel_grid_bench.html
```

The bench loads the **real** `index.html` in an iframe and pushes each fixture
through the actual file input, so its numbers always match what the tool
shows. Keep the tab in the foreground — `requestAnimationFrame` is throttled
in background tabs and the conversion will not advance.

Query parameters: `?style=auto|refine|craft|…` and `?set=real|verified` (for
your own image sets placed in `tests/pixel_real/` etc.).

Current results on the 22 synthetic fixtures:

| mode | exact | within ±5% |
|---|---|---|
| `auto` | 17/22 | 19/22 |
| `refine` | 4/22 | 18/22 |

**Read this before trusting those numbers.** Synthetic fixtures are drawn
with a perfect lattice, so they reward exactly the thing the algorithm
assumes. A change that improves the synthetic score can still make real
AI-generated images worse — that has happened here more than once. Always
check a set of real images too.

Known failures: images whose true grid is very coarse (~16 dots) can be
detected at roughly 2× the true count, and one real test image is detected
at exactly 2×. Both are harmonic-selection errors.

## What we tried and reverted

Kept here so nobody re-runs the same experiment.

- **Comb-minus-anti-comb scoring + subharmonic suppression**, ported from
  pixel-art-fixer. Synthetic `refine` improved 4→5 exact, but real images got
  *worse* (5/10 → 4/10 within ±5%), including one image going from −3.6% to
  −38%. The reason: that score assumes the profile is an impulse train
  (pixel-art-fixer builds it from |2nd difference| maps projected over
  bands). Our profile is smooth, so the anti-comb samples stay high near the
  true period and the score drifts toward larger steps. **Adopting the score
  requires adopting their profile construction too.** That is the most
  promising open direction in this repo.
- **Full-interval-centroid peak detection** — synthetic 10→17 within 5%, but
  a verified real image went 251→223.
- **Harmonic-consistency selection** — synthetic 18→17, one real image
  246→98.

## Contributing

Any change to grid detection must come with bench numbers before and after,
on both the synthetic fixtures *and* a set of real images. A change that only
improves synthetic scores will be asked for real-image numbers.

## License

MIT — see `LICENSE`. Third-party code and prior art: `NOTICE.md`.
