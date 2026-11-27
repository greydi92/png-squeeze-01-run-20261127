// png-squeeze: a lossless PNG optimizer for make.fun's "Squeeze screenshots into
// the smallest PNG" bounty (https://make.fun/bounty/png-squeeze-01-run-20261127).
//
// One program, one run, 8 screenshots (1280x720 RGBA): it decodes each stored PNG,
// reduces the colour type (palette / grey / grey+alpha / RGB / RGBA, with a tRNS
// key when a single transparent colour exists), picks each row's filter by the
// brute force (each row's five filtered rows weighed by compressing them
// with zlib level 4 against the previous 32 KiB of chosen rows as a
// dictionary, after the kit's scale.mjs; screened against fixed filters and
// the minimum-sum / distinct-pairs heuristics with zlib level 6), and
// compresses the result with the smallest of three DEFLATE streams: its own
// encoder (optimal-parsing LZ77, shortest-path DP in the manner of zopfli,
// over hash chains with good-length chain reduction, plus dynamic Huffman
// codes, in fixed-size blocks, a lazy pass feeding dynamic costs to the
// optimal pass) and
// Node's zlib at level 9 with the default and filtered strategies. Node 22
// stdlib only, no dependencies, deterministic.
//
// How it is run:  node main.ts   (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// override /input and /output). No network, no wall-clock reads: every budget
// is by work size, so two runs write byte-identical outputs.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as ZC, deflateSync, inflateSync } from 'node:zlib';

const WIDTH = 1280;
const HEIGHT = 720;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG writing
// ---------------------------------------------------------------------------

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------------------
// PNG decoding (my own decoder: chunk walk, inflate, unfilter, expand to RGBA)
// ---------------------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function decodePng(bytes: Uint8Array): Decoded {
  if (bytes.length < 8) throw new Error('png too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('bad png signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' crc');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png form');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete png');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  if (bpp === undefined) throw new Error('bad colour type');
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflate length mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else {
      throw new Error('bad filter ' + ft);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette png without PLTE');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// PNG row filters
// ---------------------------------------------------------------------------

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) {
      out.set(cur);
    } else {
      for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    }
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed (-128..127), absolute value.
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Image analysis: opaque? grey? at most 256 colours? single transparent key?
// ---------------------------------------------------------------------------

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null;
  key: number | null; // single fully-transparent RGB/grey value usable as a tRNS key
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = (rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24)) >>> 0;
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, 1);
      } else {
        counts.set(w, k + 1);
      }
    }
  }
  // The one fully transparent value the image may key by tRNS instead of an
  // alpha channel: every non-opaque pixel is exactly that value at alpha 0,
  // and no opaque pixel shares its RGB/grey value.
  let key: number | null = null;
  if (!opaque) {
    let k = -1;
    let ok = true;
    for (let d = 0; d < rgba.length; d += 4) {
      const a = rgba[d + 3];
      if (a === 255) continue;
      if (a !== 0) {
        ok = false;
        break;
      }
      const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
      if (k === -1) k = v;
      else if (k !== v) {
        ok = false;
        break;
      }
    }
    if (ok && k !== -1) {
      for (let d = 0; d < rgba.length; d += 4) {
        if (rgba[d + 3] !== 255) continue;
        const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
        if (v === k) {
          ok = false;
          break;
        }
      }
      if (ok) key = k;
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [];
    for (const [w, count] of counts) {
      colours.push({
        r: w & 0xff,
        g: (w >>> 8) & 0xff,
        b: (w >>> 16) & 0xff,
        a: (w >>> 24) & 0xff,
        word: w,
        count,
      });
    }
  }
  return { opaque, grey, colours, key };
}

// ---------------------------------------------------------------------------
// Forms: one way of writing the image exactly, as samples + colour type.
// ---------------------------------------------------------------------------

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  strategies: string[]; // filter strategies to screen for this form
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance'): Form {
  const lum = (c: Colour) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const w = (rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24)) >>> 0;
    indices[i] = index.get(w) as number;
  }
  return {
    colourType: 3,
    bpp: 1,
    samples: indices,
    plte,
    trns,
    strategies: order === 'count' ? ['0', 'minsum', 'brute'] : ['0', 'minsum', 'pairs', 'brute'],
  };
}

