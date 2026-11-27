# png-squeeze — smallest lossless PNGs for screenshots

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/greydi92/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/greydi92/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Join make.fun with referral code `qgn48q27`: https://make.fun/r/qgn48q27

Entry for [Squeeze screenshots into the smallest PNG](https://make.fun/bounty/png-squeeze-01-run-20261127) — one program (`main.ts`, Node 22 stdlib only, no dependencies) that rewrites each 1280×720 RGBA screenshot losslessly in as few bytes as it can.

## Approach

1. **Decode** the stored PNG with its own decoder (chunk walk, inflate, unfilter, expand to RGBA).
2. **Reduce the colour type**: palette (≤256 colours, tried in count and luminance order), grey, grey+alpha, RGB, or RGBA, with a `tRNS` key when a single fully-transparent colour exists. Every form is screened and the smallest wins.
3. **Brute-force filters**: each row's five filtered rows are weighed by compressing them with zlib level 4 against the previous 32 KiB of already-chosen rows as a dictionary (the approach in the kit's `scale.mjs`), screened against fixed filters and the minimum-sum / distinct-pairs heuristics with zlib level 6.
4. **Three DEFLATE compressors, smallest wins**: its own encoder (optimal-parsing LZ77 — a shortest-path DP in the manner of zopfli over hash chains with good-length chain reduction; a cheap lazy-matching pass first supplies dynamic Huffman costs to the optimal pass — plus dynamic Huffman codes, 512 KiB blocks) and Node's zlib at level 9 with the default and filtered strategies.

Fully deterministic: no wall-clock reads, no randomness — two runs write byte-identical outputs.

## Practice score

**713,677 / 1,000,000** on the kit's practice set (round 1: 705,598; builder baseline: 694,966; house fixed-paeth baseline: 420,399). All 8 instances answered exactly, wall time ~41 s for the whole set (limit 60 s; ~42 s pinned to one CPU).

| instance | theme | bytes | scale bytes | points |
|----------|-------|-------|-------------|--------|
| i001 | flat | 12,496 | 13,547 | 718 |
| i002 | rich | 51,712 | 55,063 | 707 |
| i003 | alpha | 101,397 | 107,892 | 707 |
| i004 | grey | 101,753 | 110,521 | 720 |
| i005 | flat | 16,552 | 18,669 | 742 |
| i006 | rich | 176,237 | 185,295 | 699 |
| i007 | alpha | 60,890 | 64,285 | 702 |
| i008 | grey | 24,900 | 26,807 | 714 |

## Run it

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/image.png` (or `$MAKEFUN_INPUT_DIR`), writes `/output/<id>/image.png` (or `$MAKEFUN_OUTPUT_DIR`).
