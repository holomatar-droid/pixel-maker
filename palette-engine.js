(function () {
  "use strict";

  // Palette decisions are kept independent from the canvas/UI engine so they
  // can be tuned and benchmarked without changing conversion flow.
  function rgbToOklab(rgb) {
    const toLinear = (value) => {
      const channel = value / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    };
    const r = toLinear(rgb[0]);
    const g = toLinear(rgb[1]);
    const b = toLinear(rgb[2]);
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const lRoot = Math.cbrt(Math.max(0, l));
    const mRoot = Math.cbrt(Math.max(0, m));
    const sRoot = Math.cbrt(Math.max(0, s));
    return [
      0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
      1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
      0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
    ];
  }

  function colorDistance(left, right) {
    const dl = (left[0] - right[0]) * 1.2;
    const da = left[1] - right[1];
    const db = left[2] - right[2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }

  function thresholdFor(mode) {
    if (mode === "off") return 0;
    return mode === "strong" ? 0.066 : 0.036;
  }

  function mergeSimilarPaletteColors(palette, weights, mode = "soft") {
    const threshold = thresholdFor(mode);
    if (threshold === 0 || palette.length < 2) return palette;
    const clusters = [];
    palette
      .map((color, index) => ({
        color,
        weight: Math.max(1, weights ? weights[index] || 0 : 1)
      }))
      .sort((left, right) => rgbToOklab(left.color)[0] - rgbToOklab(right.color)[0])
      .forEach(({ color, weight }) => {
        const lab = rgbToOklab(color);
        let nearest = null;
        let nearestDistance = Infinity;
        for (const cluster of clusters) {
          const distance = colorDistance(lab, cluster.lab);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = cluster;
          }
        }
        if (!nearest || nearestDistance > threshold) {
          clusters.push({ weight, sum: color.map((value) => value * weight), lab });
          return;
        }
        nearest.weight += weight;
        for (let channel = 0; channel < 3; channel += 1) {
          nearest.sum[channel] += color[channel] * weight;
        }
        nearest.lab = rgbToOklab(nearest.sum.map((value) => value / nearest.weight));
      });
    return clusters.map((cluster) => cluster.sum.map((value) => value / cluster.weight));
  }

  function mergeSnappedCellColors(data, width, height, mode = "soft") {
    const threshold = thresholdFor(mode);
    if (threshold === 0) return;
    const counts = new Map();
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      if (data[offset + 3] < 8) continue;
      const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size < 2) return;
    const entries = [...counts.entries()]
      .map(([key, count]) => ({
        key,
        count,
        rgb: [(key >> 16) & 255, (key >> 8) & 255, key & 255]
      }))
      .sort((left, right) => right.count - left.count);
    for (const entry of entries) entry.lab = rgbToOklab(entry.rgb);

    const remap = new Map();
    const kept = [];
    for (const entry of entries) {
      let nearest = null;
      let nearestDistance = Infinity;
      for (const target of kept) {
        const distance = colorDistance(entry.lab, target.lab);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = target;
        }
      }
      if (nearest && nearestDistance <= threshold) remap.set(entry.key, nearest.rgb);
      else kept.push(entry);
    }
    if (!remap.size) return;
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      if (data[offset + 3] < 8) continue;
      const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      const replacement = remap.get(key);
      if (!replacement) continue;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
    }
  }

  window.HolometerPaletteEngine = Object.freeze({
    mergeSimilarPaletteColors,
    mergeSnappedCellColors
  });
})();