function formsOf(rgba: Uint8Array, an: Analysis): Form[] {
  const forms: Form[] = [];
  if (an.colours !== null) {
    forms.push(paletteForm(rgba, an.colours, 'count'));
    forms.push(paletteForm(rgba, an.colours, 'luminance'));
    if (an.grey) {
      // A grey image with <=256 colours also has a channel form; keep both.
    } else {
      return forms;
    }
  }
  let ct: number;
  let trns: Uint8Array | null = null;
  if (an.grey) {
    ct = an.opaque || an.key !== null ? 0 : 4;
    if (an.key !== null) trns = Uint8Array.of(0, an.key);
  } else {
    ct = an.opaque || an.key !== null ? 2 : 6;
    if (an.key !== null) trns = Uint8Array.of(0, an.key >>> 16, 0, (an.key >>> 8) & 0xff, 0, an.key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    strategies: ['0', '1', '2', '4', 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------------------
// Filter screening: one pass computes all five filtered rows; each strategy
// picks its row. Screened with zlib level 6 (fast, C) including PLTE/tRNS
// chunk bytes, so the winner is the smallest form+filter combination.
// ---------------------------------------------------------------------------

const PAIR_SEEN = new Uint32Array(65536);
let pairStamp = 0; // module-level: never reset per call, or stale stamps from an
// earlier image would make the pairs heuristic count pairs as already seen

function filterForm(form: Form, width: number, height: number): { strategy: string; data: Uint8Array; bytes: number } {
  const bpp = form.bpp;
  const stride = width * bpp;
  const rowLen = stride + 1;
  const size = height * rowLen;
  const strategies = form.strategies;
  const bufs = strategies.map(() => new Uint8Array(size));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const sums = new Float64Array(5);
  const pairs = new Float64Array(5);
  // Brute-force filter choice (after the kit's scale.mjs): each row's five
  // filtered rows are weighed by compressing them with zlib level 4 against
  // the previous 32 KiB of already-chosen rows as a dictionary.
  const bruteIdx = strategies.indexOf('brute');
  const bruteTrial = Array.from({ length: 5 }, (_, t) => {
    const r = new Uint8Array(stride + 1);
    r[0] = t;
    return r;
  });
  for (let y = 0; y < height; y++) {
    const cur = form.samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : form.samples.subarray((y - 1) * stride, y * stride);
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trial[t]);
    // Costs for the adaptive strategies, computed over the trial rows.
    let minSum = Infinity;
    let minSumT = 0;
    let minPairs = Infinity;
    let minPairsT = 0;
    for (let t = 0; t < 5; t++) {
      const row = trial[t];
      let s = 0;
      for (let i = 0; i < stride; i++) {
        const v = row[i];
        s += v < 128 ? v : 256 - v;
      }
      sums[t] = s;
      if (s < minSum) {
        minSum = s;
        minSumT = t;
      }
      pairStamp++;
      const stamp = pairStamp;
      let p = 0;
      for (let i = 1; i < stride; i++) {
        const pair = (row[i - 1] << 8) | row[i];
        if (PAIR_SEEN[pair] !== stamp) {
          PAIR_SEEN[pair] = stamp;
          p++;
        }
      }
      pairs[t] = p;
      if (p < minPairs) {
        minPairs = p;
        minPairsT = t;
      }
    }
    const at = y * rowLen;
    let bruteT = 0;
    if (bruteIdx >= 0) {
      const before = bufs[bruteIdx].subarray(Math.max(0, at - 32768), at);
      let bestCost = Infinity;
      for (let t = 0; t < 5; t++) {
        bruteTrial[t].set(trial[t], 1);
        const cost = deflateSync(
          bruteTrial[t],
          before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: before },
        ).length;
        if (cost < bestCost) {
          bestCost = cost;
          bruteT = t;
        }
      }
    }
    for (let s = 0; s < strategies.length; s++) {
      const st = strategies[s];
      let t: number;
      if (st === 'minsum') t = minSumT;
      else if (st === 'pairs') t = minPairsT;
      else if (st === 'brute') t = bruteT;
      else t = st.charCodeAt(0) - 48;
      const buf = bufs[s];
      buf[at] = t;
      buf.set(trial[t], at + 1);
    }
  }
  const chunkBytes = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
  let best: { strategy: string; data: Uint8Array; bytes: number } | null = null;
  for (let s = 0; s < strategies.length; s++) {
    const data = bufs[s];
    const z = deflateSync(data, { level: 6, memLevel: 8 });
    const bytes = z.length + chunkBytes;
    if (best === null || bytes < best.bytes) best = { strategy: strategies[s], data, bytes };
  }
  return best as { strategy: string; data: Uint8Array; bytes: number };
}

// ---------------------------------------------------------------------------
// DEFLATE encoder (written from the DEFLATE format itself: RFC 1951).
// Lazy matching over 3-byte hash chains, a second cost-based pass with the
// first pass's Huffman costs, dynamic Huffman codes with length limiting,
// fixed-size blocks. No use of node:zlib's compressor anywhere here.
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Uint16Array(259); // length symbols are 257..285: need 16 bits
const LEN_EBITS = new Uint8Array(259);
const DIST_SYM = new Uint8Array(32769);
const DIST_EBITS = new Uint8Array(32769);
for (let s = 0; s < 29; s++) {
  const base = LEN_BASE[s];
  const next = s === 28 ? 259 : LEN_BASE[s + 1];
  for (let len = base; len < next; len++) {
    LEN_SYM[len] = 257 + s;
    LEN_EBITS[len] = LEN_EXTRA[s];
  }
}
for (let s = 0; s < 30; s++) {
  const base = DIST_BASE[s];
  const next = s === 29 ? 32769 : DIST_BASE[s + 1];
  for (let d = base; d < next; d++) {
    DIST_SYM[d] = s;
    DIST_EBITS[d] = DIST_EXTRA[s];
  }
}

const BLOCK_SIZE = 524288; // one Huffman table per 512 KiB of filtered data
// (measured on the practice set: 256 KiB splits too often for row-repeat
// matches, 1 MiB+ loses adaptivity on alpha images; 512 KiB is the best
// single size, and it beats zlib level 9 overall)
const CHAIN_MAX = 4096; // longest hash chain walked per position (zlib level 9's
// cap; a long cap finds the long row-repeat matches screenshots live on)
const NICE_LEN = 258; // stop the chain walk once a match this good is found
const MAX_DIST = 32768;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

// --- Huffman code construction ----------------------------------------------

interface Huffman {
  lens: Uint8Array; // code length per symbol (0 = unused)
  codes: Uint32Array; // canonical code per symbol, low `lens` bits
}

function canonicalCodes(lens: Uint8Array): Uint32Array {
  let maxLen = 0;
  for (let i = 0; i < lens.length; i++) if (lens[i] > maxLen) maxLen = lens[i];
  const blCount = new Uint32Array(maxLen + 1);
  for (let i = 0; i < lens.length; i++) if (lens[i] > 0) blCount[lens[i]]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(lens.length);
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i];
    if (len > 0) codes[i] = nextCode[len]++;
  }
  return codes;
}

