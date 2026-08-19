# Third-party code and prior art

## Bundled

- **fflate** (MIT) — `vendor/fflate.js`, used for ZIP batch export.
  License text: `vendor/fflate.LICENSE.txt` · https://github.com/101arrowz/fflate

## Prior art we studied

No code was copied from these projects. They are listed because they shaped
our approach, and because anyone working on this problem should read them.

- **Sprite Fusion — Pixel Snapper** (https://www.spritefusion.com/pixel-snapper)
  The idea of treating grid stabilisation as a first-class step (snap the
  detected cut positions onto a uniform lattice instead of trusting each cut)
  became our `stabilizeGridAxes` / `snapUniformGridCuts`.

- **Retro-Diffusion / pixel-art-fixer** (MIT) —
  https://github.com/Retro-Diffusion/pixel-art-fixer
  The strongest period estimator we have read. Two ideas we tried to adopt:
  a comb-minus-anti-comb score over autocorrelation multiples, and
  subharmonic suppression at selection time. See "What we tried and
  reverted" in README.md for the measured result.

- **marksverdhei / spritegrid** (MIT) — https://github.com/marksverdhei/spritegrid
  Geometric median (Weiszfeld) for picking a cell's representative colour,
  which is more outlier-resistant than a mean. Not yet implemented here.

- **HappyOnigiri / PixelRefiner** (MIT) —
  https://github.com/HappyOnigiri/PixelRefiner
  The closest peer to this project: same problem, same in-browser
  constraint. Two ideas we acted on. Its cell sampler restricts the
  representative-colour population to the cell core because boundary pixels
  are blended with the neighbour — that is the fix for our black bleeding.
  Its grid search also runs five separate signals (colour boundary,
  luminance/alpha, autocorrelation, reconstruction error, local phase) and
  uses reconstruction error to arbitrate harmonics, rather than penalising
  them unconditionally as we first tried.

- **univeous / Pixel-Extractor** (MIT) — https://github.com/univeous/Pixel-Extractor
  Handles non-square pixel cells. Not yet implemented here.