// Length-limited Huffman lengths from symbol frequencies: a heap tree for the
// unconstrained lengths, then a Kraft-sum repair. Clamping a deep leaf to
// `maxBits` over-subscribes the code (Kraft > 1); the repair lengthens the
// least-frequent symbols until the Kraft sum is exactly 1, shortening the
// least-frequent deep symbols back if a lengthen overshoots. Returns null
// when the repair cannot converge (the caller then uses fixed Huffman).
function huffmanLengths(freq: Uint32Array, maxBits: number): Uint8Array | null {
  const n = freq.length;
  const lens = new Uint8Array(n);
  let used = 0;
  let only = -1;
  for (let i = 0; i < n; i++) {
    if (freq[i] > 0) {
      used++;
      only = i;
    }
  }
  if (used === 0) return lens;
  if (used === 1) {
    lens[only] = 1;
    for (let i = 0; i < n; i++) {
      if (i !== only) {
        lens[i] = 1;
        break;
      }
    }
    return lens;
  }
  // Min-heap of tree nodes: leaves 0..n-1, internal nodes n..2n-2.
  const maxNodes = 2 * n;
  const nf = new Float64Array(maxNodes);
  const parent = new Int32Array(maxNodes).fill(-1);
  for (let i = 0; i < n; i++) nf[i] = freq[i];
  const heap = new Int32Array(maxNodes);
  let heapSize = 0;
  const heapPush = (node: number) => {
    let i = heapSize++;
    heap[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nf[heap[p]] <= nf[heap[i]]) break;
      const t = heap[p];
      heap[p] = heap[i];
      heap[i] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    heap[0] = heap[--heapSize];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heapSize && nf[heap[l]] < nf[heap[m]]) m = l;
      if (r < heapSize && nf[heap[r]] < nf[heap[m]]) m = r;
      if (m === i) break;
      const t = heap[m];
      heap[m] = heap[i];
      heap[i] = t;
      i = m;
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) heapPush(i);
  let nodes = n;
  while (heapSize > 1) {
    const a = heapPop();
    const b = heapPop();
    const nd = nodes++;
    nf[nd] = nf[a] + nf[b];
    parent[a] = nd;
    parent[b] = nd;
    heapPush(nd);
  }
  for (let i = 0; i < n; i++) {
    if (freq[i] === 0) continue;
    let d = 0;
    let p = i;
    while (parent[p] !== -1) {
      d++;
      p = parent[p];
    }
    lens[i] = d;
  }
  // Clamp to the limit and repair the Kraft sum to exactly 1 (in units of
  // 2^-maxBits, so every term is an integer).
  let kraft = 0;
  for (let i = 0; i < n; i++) {
    if (lens[i] > maxBits) lens[i] = maxBits;
    if (lens[i] > 0) kraft += 1 << (maxBits - lens[i]);
  }
  const target = 1 << maxBits;
  if (kraft !== target) {
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
    order.sort((a, b) => freq[a] - freq[b] || lens[b] - lens[a]);
    let guard = 0;
    while (kraft !== target) {
      if (++guard > 20000) return null;
      if (kraft > target) {
        const excess = kraft - target;
        let pick = -1;
        let pickStep = 0;
        for (const s of order) {
          if (lens[s] >= maxBits) continue;
          const step = 1 << (maxBits - lens[s] - 1);
          if (step <= excess) {
            pick = s;
            pickStep = step;
            break;
          }
        }
        if (pick === -1) {
          for (const s of order) {
            if (lens[s] < maxBits) {
              pick = s;
              pickStep = 1 << (maxBits - lens[s] - 1);
              break;
            }
          }
        }
        if (pick === -1) return null;
        kraft -= pickStep;
        lens[pick]++;
      } else {
        const gap = target - kraft;
        let pick = -1;
        let pickStep = 0;
        for (const s of order) {
          if (lens[s] <= 1) continue;
          const step = 1 << (maxBits - lens[s]);
          if (step <= gap) {
            pick = s;
            pickStep = step;
            break;
          }
        }
        if (pick === -1) {
          for (const s of order) {
            if (lens[s] > 1) {
              pick = s;
              pickStep = 1 << (maxBits - lens[s]);
              break;
            }
          }
        }
        if (pick === -1) return null;
        kraft += pickStep;
        lens[pick]--;
      }
    }
  }
  return lens;
}

// Fixed Huffman tables (RFC 1951 section 3.2.6).
const FIXED_LIT_LENS = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LENS = new Uint8Array(30).fill(5);
const FIXED_LIT_CODES = canonicalCodes(FIXED_LIT_LENS);
const FIXED_DIST_CODES = canonicalCodes(FIXED_DIST_LENS);

// --- Bit writer ---------------------------------------------------------------

class BitWriter {
  buf: Uint8Array;
  pos = 0;
  bitBuf = 0;
  bitCnt = 0;
  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
  }
  ensure(extra: number): void {
    if (this.pos + extra + 8 > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 1024));
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
  }
  write(bits: number, len: number): void {
    this.bitBuf |= (bits & ((1 << len) - 1)) << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  alignByte(): void {
    if (this.bitCnt > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

// Reverse the low `len` bits (DEFLATE writes Huffman codes MSB-first).
function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// --- Lazy LZ77 parser ---------------------------------------------------------

const HEAD = new Int32Array(HASH_SIZE);
const PREV = new Int32Array(BLOCK_SIZE + 4);
const TVAL = new Uint16Array(BLOCK_SIZE + 4); // literal byte, or match length
const TDIST = new Uint16Array(BLOCK_SIZE + 4); // 0 = literal, else distance

function hash3(d: Uint8Array, i: number): number {
  return ((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK;
}

// Find the longest match at position i (block-local coordinates). Returns
// length, and writes the distance into `foundDist[0]`. The chain walk is
// capped at `chainMax`.
function findLongest(blk: Uint8Array, i: number, end: number, foundDist: Int32Array, chainMax: number): number {
  const maxLen = Math.min(258, end - i);
  if (maxLen < 3) return 0;
  let best = 0;
  let bestDist = 0;
  let cand = HEAD[hash3(blk, i)];
  let chain = chainMax;
  while (cand >= 0 && chain-- > 0) {
    const dist = i - cand;
    if (dist > MAX_DIST) break;
    // Quick reject: to beat `best` the candidate must match at offsets
    // best and best-1 (two bytes: one check alone prunes too little in
    // dense buckets, where most candidates share the first bytes). A
    // candidate failing either cannot beat `best`, so skipping it changes
    // nothing about the match found.
    if (best > 0) {
      if (blk[cand + best] !== blk[i + best] || blk[cand + best - 1] !== blk[i + best - 1]) {
        cand = PREV[cand];
        continue;
      }
    }
    let len = 0;
    while (len < maxLen && blk[cand + len] === blk[i + len]) len++;
    if (len > best) {
      best = len;
      bestDist = dist;
      if (len >= NICE_LEN || len >= maxLen) break;
    }
    cand = PREV[cand];
  }
  foundDist[0] = bestDist;
  return best;
}

interface ParseResult {
  tokens: number;
  litFreq: Uint32Array;
  distFreq: Uint32Array;
}

// Parse one block with lazy matching. `litCost`/`distCost` (code lengths per
// symbol) make the lazy choice cost-based when given; otherwise length wins.
function parseBlock(
  d: Uint8Array,
  start: number,
  end: number,
  litCost: Uint8Array | null,
  distCost: Uint8Array | null,
): ParseResult {
  const n = end - start;
  const blk = d.subarray(start, end);
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  HEAD.fill(-1);
  const fd = new Int32Array(1);
  let t = 0;
  let i = 0;
  // Cached match for i+1 from the previous iteration's lazy lookahead.
  let pendLen = 0;
  let pendDist = 0;
  let pendPos = -1;
  const insert = (p: number) => {
    if (p + 2 < n) {
      const h = ((blk[p] << 10) ^ (blk[p + 1] << 5) ^ blk[p + 2]) & HASH_MASK;
      PREV[p] = HEAD[h];
      HEAD[h] = p;
    }
  };
  while (i < n) {
    let len1: number;
    let dist1: number;
    if (pendPos === i) {
      len1 = pendLen;
      dist1 = pendDist;
      pendPos = -1;
    } else {
      len1 = findLongest(blk, i, n, fd, CHAIN_MAX);
      dist1 = fd[0];
    }
    if (len1 >= 3) {
      insert(i);
      let len2 = 0;
      let dist2 = 0;
      if (i + 1 < n) {
        len2 = findLongest(blk, i + 1, n, fd, CHAIN_MAX);
        dist2 = fd[0];
      }
      let takeMatch: boolean;
      if (litCost !== null && distCost !== null) {
        const c1 =
          litCost[LEN_SYM[len1]] + LEN_EBITS[len1] + distCost[DIST_SYM[dist1]] + DIST_EBITS[dist1];
        const litBits = litCost[blk[i]];
        if (len2 >= 3) {
          const c2 =
            litCost[LEN_SYM[len2]] + LEN_EBITS[len2] + distCost[DIST_SYM[dist2]] + DIST_EBITS[dist2];
          takeMatch = c1 <= litBits + c2;
        } else {
          // A match is only worth it if it beats its bytes as literals.
          takeMatch = c1 < len1 * litBits;
        }
      } else {
        takeMatch = len2 <= len1;
      }
      if (takeMatch) {
        TVAL[t] = len1;
        TDIST[t] = dist1;
        t++;
        litFreq[LEN_SYM[len1]]++;
        distFreq[DIST_SYM[dist1]]++;
        for (let k = 1; k < len1; k++) insert(i + k);
        i += len1;
        pendPos = -1;
        continue;
      }
      // Lazy: emit the literal, keep the i+1 match for the next round.
      pendLen = len2;
      pendDist = dist2;
      pendPos = i + 1;
      TVAL[t] = blk[i];
      TDIST[t] = 0;
      t++;
      litFreq[blk[i]]++;
      i++;
      continue;
    }
    TVAL[t] = blk[i];
    TDIST[t] = 0;
    t++;
    litFreq[blk[i]]++;
    insert(i);
    i++;
  }
  return { tokens: t, litFreq, distFreq };
}

// --- Optimal-parsing LZ77 (shortest-path DP, zopfli-style) -----------------
// For each position, the cheapest way to reach it (in code-length bits) using
// fixed Huffman costs; literals and matches are considered. Two speed
// disciplines keep it inside the wall: (a) good-length chain reduction
// (zlib-style): once a long match is in hand the remaining chain is cut
// hard. (b) Only the largest length of each length symbol is tried:
// extending a match to its symbol's largest length costs the same bits and
// covers at least as much input, so the restriction is without loss for
// the DP optimum at a fixed distance.
// Deterministic: no clock, no randomness, every hash position is inserted
// as the DP reaches it.

const OPT_CHAIN_MAX = 512; // longest hash chain walked per position

// Largest length of each length symbol (257..285).
const SYM_MAXLEN = (() => {
  const m = new Int32Array(29);
  for (let l = 3; l <= 258; l++) {
    const s = LEN_SYM[l] - 257;
    if (l > m[s]) m[s] = l;
  }
  return m;
})();

// Find the longest match at position i (block-local coordinates).
// Returns length; writes the distance into foundDist[0]. The chain walk
// is capped, with good-length reduction once a long match is in hand.
function findLongestOpt(
  blk: Uint8Array,
  i: number,
  n: number,
  foundDist: Int32Array,
): number {
  const maxLen = Math.min(258, n - i);
  if (maxLen < 3) return 0;
  let best = 0;
  let bestDist = 0;
  let chain = OPT_CHAIN_MAX;
  if (best >= 128) chain = Math.min(chain, 32);
  else if (best >= 32) chain = Math.min(chain, OPT_CHAIN_MAX >> 2);
  let cand = HEAD[hash3(blk, i)];
  while (cand >= 0 && chain-- > 0) {
    const dist = i - cand;
    if (dist > MAX_DIST) break;
    // Quick reject: to beat `best` the candidate must match at offsets
    // best and best-1. A candidate failing either cannot beat `best`.
    if (best > 0) {
      if (blk[cand + best] !== blk[i + best] || blk[cand + best - 1] !== blk[i + best - 1]) {
        cand = PREV[cand];
        continue;
      }
    }
    let len = 0;
    while (len < maxLen && blk[cand + len] === blk[i + len]) len++;
    if (len > best) {
      best = len;
      bestDist = dist;
      if (len >= NICE_LEN || len >= maxLen) break;
      if (len >= 128) chain = Math.min(chain, 32);
      else if (len >= 32) chain = Math.min(chain, OPT_CHAIN_MAX >> 2);
    }
    cand = PREV[cand];
  }
  foundDist[0] = bestDist;
  return best;
}

function optimalParse(
  d: Uint8Array,
  start: number,
  end: number,
  litCost: Uint8Array,
  distCost: Uint8Array,
): ParseResult {
  const n = end - start;
  const blk = d.subarray(start, end);
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  HEAD.fill(-1);
  const fd = new Int32Array(1);
  const cost = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) cost[i] = Infinity;
  const choiceLen = new Int32Array(n + 1); // 1 = literal, >=3 = match length
  const choiceDist = new Int32Array(n + 1);
  const insert = (p: number) => {
    if (p + 2 < n) {
      const h = ((blk[p] << 10) ^ (blk[p + 1] << 5) ^ blk[p + 2]) & HASH_MASK;
      PREV[p] = HEAD[h];
      HEAD[h] = p;
    }
  };
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    // Literal.
    const lc = base + litCost[blk[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      choiceLen[i + 1] = 1;
      choiceDist[i + 1] = 0;
    }
    // Matches: longest at this position, only the largest length of each
    // length symbol (same distance — the cheaper distance for a shorter
    // length is a refinement the DP's literal steps already approximate).
    if (i + 2 < n) {
      const len = findLongestOpt(blk, i, n, fd);
      const dist = fd[0];
      if (len >= 3) {
        const ds = DIST_SYM[dist];
        const dc = distCost[ds] + DIST_EBITS[dist];
        for (let s = 0; s < 29; s++) {
          if (LEN_BASE[s] > len) break;
          const l = len < SYM_MAXLEN[s] ? len : SYM_MAXLEN[s];
          const c = base + litCost[LEN_SYM[l]] + LEN_EBITS[l] + dc;
          if (c < cost[i + l]) {
            cost[i + l] = c;
            choiceLen[i + l] = l;
            choiceDist[i + l] = dist;
          }
        }
      }
    }
    insert(i);
  }
  // Backtrack from n, collecting tokens in reverse.
  const revLen: number[] = [];
  const revDist: number[] = [];
  let p = n;
  while (p > 0) {
    const l = choiceLen[p];
    const dist = choiceDist[p];
    if (l === 1) {
      revLen.push(1);
      revDist.push(0);
      litFreq[blk[p - 1]]++;
      p -= 1;
    } else {
      revLen.push(l);
      revDist.push(dist);
      litFreq[LEN_SYM[l]]++;
      distFreq[DIST_SYM[dist]]++;
      p -= l;
    }
  }
  // Write TVAL/TDIST in forward order from the backtrack.
  let t = 0;
  let pos = 0;
  for (let k = revLen.length - 1; k >= 0; k--) {
    const l = revLen[k];
    const dist = revDist[k];
    if (dist === 0) {
      TVAL[t] = blk[pos];
      TDIST[t] = 0;
      pos += 1;
    } else {
      TVAL[t] = l;
      TDIST[t] = dist;
      pos += l;
    }
    t++;
  }
  return { tokens: t, litFreq, distFreq };
}

// --- Block emission -----------------------------------------------------------

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Run-length encode the literal/length + distance code lengths for the
// dynamic header. Returns the RLE symbols, their extra values, and the
// frequency of each code-length-code symbol.
function rleLengths(lens: Uint8Array): { syms: number[]; extras: number[]; freq: Uint32Array } {
  const syms: number[] = [];
  const extras: number[] = [];
  const freq = new Uint32Array(19);
  let i = 0;
  while (i < lens.length) {
    const v = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        syms.push(18);
        extras.push(take - 11);
        freq[18]++;
        left -= take;
      }
      if (left >= 3) {
        syms.push(17);
        extras.push(left - 3);
        freq[17]++;
        left = 0;
      }
      while (left > 0) {
        syms.push(0);
        extras.push(0);
        freq[0]++;
        left--;
      }
    } else {
      syms.push(v);
      extras.push(0);
      freq[v]++;
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        syms.push(16);
        extras.push(take - 3);
        freq[16]++;
        left -= take;
      }
      while (left > 0) {
        syms.push(v);
        extras.push(0);
        freq[v]++;
        left--;
      }
    }
    i += run;
  }
  return { syms, extras, freq };
}

function emitTokens(
  w: BitWriter,
  tokens: number,
  litCodes: Uint32Array,
  litLens: Uint8Array,
  distCodes: Uint32Array,
  distLens: Uint8Array,
): void {
  for (let k = 0; k < tokens; k++) {
    const dist = TDIST[k];
    if (dist === 0) {
      const sym = TVAL[k];
      w.write(reverseBits(litCodes[sym], litLens[sym]), litLens[sym]);
    } else {
      const len = TVAL[k];
      const ls = LEN_SYM[len];
      w.write(reverseBits(litCodes[ls], litLens[ls]), litLens[ls]);
      const le = LEN_EBITS[len];
      if (le > 0) w.write(len - LEN_BASE[ls - 257], le);
      const ds = DIST_SYM[dist];
      w.write(reverseBits(distCodes[ds], distLens[ds]), distLens[ds]);
      const de = DIST_EBITS[dist];
      if (de > 0) w.write(dist - DIST_BASE[ds], de);
    }
  }
  w.write(reverseBits(litCodes[256], litLens[256]), litLens[256]);
}

// Emit one block. Picks dynamic Huffman, fixed Huffman, or stored by
// estimated size. `final` marks the last block of the stream.
function emitBlock(w: BitWriter, tokens: number, litFreq: Uint32Array, distFreq: Uint32Array, raw: Uint8Array, final: boolean): void {
  // The end-of-block symbol is emitted once per block: count it, or the
  // dynamic Huffman table gives it no code and the stream has no end.
  litFreq[256]++;
  // Stored size, in bits, for comparison (block header + alignment + data).
  const storedBits = 3 + 32 + raw.length * 8 + 40;
  // Fixed-Huffman token bits.
  let fixedBits = 0;
  for (let s = 0; s < 288; s++) if (litFreq[s] > 0) fixedBits += litFreq[s] * FIXED_LIT_LENS[s];
  for (let s = 0; s < 30; s++) if (distFreq[s] > 0) fixedBits += distFreq[s] * 5;
  if (fixedBits + 3 >= storedBits) {
    w.write(final ? 1 : 0, 1);
    w.write(0, 2);
    w.alignByte();
    const len = raw.length;
    w.ensure(len + 5);
    w.buf[w.pos++] = len & 0xff;
    w.buf[w.pos++] = (len >>> 8) & 0xff;
    w.buf[w.pos++] = ~len & 0xff;
    w.buf[w.pos++] = (~len >>> 8) & 0xff;
    w.buf.set(raw, w.pos);
    w.pos += len;
    return;
  }
  // Dynamic Huffman.
  const litLens = huffmanLengths(litFreq, 15);
  const distLensAll = huffmanLengths(distFreq, 15);
  if (litLens === null || distLensAll === null) {
    // Length repair failed: fall back to fixed Huffman for this block.
    w.write(final ? 1 : 0, 1);
    w.write(1, 2);
    emitTokens(w, tokens, FIXED_LIT_CODES, FIXED_LIT_LENS, FIXED_DIST_CODES, FIXED_DIST_LENS);
    return;
  }
  let hlit = 286;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLensAll[hdist - 1] === 0) hdist--;
  const litPart = litLens.subarray(0, hlit);
  const distPart = distLensAll.subarray(0, hdist);
  const all = new Uint8Array(hlit + hdist);
  all.set(litPart, 0);
  all.set(distPart, hlit);
  const rle = rleLengths(all);
  const clLens = huffmanLengths(rle.freq, 7);
  if (clLens === null) {
    // The code-length code would not fit in 7 bits: fixed Huffman instead.
    w.write(final ? 1 : 0, 1);
    w.write(1, 2);
    emitTokens(w, tokens, FIXED_LIT_CODES, FIXED_LIT_LENS, FIXED_DIST_CODES, FIXED_DIST_LENS);
    return;
  }
  const clCodes = canonicalCodes(clLens);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  let dynBits = 3 + 5 + 5 + 4 + hclen * 3;
  for (let k = 0; k < rle.syms.length; k++) dynBits += clLens[rle.syms[k]] + (rle.syms[k] === 16 ? 2 : rle.syms[k] === 17 ? 3 : rle.syms[k] === 18 ? 7 : 0);
  for (let s = 0; s < 288; s++) if (litFreq[s] > 0) dynBits += litFreq[s] * litLens[s];
  for (let s = 0; s < 30; s++) if (distFreq[s] > 0) dynBits += distFreq[s] * distLensAll[s];
  if (dynBits >= fixedBits + 3) {
    // Fixed Huffman wins.
    w.write(final ? 1 : 0, 1);
    w.write(1, 2);
    emitTokens(w, tokens, FIXED_LIT_CODES, FIXED_LIT_LENS, FIXED_DIST_CODES, FIXED_DIST_LENS);
    return;
  }
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLensAll);
  w.write(final ? 1 : 0, 1);
  w.write(2, 2);
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLens[CL_ORDER[k]], 3);
  for (let k = 0; k < rle.syms.length; k++) {
    const s = rle.syms[k];
    w.write(reverseBits(clCodes[s], clLens[s]), clLens[s]);
    if (s === 16) w.write(rle.extras[k], 2);
    else if (s === 17) w.write(rle.extras[k], 3);
    else if (s === 18) w.write(rle.extras[k], 7);
  }
  emitTokens(w, tokens, litCodes, litLens, distCodes, distLensAll);
}

// The whole zlib stream of `data`: header, deflate blocks, adler32.
function deflate(data: Uint8Array): Uint8Array {
  const w = new BitWriter(data.length + 1024);
  w.buf[w.pos++] = 0x78;
  w.buf[w.pos++] = 0x9c;
  const blocks = Math.max(1, Math.ceil(data.length / BLOCK_SIZE));
  for (let b = 0; b < blocks; b++) {
    const start = b * BLOCK_SIZE;
    const end = Math.min(data.length, start + BLOCK_SIZE);
    const last = b === blocks - 1;
    // Pass 1: lazy matching with fixed-Huffman costs (cheap: it only
    // searches at token boundaries). Its frequencies give the dynamic
    // Huffman costs for the optimal pass.
    const p1 = parseBlock(data, start, end, FIXED_LIT_LENS, FIXED_DIST_LENS);
    const litLens1 = huffmanLengths(p1.litFreq, 15) ?? FIXED_LIT_LENS;
    const distLens1 = huffmanLengths(p1.distFreq, 15) ?? FIXED_DIST_LENS;
    // Pass 2: optimal parsing with pass 1's dynamic costs.
    const p2 = optimalParse(data, start, end, litLens1, distLens1);
    emitBlock(w, p2.tokens, p2.litFreq, p2.distFreq, data.subarray(start, end), last);
  }
  w.alignByte();
  const ad = adler32(data);
  w.ensure(4);
  w.buf[w.pos++] = (ad >>> 24) & 0xff;
  w.buf[w.pos++] = (ad >>> 16) & 0xff;
  w.buf[w.pos++] = (ad >>> 8) & 0xff;
  w.buf[w.pos++] = ad & 0xff;
  return w.bytes();
}

// ---------------------------------------------------------------------------
// One image: decode, reduce, screen, compress, write.
// ---------------------------------------------------------------------------

function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const an = analyse(rgba);
  const forms = formsOf(rgba, an);
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  for (const form of forms) {
    const win = filterForm(form, width, height);
    if (best === null || win.bytes < best.bytes) best = { form, data: win.data, bytes: win.bytes };
  }
  const chosen = best as { form: Form; data: Uint8Array; bytes: number };
  // The final stream is the smallest of three compressors: the program's
  // own DEFLATE encoder, and Node's zlib at level 9 with the default and
  // filtered strategies (zlib wins on the rich/alpha images, the own
  // encoder on the flat ones). All three are lossless and deterministic.
  const own = deflate(chosen.data);
  const z9 = deflateSync(chosen.data, { level: 9, memLevel: 9 });
  const z9f = deflateSync(chosen.data, { level: 9, memLevel: 9, strategy: ZC.Z_FILTERED });
  let idat = own;
  if (z9.length < idat.length) idat = z9;
  if (z9f.length < idat.length) idat = z9f;

  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, chosen.form.colourType)]];
  if (chosen.form.plte !== null) chunks.push(['PLTE', chosen.form.plte]);
  if (chosen.form.trns !== null) chunks.push(['tRNS', chosen.form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  const image = decodePng(new Uint8Array(readFileSync(inPath)));
  if (image.width !== WIDTH || image.height !== HEIGHT) throw new Error(`${id}: unexpected size ${image.width}x${image.height}`);
  const out = encodeImage(image.rgba, image.width, image.height);
  if (out.length > 4194304) throw new Error(`${id}: output ${out.length} bytes over the 4 MiB limit`);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), out);
  console.error(`${id}: ${out.length} bytes`);
}
