(() => {
  "use strict";

  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_SOURCE_EDGE = 1920;
  // ドットの大きさの上限。1024px前後のAI画像で 1ドット=32px になる例が多く、
  // 24 のままだと自動検出がそこで頭打ちになり格子を取り違える。
  const MAX_PIXEL_SIZE = 36;
  const MAX_EDIT_CELL_SIZE = 64;
  const AUTO_PALETTE_SAMPLE_EDGE = 512;
  const BATCH_MAX_IMAGES = 250;
  const BATCH_MAX_ZIP_BYTES = 150 * 1024 * 1024;
  const BATCH_MAX_EXTRACTED_BYTES = 600 * 1024 * 1024;
  const BATCH_MAX_IMAGE_PIXELS = 64_000_000;
  const BATCH_IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const SPRITE_MAX_FRAMES = 64;
  const SPRITE_MAX_PIXELS = 64_000_000;

  const palettes = {
    game: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
    retro: ["#1d1d1d", "#e60012", "#f7d038", "#ffffff", "#3a7bd5", "#3f9f5e", "#e77a12", "#9b59b6"],
    // ファミコン(2C02)のマスターパレット。重複する黒を除いた55色。
    famicom: [
      "#7c7c7c", "#0000fc", "#0000bc", "#4428bc", "#940084", "#a80020", "#a81000", "#881400",
      "#503000", "#007800", "#006800", "#005800", "#004058", "#000000", "#bcbcbc", "#0078f8",
      "#0058f8", "#6844fc", "#d800cc", "#e40058", "#f83800", "#e45c10", "#ac7c00", "#00b800",
      "#00a800", "#00a844", "#008888", "#f8f8f8", "#3cbcfc", "#6888fc", "#9878f8", "#f878f8",
      "#f85898", "#f87858", "#fca044", "#f8b800", "#b8f818", "#58d854", "#58f898", "#00e8d8",
      "#787878", "#fcfcfc", "#a4e4fc", "#b8b8f8", "#d8b8f8", "#f8b8f8", "#f8a4c0", "#f0d0b0",
      "#fce0a8", "#f8d878", "#d8f878", "#b8f8b8", "#b8f8d8", "#00fcfc", "#f8d8f8"
    ]
  };

  /* 「ゲーム機風」の中で選ぶ機種。実機の色の決まり方が3種類とも違う。
     - GB : 4色固定
     - FC : 55色のマスターパレットから最も近い色を選ぶ
     - SFC: 固定パレットが無く15bit色(各chが32段階)なので、
            適応パレットを16色に絞ってから RGB555 に丸める */
  const gameHardwareSettings = {
    gb: {
      label: "ゲームボーイ",
      colors: 4,
      edge: 100,
      outline: "dark",
      description: "緑の4色だけで、携帯ゲームのように仕上げます。"
    },
    fc: {
      label: "ファミコン",
      colors: 32,
      edge: 40,
      outline: "off",
      description: "ファミコンで表示できる55色の中から、近い色だけを使って塗り直します。"
    },
    sfc: {
      label: "スーパーファミコン",
      colors: 16,
      edge: 20,
      outline: "off",
      description: "スーパーファミコンの色の刻み（15bit）に合わせ、16色までにまとめます。"
    }
  };

  const styleSettings = {
    // AI補正は64色、手打ちドット風は16色で、検出した論理グリッドへ組み直す。
    // 通常変換と写真は既存の色づくりを保ち、補正モードの変更を波及させない。
    refine: { pixel: 8, colors: 64, dither: "off", gridSnap: "auto", gridStabilize: true, accentKeep: false, flatFill: "off", saturation: 0, contrast: 0, edge: 0, outline: "off" },
    craft: { pixel: 8, colors: 16, dither: "off", gridSnap: "auto", gridStabilize: true, accentKeep: true, flatFill: "soft", saturation: 0, contrast: 0, edge: 0, outline: "off" },
    auto: { pixel: 8, colors: 32, dither: "off", gridSnap: "auto", accentKeep: false, flatFill: "soft", saturation: 0, contrast: 0, edge: 12, outline: "off" },
    photo: { pixel: 4, colors: 128, dither: "off", gridSnap: "off", accentKeep: true, flatFill: "off", saturation: 0, contrast: 0, edge: 0, outline: "off" },
    "two-tone": { pixel: 8, dither: "off", gridSnap: "off", accentKeep: false, flatFill: "off", saturation: 0, contrast: 4, edge: 8, outline: "off", threshold: 58 },
    /* ゲーム機風は「元がドット絵風の画像を実機の色に落とす」用途が主なので、格子検出を既定にする。
       写真やイラストなど周期が見つからない画像では snapSourceGrid が null を返し、
       従来どおりドットの大きさで刻む動作に自動で戻る。 */
    game: { pixel: 8, colors: 4, dither: "off", gridSnap: "auto", accentKeep: false, flatFill: "off", saturation: 0, contrast: 0, edge: 100, outline: "dark" },
    retro: { pixel: 7, dither: "soft", gridSnap: "off", accentKeep: false, flatFill: "off", saturation: 0, contrast: 8, edge: 14, outline: "off" },
    custom: { pixel: 8, dither: "off", gridSnap: "off", accentKeep: false, flatFill: "off", saturation: 0, contrast: 0, edge: 8, outline: "off" }
  };

  const DEFAULT_STYLE = "craft";

  const styleDescriptions = {
    refine: "崩れた格子を揃え、近い色のムラをまとめます。",
    craft: "細い線や差し色を残しながら、近い色の浮いた1ドットと色ムラを控えめにまとめます。",
    auto: "元画像のドット間隔を検出してグリッドを組み直し、近い色をまとめます。輪郭を優先する時は「サイズを指定」を使います。",
    photo: "色を多めに残し、写真の雰囲気を保ちます。",
    "two-tone": "暗い色と明るい色の2色にまとめます。",
    game: "緑の4色だけで、携帯ゲームのように仕上げます。",
    retro: "明るい8色で、昔のゲーム画面のように仕上げます。",
    custom: "下の8色だけを使って仕上げます。"
  };

  const defaultCustomColors = ["#08142e", "#0146ea", "#33b8ff", "#2fbf71", "#ffd166", "#ff6b9c", "#a56bff", "#f7f9ff"];

  const canvas = document.getElementById("pixelCanvas");
  const context = canvas?.getContext("2d", { alpha: true });
  const smallCanvas = document.createElement("canvas");
  const smallContext = smallCanvas.getContext("2d", { willReadFrequently: true });
  const paletteSourceCanvas = document.createElement("canvas");
  const paletteSourceContext = paletteSourceCanvas.getContext("2d", { willReadFrequently: true });
  const autoPaletteCache = new WeakMap();
  const stage = document.getElementById("pixelStage");
  const originalPreview = document.getElementById("originalPreview");
  const input = document.getElementById("imageInput");
  const emptyButton = document.getElementById("emptyButton");
  const changeImageButton = document.getElementById("changeImageButton");
  const resetButton = document.getElementById("resetButton");
  const saveButton = document.getElementById("saveButton");
  const statusMessage = document.getElementById("statusMessage");
  const stageMeta = document.getElementById("stageMeta");
  const styleHelp = document.getElementById("styleHelp");
  const pixelSize = document.getElementById("pixelSize");
  const colorCount = document.getElementById("colorCount");
  const pixelSizeOut = document.getElementById("pixelSizeOut");
  const gridSnapStatus = document.getElementById("gridSnapStatus");
  const colorCountOut = document.getElementById("colorCountOut");
  const palettePreview = document.getElementById("palettePreview");
  const paletteStatus = document.getElementById("paletteStatus");
  const paletteCopyButton = document.getElementById("paletteCopyButton");
  const twoToneSettings = document.getElementById("twoToneSettings");
  const customSettings = document.getElementById("customSettings");
  const gameSettings = document.getElementById("gameSettings");
  const outlineSettings = document.getElementById("outlineSettings");
  const inkColor = document.getElementById("inkColor");
  const paperColor = document.getElementById("paperColor");
  const toneThreshold = document.getElementById("toneThreshold");
  const toneThresholdOut = document.getElementById("toneThresholdOut");
  const saturationBoost = document.getElementById("saturationBoost");
  const saturationOut = document.getElementById("saturationOut");
  const contrastBoost = document.getElementById("contrastBoost");
  const edgeBoost = document.getElementById("edgeBoost");
  const contrastOut = document.getElementById("contrastOut");
  const edgeOut = document.getElementById("edgeOut");
  const customInputs = [...document.querySelectorAll(".custom-colors input")];
  const mainActions = document.querySelector(".main-actions");
  const editToggleButton = document.getElementById("editToggleButton");
  const editedNote = document.getElementById("editedNote");
  const returnSettingsButton = document.getElementById("returnSettingsButton");
  const settingsPanel = document.getElementById("settingsPanel");
  const makerLayout = document.querySelector(".maker-layout");
  const previewPanel = document.querySelector(".preview-panel");
  const batchPanel = document.querySelector(".batch-panel");
  const pixelEditorDialog = document.getElementById("pixelEditorDialog");
  const pixelEditorTitle = document.getElementById("pixelEditorTitle");
  const cancelEditButton = document.getElementById("cancelEditButton");
  const editCanvas = document.getElementById("editCanvas");
  const editContext = editCanvas?.getContext("2d", { willReadFrequently: true });
  const editCanvasScroll = document.getElementById("editCanvasScroll");
  const editCanvasFrame = document.getElementById("editCanvasFrame");
  const editCursor = document.getElementById("editCursor");
  const editPalette = document.getElementById("editPalette");
  const editColorInput = document.getElementById("editColorInput");
  const paintEditButton = document.getElementById("paintEditButton");
  const fillEditButton = document.getElementById("fillEditButton");
  const eraseEditButton = document.getElementById("eraseEditButton");
  const panEditButton = document.getElementById("panEditButton");
  const undoEditButton = document.getElementById("undoEditButton");
  const editZoomOutButton = document.getElementById("editZoomOutButton");
  const editFitButton = document.getElementById("editFitButton");
  const editZoomInButton = document.getElementById("editZoomInButton");
  const editorHelp = document.getElementById("editorHelp");
  const editorStatus = document.getElementById("editorStatus");
  const finishEditButton = document.getElementById("finishEditButton");
  const editorDiscard = document.getElementById("editorDiscard");
  const continueEditButton = document.getElementById("continueEditButton");
  const discardEditButton = document.getElementById("discardEditButton");
  const zipInput = document.getElementById("zipInput");
  const zipLoadButton = document.getElementById("zipLoadButton");
  const zipExportButton = document.getElementById("zipExportButton");
  const spriteExportButton = document.getElementById("spriteExportButton");
  const spriteColumns = document.getElementById("spriteColumns");
  const batchProgress = document.getElementById("batchProgress");
  const batchStatus = document.getElementById("batchStatus");
  const batchCount = document.getElementById("batchCount");
  const batchCanvas = document.createElement("canvas");
  const batchSmallCanvas = document.createElement("canvas");
  const batchSmallContext = batchSmallCanvas.getContext("2d", { willReadFrequently: true });
  const conversionStats = document.getElementById("conversionStats");
  const logicalSizeStat = document.getElementById("logicalSizeStat");
  const actualColorsStat = document.getElementById("actualColorsStat");
  const tileGridStat = document.getElementById("tileGridStat");
  const uniqueTilesStat = document.getElementById("uniqueTilesStat");
  const desktopBatchMedia = window.matchMedia("(min-width: 901px)");

  function syncBatchPanelPlacement() {
    if (!makerLayout || !previewPanel || !settingsPanel || !batchPanel || !pixelEditorDialog) return;
    if (desktopBatchMedia.matches) {
      if (batchPanel.parentElement !== previewPanel || batchPanel.nextElementSibling !== pixelEditorDialog) {
        previewPanel.insertBefore(batchPanel, pixelEditorDialog);
      }
      return;
    }
    if (batchPanel.parentElement !== makerLayout || settingsPanel.nextElementSibling !== batchPanel) {
      settingsPanel.after(batchPanel);
    }
  }

  syncBatchPanelPlacement();
  if (typeof desktopBatchMedia.addEventListener === "function") {
    desktopBatchMedia.addEventListener("change", syncBatchPanelPlacement);
  } else {
    desktopBatchMedia.addListener(syncBatchPanelPlacement);
  }

  let sourceImage = null;
  let sourceObjectUrl = "";
  let activeStyle = DEFAULT_STYLE;
  let previewMode = "after";
  let dither = "off";
  let gridSnap = "off";
  let detectedGridSize = 0;
  let appliedGridSize = 0;
  let gridSizeAdjusted = false;
  let accentKeep = false;
  let flatFill = "off";
  let outline = "off";
  let gameHardware = "gb";
  let outputDots = 0;  // 0 = 未指定（従来どおり格子検出／ドットの大きさで決める）
  let toneBackground = "paper";
  let renderFrame = 0;
  let loadRequestId = 0;
  let isLoadingImage = false;
  let currentPaletteHex = [];
  let lastRender = { width: 0, height: 0, block: 0, paletteCount: 0, settingsKey: "" };
  let batchEntries = [];
  let batchZipName = "holometer-pixel-batch";
  let batchBusy = false;
  let batchDisabledState = [];

  const editor = {
    mode: "convert",
    entryMode: "convert",
    tool: "paint",
    color: "#0146ea",
    undo: [],
    undoFloorDirty: false,
    stroke: null,
    lastCell: null,
    pointerId: null,
    pan: null,
    dirty: false,
    fit: true,
    cellSize: 8,
    cursorX: 0,
    cursorY: 0
  };

  function track(eventName, details = {}) {
    const payload = { tool_name: "pixel_maker", ...details };
    if (typeof window.gtag === "function") window.gtag("event", eventName, payload);
    if (window.umami && typeof window.umami.track === "function") window.umami.track(eventName, payload);
  }

  function setStatus(message, isError = false) {
    statusMessage.textContent = message;
    statusMessage.classList.toggle("is-error", isError);
  }

  function setPreviewMode(next, announce = true) {
    if (!["after", "before"].includes(next)) return;
    previewMode = next;
    const showOriginal = next === "before";
    stage.classList.toggle("show-original", showOriginal);
    canvas.setAttribute("aria-hidden", String(showOriginal));
    originalPreview.setAttribute("aria-hidden", String(!showOriginal));
    document.querySelectorAll("[data-preview-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.previewMode === next));
    });
    if (announce && sourceImage) {
      setStatus(showOriginal ? "元画像を表示しています。" : "変換後を表示しています。");
      track("pixel_preview_compare", { preview_mode: next });
    }
  }

  function clamp(value) {
    return Math.max(0, Math.min(255, value));
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function hexToRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function linearChannel(value) {
    const channel = clamp(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }

  function rgbLightness(r, g, b) {
    const red = linearChannel(r);
    const green = linearChannel(g);
    const blue = linearChannel(b);
    const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
    const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
    const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
    return 0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s);
  }

  function rgbToOklab(rgb) {
    const red = linearChannel(rgb[0]);
    const green = linearChannel(rgb[1]);
    const blue = linearChannel(rgb[2]);
    const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
    const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
    const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
    const ll = Math.cbrt(l);
    const mm = Math.cbrt(m);
    const ss = Math.cbrt(s);
    return [
      0.2104542553 * ll + 0.793617785 * mm - 0.0040720468 * ss,
      1.9779984951 * ll - 2.428592205 * mm + 0.4505937099 * ss,
      0.0259040371 * ll + 0.7827717662 * mm - 0.808675766 * ss
    ];
  }

  function oklabToRgb(lab) {
    const ll = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    const mm = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    const ss = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
    const l = ll ** 3;
    const m = mm ** 3;
    const s = ss ** 3;
    const linear = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
    return linear.map((value) => clamp(255 * (value <= 0.0031308
      ? 12.92 * value
      : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055)));
  }

  function adjustContrast(rgb, amount) {
    if (amount <= 0) return rgb;
    const lab = rgbToOklab(rgb);
    lab[0] = clamp01(0.5 + (lab[0] - 0.5) * (1 + amount * 1.45));
    return oklabToRgb(lab);
  }

  function adjustSaturation(rgb, amount) {
    if (amount <= 0) return rgb;
    const lab = rgbToOklab(rgb);
    const factor = 1 + amount * 1.25;
    lab[1] *= factor;
    lab[2] *= factor;
    return oklabToRgb(lab);
  }

  function makeColorBox(entries) {
    let population = 0;
    const mean = [0, 0, 0];
    for (const entry of entries) {
      population += entry.count;
      for (let channel = 0; channel < 3; channel += 1) mean[channel] += entry.lab[channel] * entry.count;
    }
    for (let channel = 0; channel < 3; channel += 1) mean[channel] /= population;
    const variance = [0, 0, 0];
    for (const entry of entries) {
      for (let channel = 0; channel < 3; channel += 1) {
        const distance = entry.lab[channel] - mean[channel];
        variance[channel] += distance * distance * entry.count;
      }
    }
    variance[0] *= 1.2;
    variance[1] *= 1.45;
    variance[2] *= 1.45;
    const channel = variance.indexOf(Math.max(...variance));
    return { entries, population, mean, channel, score: variance.reduce((sum, value) => sum + value, 0) };
  }

  function medianCutPalette(entries, count) {
    if (!entries.length) return [[0, 0, 0]];
    if (entries.length <= count) return entries.map((entry) => entry.rgb);
    const boxes = [makeColorBox([...entries])];
    while (boxes.length < count) {
      let splitIndex = -1;
      let bestScore = -1;
      boxes.forEach((box, index) => {
        if (box.entries.length > 1 && box.score > bestScore) {
          bestScore = box.score;
          splitIndex = index;
        }
      });
      if (splitIndex < 0) break;

      const box = boxes.splice(splitIndex, 1)[0];
      box.entries.sort((left, right) => left.lab[box.channel] - right.lab[box.channel]);
      const middleWeight = box.population / 2;
      let running = 0;
      let splitAt = Math.max(1, box.entries.length - 1);
      for (let index = 0; index < box.entries.length - 1; index += 1) {
        running += box.entries[index].count;
        if (running >= middleWeight) {
          splitAt = index + 1;
          break;
        }
      }
      boxes.push(makeColorBox(box.entries.slice(0, splitAt)), makeColorBox(box.entries.slice(splitAt)));
    }

    return boxes.map((box) => {
      let representative = box.entries[0];
      let bestDistance = Infinity;
      for (const entry of box.entries) {
        const dl = (entry.lab[0] - box.mean[0]) * 1.2;
        const da = entry.lab[1] - box.mean[1];
        const db = entry.lab[2] - box.mean[2];
        const distance = dl * dl + da * da + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          representative = entry;
        }
      }
      return representative.rgb;
    });
  }

  // Accent preservation follows the operation concept of Raky's Pixel Art Mode.
  // The palette selection itself is an independent Holometer implementation.
  function adaptivePalette(values, alpha, count, preserveAccents = accentKeep) {
    const histogram = new Map();
    for (let index = 0; index < alpha.length; index += 1) {
      if (alpha[index] < 8) continue;
      const r = clamp(values[index * 3]);
      const g = clamp(values[index * 3 + 1]);
      const b = clamp(values[index * 3 + 2]);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const entry = histogram.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      entry.count += 1;
      entry.r += r;
      entry.g += g;
      entry.b += b;
      histogram.set(key, entry);
    }

    const entries = [...histogram.values()].map((entry) => {
      const rgb = [entry.r / entry.count, entry.g / entry.count, entry.b / entry.count];
      return { ...entry, rgb, lab: rgbToOklab(rgb) };
    });
    if (!entries.length) return [[0, 0, 0]];
    if (entries.length <= count) return entries.map((entry) => entry.rgb);
    if (!preserveAccents || count < 4) return medianCutPalette(entries, count);

    const reserve = Math.min(8, Math.max(1, Math.round(count * .125)));
    const selected = medianCutPalette(entries, count);
    const selectedLabs = selected.map(rgbToOklab);
    const population = entries.reduce((sum, entry) => sum + entry.count, 0);
    const minimumPixels = Math.max(2, Math.floor(population * .0002));
    const candidates = entries
      .filter((entry) => entry.count >= minimumPixels)
      .map((entry) => {
        let nearestDistance = Infinity;
        for (const lab of selectedLabs) {
          const dl = (entry.lab[0] - lab[0]) * 1.2;
          const da = entry.lab[1] - lab[1];
          const db = entry.lab[2] - lab[2];
          nearestDistance = Math.min(nearestDistance, Math.sqrt(dl * dl + da * da + db * db));
        }
        const chroma = Math.sqrt(entry.lab[1] * entry.lab[1] + entry.lab[2] * entry.lab[2]);
        const rarity = 1 - Math.min(1, entry.count / Math.max(1, population * .04));
        return { entry, nearestDistance, chroma, score: nearestDistance * (1 + chroma * 4) * (.7 + rarity * .6) };
      })
      .filter((candidate) => candidate.nearestDistance >= .045 && candidate.chroma >= .055)
      .sort((left, right) => right.score - left.score);

    let replacements = 0;
    for (const candidate of candidates) {
      if (replacements >= reserve) break;
      const lab = candidate.entry.lab;
      let pair = null;
      for (let left = 0; left < selectedLabs.length - 1; left += 1) {
        for (let right = left + 1; right < selectedLabs.length; right += 1) {
          const distance = Math.hypot(
            (selectedLabs[left][0] - selectedLabs[right][0]) * 1.2,
            selectedLabs[left][1] - selectedLabs[right][1],
            selectedLabs[left][2] - selectedLabs[right][2]
          );
          if (!pair || distance < pair.distance) pair = { left, right, distance };
        }
      }
      if (!pair || pair.distance > .065) break;
      const coverage = [0, 0];
      for (const entry of entries) {
        const leftDistance = Math.hypot((entry.lab[0] - selectedLabs[pair.left][0]) * 1.2, entry.lab[1] - selectedLabs[pair.left][1], entry.lab[2] - selectedLabs[pair.left][2]);
        const rightDistance = Math.hypot((entry.lab[0] - selectedLabs[pair.right][0]) * 1.2, entry.lab[1] - selectedLabs[pair.right][1], entry.lab[2] - selectedLabs[pair.right][2]);
        if (leftDistance < rightDistance) coverage[0] += entry.count;
        else coverage[1] += entry.count;
      }
      const replaceIndex = coverage[0] <= coverage[1] ? pair.left : pair.right;
      selected[replaceIndex] = candidate.entry.rgb;
      selectedLabs[replaceIndex] = lab;
      replacements += 1;
    }
    return selected;
  }

  /* AI補正用の色は、中央値分割を初期値にしてRGB重心へ収束させる。
     代表となる1色を選ぶだけだと、白背景や白髪が多い画像で肌色まで白側へ寄りやすい。
     5bitヒストグラムを重み付きで更新するため、全画素を何度も走査せず決定的に処理できる。 */
  function centroidPalette(values, alpha, count) {
    const histogram = new Map();
    for (let index = 0; index < alpha.length; index += 1) {
      if (alpha[index] < 8) continue;
      const r = clamp(values[index * 3]);
      const g = clamp(values[index * 3 + 1]);
      const b = clamp(values[index * 3 + 2]);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const entry = histogram.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      entry.count += 1;
      entry.r += r;
      entry.g += g;
      entry.b += b;
      histogram.set(key, entry);
    }

    const entries = [...histogram.values()].map((entry) => {
      const rgb = [entry.r / entry.count, entry.g / entry.count, entry.b / entry.count];
      return { ...entry, rgb, lab: rgbToOklab(rgb) };
    });
    if (!entries.length) return [[0, 0, 0]];
    const target = Math.max(1, Math.min(count, entries.length));
    let centroids = medianCutPalette(entries, target).map((color) => [...color]);

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const sums = centroids.map(() => [0, 0, 0, 0]);
      for (const entry of entries) {
        let winner = 0;
        let bestDistance = Infinity;
        for (let index = 0; index < centroids.length; index += 1) {
          const centroid = centroids[index];
          const distance = (entry.rgb[0] - centroid[0]) ** 2
            + (entry.rgb[1] - centroid[1]) ** 2
            + (entry.rgb[2] - centroid[2]) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            winner = index;
          }
        }
        sums[winner][0] += entry.rgb[0] * entry.count;
        sums[winner][1] += entry.rgb[1] * entry.count;
        sums[winner][2] += entry.rgb[2] * entry.count;
        sums[winner][3] += entry.count;
      }

      let maximumMovement = 0;
      const next = centroids.map((centroid, index) => {
        const weight = sums[index][3];
        if (!weight) return centroid;
        const updated = [sums[index][0] / weight, sums[index][1] / weight, sums[index][2] / weight];
        maximumMovement = Math.max(maximumMovement,
          (updated[0] - centroid[0]) ** 2 + (updated[1] - centroid[1]) ** 2 + (updated[2] - centroid[2]) ** 2);
        return updated;
      });
      centroids = next;
      if (maximumMovement < 0.25) break;
    }
    return dedupePaletteColors(centroids.map((color) => color.map((value) => Math.round(value))));
  }

  function autoPaletteForSource(image, count) {
    if (!image || !paletteSourceContext) return [[0, 0, 0]];
    let imageCache = autoPaletteCache.get(image);
    if (!imageCache) {
      imageCache = new Map();
      autoPaletteCache.set(image, imageCache);
    }
    const saturationValue = Number(saturationBoost.value);
    const contrastValue = Number(contrastBoost.value);
    const cacheKey = `${count}:${saturationValue}:${contrastValue}:${accentKeep ? 1 : 0}`;
    if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);

    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, AUTO_PALETTE_SAMPLE_EDGE / Math.max(imageWidth, imageHeight));
    const width = Math.max(1, Math.round(imageWidth * scale));
    const height = Math.max(1, Math.round(imageHeight * scale));
    paletteSourceCanvas.width = width;
    paletteSourceCanvas.height = height;
    paletteSourceContext.clearRect(0, 0, width, height);
    paletteSourceContext.imageSmoothingEnabled = true;
    paletteSourceContext.imageSmoothingQuality = "high";
    paletteSourceContext.drawImage(image, 0, 0, width, height);

    const pixels = paletteSourceContext.getImageData(0, 0, width, height).data;
    const alpha = new Uint8Array(width * height);
    const values = new Float32Array(width * height * 3);
    const saturationAmount = saturationValue / 100;
    const contrastAmount = contrastValue / 100;
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      alpha[index] = pixels[offset + 3];
      const original = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      const contrasted = contrastAmount > 0 ? adjustContrast(original, contrastAmount) : original;
      const adjusted = saturationAmount > 0 ? adjustSaturation(contrasted, saturationAmount) : contrasted;
      values[index * 3] = adjusted[0];
      values[index * 3 + 1] = adjusted[1];
      values[index * 3 + 2] = adjusted[2];
    }
    const palette = adaptivePalette(values, alpha, count);
    imageCache.set(cacheKey, palette);
    return palette;
  }

  function stableAutoPalette(count) {
    return autoPaletteForSource(sourceImage, count);
  }

  function renderSettingsKey() {
    return JSON.stringify([
      activeStyle,
      pixelSize.value,
      colorCount.value,
      dither,
      flatFill,
      outline,
      toneBackground,
      inkColor.value,
      paperColor.value,
      toneThreshold.value,
      saturationBoost.value,
      contrastBoost.value,
      edgeBoost.value,
      customInputs.map((input) => input.value),
      gridSnap,
      accentKeep,
      gameHardware,
      outputDots
    ]);
  }

  function restoreSettingsKey(settingsKey) {
    try {
      const [style, pixel, colors, savedDither, savedFlatFill, savedOutline, savedBackground, ink, paper, threshold, saturation, contrast, edge, custom, savedGridSnap, savedAccentKeep, savedGameHardware] = JSON.parse(settingsKey);
      if (savedGameHardware && gameHardwareSettings[savedGameHardware]) gameHardware = savedGameHardware;
      activeStyle = style;
      pixelSize.value = pixel;
      colorCount.value = colors;
      dither = savedDither;
      flatFill = savedFlatFill;
      gridSnap = savedGridSnap || styleSettings[style]?.gridSnap || "off";
      accentKeep = savedAccentKeep ?? styleSettings[style]?.accentKeep ?? false;
      outline = savedOutline;
      toneBackground = savedBackground;
      inkColor.value = ink;
      paperColor.value = paper;
      toneThreshold.value = threshold;
      saturationBoost.value = saturation;
      contrastBoost.value = contrast;
      edgeBoost.value = edge;
      customInputs.forEach((input, index) => { if (custom[index]) input.value = custom[index]; });
      updateControlState();
    } catch (error) {
      console.error("[PIXEL MAKER SETTINGS RESTORE]", error);
    }
  }

  // 各パレット色が実際に何画素に使われるかを数える（統合時の重みに使う）
  function palettePopulations(values, alpha, palette) {
    const counts = new Array(palette.length).fill(0);
    const labs = palette.map(rgbToOklab);
    const cache = new Map();
    for (let index = 0; index < alpha.length; index += 1) {
      if (alpha[index] < 8) continue;
      const red = clamp(values[index * 3]) >> 3;
      const green = clamp(values[index * 3 + 1]) >> 3;
      const blue = clamp(values[index * 3 + 2]) >> 3;
      const key = (red << 10) | (green << 5) | blue;
      let best = cache.get(key);
      if (best === undefined) {
        const lab = rgbToOklab([red * 8 + 4, green * 8 + 4, blue * 8 + 4]);
        let distance = Infinity;
        best = 0;
        for (let candidate = 0; candidate < labs.length; candidate += 1) {
          const dl = (lab[0] - labs[candidate][0]) * 1.2;
          const da = lab[1] - labs[candidate][1];
          const db = lab[2] - labs[candidate][2];
          const current = dl * dl + da * da + db * db;
          if (current < distance) { distance = current; best = candidate; }
        }
        cache.set(key, best);
      }
      counts[best] += 1;
    }
    return counts;
  }

  function paletteMatcher(palette) {
    const candidates = palette.map((rgb) => ({ rgb, lab: rgbToOklab(rgb) }));
    const cache = new Map();
    return (rgb) => {
      const redBin = clamp(rgb[0]) >> 3;
      const greenBin = clamp(rgb[1]) >> 3;
      const blueBin = clamp(rgb[2]) >> 3;
      const key = (redBin << 10) | (greenBin << 5) | blueBin;
      if (cache.has(key)) return cache.get(key);
      const lab = rgbToOklab([redBin * 8 + 4, greenBin * 8 + 4, blueBin * 8 + 4]);
      let result = candidates[0].rgb;
      let distance = Infinity;
      for (const candidate of candidates) {
        const dl = (lab[0] - candidate.lab[0]) * 1.2;
        const da = lab[1] - candidate.lab[1];
        const db = lab[2] - candidate.lab[2];
        const current = dl * dl + da * da + db * db;
        if (current < distance) {
          distance = current;
          result = candidate.rgb;
        }
      }
      cache.set(key, result);
      return result;
    };
  }

  /* 近い色をまとめる。代表色は「その色を実際に使っている画素数」で重み付けした平均にする。
     単純平均にすると、にじみで生まれた少数の中間色が主要色と同じ重みを持ってしまい、
     肌色のような広い面が灰色側へ引っ張られる（彩度が半分近く落ちる）。 */
  function mergeSimilarPaletteColors(palette, weights) {
    if (flatFill === "off" || palette.length < 2) return palette;
    const threshold = flatFill === "strong" ? 0.066 : 0.036;
    const clusters = [];
    const ordered = palette
      .map((color, index) => ({ color, weight: Math.max(1, weights ? weights[index] || 0 : 1) }))
      .sort((left, right) => rgbToOklab(left.color)[0] - rgbToOklab(right.color)[0]);
    for (const { color, weight } of ordered) {
      const lab = rgbToOklab(color);
      let nearest = null;
      let nearestDistance = Infinity;
      for (const cluster of clusters) {
        const dl = (lab[0] - cluster.lab[0]) * 1.2;
        const da = lab[1] - cluster.lab[1];
        const db = lab[2] - cluster.lab[2];
        const distance = Math.sqrt(dl * dl + da * da + db * db);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = cluster;
        }
      }
      if (!nearest || nearestDistance > threshold) {
        clusters.push({ weight, sum: color.map((value) => value * weight), lab });
        continue;
      }
      nearest.weight += weight;
      for (let channel = 0; channel < 3; channel += 1) nearest.sum[channel] += color[channel] * weight;
      nearest.lab = rgbToOklab(nearest.sum.map((value) => value / nearest.weight));
    }
    return clusters.map((cluster) => cluster.sum.map((value) => value / cluster.weight));
  }

  // Grid-first cleanup, independently implemented from the workflow described by
  // Hugo Duprez's Sprite Fusion Pixel Snapper: detect, snap, then quantize.
  function gridAnalysisPixels(data, width, height) {
    const alpha = new Uint8Array(width * height);
    const values = new Float32Array(width * height * 3);
    for (let index = 0; index < alpha.length; index += 1) {
      const offset = index * 4;
      alpha[index] = data[offset + 3];
      values[index * 3] = data[offset];
      values[index * 3 + 1] = data[offset + 1];
      values[index * 3 + 2] = data[offset + 2];
    }
    const analysisColorCount = usesStructuredGrid()
      ? Math.min(64, Number(colorCount.value))
      : Math.min(16, Number(colorCount.value));
    const palette = usesStructuredGrid()
      ? centroidPalette(values, alpha, analysisColorCount)
      : adaptivePalette(values, alpha, analysisColorCount, false);
    const pick = paletteMatcher(palette);
    const output = new Uint8ClampedArray(data.length);
    for (let index = 0; index < alpha.length; index += 1) {
      const offset = index * 4;
      if (alpha[index] < 8) continue;
      const color = pick([data[offset], data[offset + 1], data[offset + 2]]);
      output[offset] = color[0];
      output[offset + 1] = color[1];
      output[offset + 2] = color[2];
      output[offset + 3] = alpha[index];
    }
    return output;
  }

  function gridProfiles(data, width, height) {
    const tones = new Float32Array(width * height);
    for (let index = 0; index < tones.length; index += 1) {
      const offset = index * 4;
      if (data[offset + 3] < 8) continue;
      const r = (data[offset] >> 4) * 17;
      const g = (data[offset + 1] >> 4) * 17;
      const b = (data[offset + 2] >> 4) * 17;
      tones[index] = r * 0.299 + g * 0.587 + b * 0.114;
    }
    const columns = new Float64Array(width);
    const rows = new Float64Array(height);
    for (let y = 0; y < height; y += 1) for (let x = 1; x < width - 1; x += 1) {
      columns[x] += Math.abs(tones[y * width + x + 1] - tones[y * width + x - 1]);
    }
    for (let x = 0; x < width; x += 1) for (let y = 1; y < height - 1; y += 1) {
      rows[y] += Math.abs(tones[(y + 1) * width + x] - tones[(y - 1) * width + x]);
    }
    return { columns, rows };
  }

  function estimateGridStep(profile) {
    if (profile.length < 8) return null;
    let maximum = 0;
    for (const value of profile) maximum = Math.max(maximum, value);
    if (!maximum) return null;
    const peaks = [];
    const threshold = maximum * 0.2;
    for (let index = 1; index < profile.length - 1; index += 1) {
      if (profile[index] > threshold && profile[index] > profile[index - 1] && profile[index] > profile[index + 1]) peaks.push(index);
    }
    const clean = [];
    for (const peak of peaks) if (!clean.length || peak - clean[clean.length - 1] > 3) clean.push(peak);
    if (clean.length < 4) return null;
    const differences = [];
    for (let index = 1; index < clean.length; index += 1) differences.push(clean[index] - clean[index - 1]);
    differences.sort((left, right) => left - right);
    const step = differences[Math.floor(differences.length / 2)];
    return step >= 2 ? step : null;
  }

  /* estimateGridStep はピーク間隔の中央値を採るため、弱い境界を取りこぼすと
     真のピッチの2倍・3倍を返す（平坦な面が多いアニメ調の画像で起きやすい）。
     間を割った位置にもエッジが残っているなら、そちらが本当のピッチとみなす。 */
  function refineGridStep(profile, step) {
    if (!step || step < 6 || !profile.length) return step;
    let total = 0;
    for (const value of profile) total += value;
    const mean = total / profile.length;
    if (mean <= 0) return step;
    // 1pxのずれを許して、その位置のエッジの強さを見る
    const peakAt = (position) => {
      let peak = 0;
      for (let offset = -1; offset <= 1; offset += 1) {
        const value = profile[position + offset] || 0;
        if (value > peak) peak = value;
      }
      return peak;
    };
    for (const divisor of [3, 2]) {
      const candidate = step / divisor;
      if (candidate < 3) continue;
      let boundary = 0;
      let boundaryCount = 0;
      let inside = 0;
      let insideCount = 0;
      for (let k = 1; k * candidate < profile.length - 1; k += 1) {
        if (k % divisor === 0) continue;  // 既に検出できている境界は数えない
        boundary += peakAt(Math.round(k * candidate));
        boundaryCount += 1;
        const middle = Math.round((k + 0.5) * candidate);
        if (middle < profile.length - 1) {
          inside += peakAt(middle);
          insideCount += 1;
        }
      }
      if (boundaryCount < 3 || !insideCount) continue;
      const boundaryMean = boundary / boundaryCount;
      const insideMean = inside / insideCount;
      /* 実画像はどこにもテクスチャの反応があるため、強さの絶対値では判定できない。
         境界候補が「ドットの内側」よりはっきり強い時だけ本物の境界とみなす。
         こうすると、雑音の多い画像で不要に細かく割ってざらつくのを防げる。 */
      if (boundaryMean > mean && boundaryMean > insideMean * 2) return candidate;
    }
    return step;
  }

  /* にじみのない鮮明な格子では、境界のエッジが同じ値2つの「台地」になり、
     estimateGridStep の「両隣より大きい」判定にどこも当てはまらず null になる。
     台地をひとつの山として数え直すことで、その場合だけ救う。
     既に検出できている画像には触れないので、動いているものは変わらない。 */
  function estimateGridStepPlateau(profile) {
    const length = profile.length;
    if (length < 8) return null;
    let maximum = 0;
    for (const value of profile) if (value > maximum) maximum = value;
    if (!maximum) return null;
    const threshold = maximum * 0.2;
    const centres = [];
    let index = 1;
    while (index < length - 1) {
      const value = profile[index];
      if (value <= threshold || value < profile[index - 1]) { index += 1; continue; }
      let end = index;
      while (end + 1 < length - 1 && profile[end + 1] === value) end += 1;
      if (end > index && profile[end + 1] <= value) centres.push((index + end) / 2);
      index = end + 1;
    }
    const clean = [];
    for (const centre of centres) {
      if (!clean.length || centre - clean[clean.length - 1] > 3) clean.push(centre);
    }
    if (clean.length < 4) return null;
    const differences = [];
    for (let i = 1; i < clean.length; i += 1) differences.push(clean[i] - clean[i - 1]);
    differences.sort((left, right) => left - right);
    const step = differences[Math.floor(differences.length / 2)];
    return step >= 2 ? step : null;
  }

  /* 周期をピークの間隔から求めると、ノイズで山が乱立した時に間隔の中央値が
     潰れる（実測: ノイズ±20で山が31本→228本、32pxの格子を8pxと誤検出）。
     自己相関なら、個々の山ではなく全体の繰り返し方を見るので影響を受けにくい。
     倍音（2倍・3倍のずらし幅）も高くなるため、最大値に近いものの中で
     最小のずらし幅を基本周期として採る。 */
  function estimateGridStepByPeriod(profile) {
    const length = profile.length;
    if (length < 32) return null;
    let sum = 0;
    for (const value of profile) sum += value;
    const mean = sum / length;
    let variance = 0;
    for (const value of profile) { const d = value - mean; variance += d * d; }
    if (variance <= 0) return null;
    const normaliser = variance / length;
    const maximumLag = Math.min(200, Math.floor(length / 4));
    const scores = [];
    for (let lag = 2; lag <= maximumLag; lag += 1) {
      let total = 0;
      for (let index = 0; index + lag < length; index += 1) {
        total += (profile[index] - mean) * (profile[index + lag] - mean);
      }
      scores.push((total / (length - lag)) / normaliser);
    }
    /* 実画像のプロファイルは滑らかなので、ずらし幅が小さいほど相関が高い。
       全体の最大値を採ると必ず lag=2 になってしまうため、
       「山になっている」ラグだけを候補にする。周期はその中の最小値。 */
    let best = 0;
    const peaks = [];
    for (let i = 1; i < scores.length - 1; i += 1) {
      if (scores[i] > scores[i - 1] && scores[i] >= scores[i + 1]) {
        peaks.push({ score: scores[i], lag: i + 2 });
        if (scores[i] > best) best = scores[i];
      }
    }
    if (!peaks.length || best <= 0.15) return null;
    for (const peak of peaks) {
      if (peak.score >= best * 0.85) return peak.lag >= 2 ? peak.lag : null;
    }
    return null;
  }

  function resolveGridStep(xStep, yStep) {
    if (xStep && yStep) {
      const ratio = Math.max(xStep, yStep) / Math.min(xStep, yStep);
      return ratio > 1.8 ? Math.min(xStep, yStep) : (xStep + yStep) / 2;
    }
    return xStep || yStep || null;
  }

  function walkGridCuts(profile, step, limit) {
    const cuts = [0];
    let sum = 0;
    for (const value of profile) sum += value;
    const mean = sum / Math.max(1, profile.length);
    const windowSize = Math.max(2, step * 0.35);
    let current = 0;
    while (current + step < limit) {
      const target = current + step;
      const start = Math.max(Math.floor(current + 1), Math.floor(target - windowSize));
      const end = Math.min(limit - 1, Math.ceil(target + windowSize));
      let bestIndex = Math.round(target);
      let bestValue = -1;
      for (let index = start; index <= end; index += 1) if (profile[index] > bestValue) {
        bestValue = profile[index];
        bestIndex = index;
      }
      const next = bestValue > mean * 0.5 ? bestIndex : Math.round(target);
      if (next <= current || next >= limit) break;
      cuts.push(next);
      current = next;
    }
    if (cuts[cuts.length - 1] !== limit) cuts.push(limit);
    return [...new Set(cuts)].sort((left, right) => left - right);
  }

  /* 検出した格子が破綻している時だけ、等間隔グリッドで引き直す安全網。
     平坦な面が続いてエッジを拾えない領域で walkGridCuts がセル幅を取りこぼし、
     「大きさの違うドット」が残る問題への対策。
     考え方は Pixel Snapper (MIT / Hugo-Dz) を参考にした独自実装。 */
  const GRID_MAX_STEP_RATIO = 1.8;  // 縦横のドット幅の比がこれを超えたら破綻とみなす
  const GRID_SEARCH_WINDOW = 0.35;  // 理想位置から切れ目を探す範囲（セル幅比）
  const GRID_EDGE_STRENGTH = 0.5;   // 窓内のエッジがプロファイル平均のこの倍数未満なら理想位置を使う
  const GRID_MIN_CUTS = 5;
  const GRID_MIN_PERIODICITY = 0.25;  // これ未満は格子ではなく写真等とみなす
  const GRID_OPAQUE_ALPHA = 128;  // これ未満の画素は縁のにじみとみなし、色を決める投票から外す

  function sanitizeGridCuts(cuts, limit) {
    const clamped = cuts
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.min(limit, Math.round(value))));
    const unique = [...new Set(clamped)].sort((left, right) => left - right);
    if (unique[0] !== 0) unique.unshift(0);
    if (unique[unique.length - 1] !== limit) unique.push(limit);
    return unique;
  }

  function snapUniformGridCuts(profile, limit, targetStep) {
    if (limit <= 1) return [0, Math.max(1, limit)];
    const requested = targetStep > 0 ? Math.round(limit / targetStep) : 0;
    const cells = Math.max(GRID_MIN_CUTS - 1, Math.min(limit, Math.max(1, requested)));
    const cellWidth = limit / cells;
    const searchWindow = Math.max(1, cellWidth * GRID_SEARCH_WINDOW);
    let sum = 0;
    for (const value of profile) sum += value;
    const mean = sum / Math.max(1, profile.length);
    const cuts = [0];
    for (let index = 1; index < cells; index += 1) {
      const target = cellWidth * index;
      const previous = cuts[cuts.length - 1];
      if (previous + 1 >= limit) break;
      const start = Math.max(previous + 1, Math.floor(target - searchWindow));
      const end = Math.min(limit - 1, Math.ceil(target + searchWindow));
      let bestIndex = start;
      let bestValue = -1;
      for (let position = start; position <= end && position < profile.length; position += 1) {
        if (profile[position] > bestValue) {
          bestValue = profile[position];
          bestIndex = position;
        }
      }
      // 窓の中に十分なエッジが無ければ、周期から求めた理想位置をそのまま使う。
      // 平坦な面（mean が 0）では bestValue も 0 になるため、比較は <= にする
      // （< だと 0 < 0 が偽になり、切れ目が窓の左端に寄ってセル幅が乱れる）
      if (bestValue <= mean * GRID_EDGE_STRENGTH) {
        bestIndex = Math.min(limit - 1, Math.max(previous + 1, Math.round(target)));
      }
      cuts.push(bestIndex);
    }
    return sanitizeGridCuts(cuts, limit);
  }

  function stabilizeGridAxis(profile, cuts, limit, siblingCuts, siblingLimit) {
    const safe = sanitizeGridCuts(cuts, limit);
    const cells = safe.length - 1;
    const siblingCells = siblingCuts.length - 1;
    const siblingUsable = siblingLimit > 0 && siblingCells >= GRID_MIN_CUTS - 1;
    let skewed = false;
    if (siblingUsable && cells > 0) {
      const ratio = (limit / cells) / (siblingLimit / siblingCells);
      skewed = ratio > GRID_MAX_STEP_RATIO || ratio < 1 / GRID_MAX_STEP_RATIO;
    }
    if (safe.length >= GRID_MIN_CUTS && !skewed) return safe;
    const fallbackStep = cells > 0 ? limit / cells : limit;
    const targetStep = siblingUsable ? siblingLimit / siblingCells : fallbackStep;
    return snapUniformGridCuts(profile, limit, targetStep > 0 ? targetStep : 1);
  }

  /* 検出したドット幅が正しくても、歩進が近くの強いエッジへ吸い寄せられて
     セル数が理論値から1〜2ずれることがある（1024px/8px なら本来128セル）。
     ずれが小さいうちは等間隔で引き直した方が、元絵のドットと正確に重なる。 */
  function alignGridCellCount(profile, cuts, limit, step) {
    if (!step || step < 2) return cuts;
    const expected = Math.round(limit / step);
    const cells = cuts.length - 1;
    if (expected < GRID_MIN_CUTS - 1 || cells === expected) return cuts;
    if (Math.abs(cells - expected) > Math.max(1, expected * 0.2)) return cuts;  // 大きくズレる時は触らない
    return snapUniformGridCuts(profile, limit, limit / expected);
  }

  function stabilizeGridAxes(profiles, columns, rows, width, height, step, preserveWalkerCuts = false) {
    // 1回目: 各軸を、もう一方の生の切れ目を基準に検証する
    const stabilizedColumns = stabilizeGridAxis(profiles.columns, columns, width, rows, height);
    const stabilizedRows = stabilizeGridAxis(profiles.rows, rows, height, columns, width);
    const columnPass = preserveWalkerCuts
      ? stabilizedColumns
      : alignGridCellCount(profiles.columns, stabilizedColumns, width, step);
    const rowPass = preserveWalkerCuts
      ? stabilizedRows
      : alignGridCellCount(profiles.rows, stabilizedRows, height, step);
    // 2回目: 結果同士がまだ食い違うなら、細かい方のドット幅に合わせ直す
    const columnStep = width / Math.max(1, columnPass.length - 1);
    const rowStep = height / Math.max(1, rowPass.length - 1);
    const ratio = columnStep > rowStep ? columnStep / rowStep : rowStep / columnStep;
    if (ratio <= GRID_MAX_STEP_RATIO) return { columns: columnPass, rows: rowPass };
    const targetStep = Math.min(columnStep, rowStep);
    return {
      columns: columnStep > targetStep * 1.2
        ? snapUniformGridCuts(profiles.columns, width, targetStep)
        : columnPass,
      rows: rowStep > targetStep * 1.2
        ? snapUniformGridCuts(profiles.rows, height, targetStep)
        : rowPass
    };
  }

  /* 画像の幅・高さがドット間隔の整数倍とは限らないので、端に半端な幅のセルができる。
     そこは元絵の縁だけを拾って別の色になり、縁に1列だけ違う色の筋が出る。
     十分に細ければ隣のセルへ吸収させる（画素は捨てず、多数決で埋もれさせる）。 */
  function mergeEdgeGridCells(cuts) {
    if (cuts.length < 4) return cuts;
    const merged = [...cuts];
    const widths = [];
    for (let index = 1; index < merged.length; index += 1) widths.push(merged[index] - merged[index - 1]);
    const sorted = [...widths].sort((left, right) => left - right);
    const typical = sorted[Math.floor(sorted.length / 2)];  // 端の半端は少数なので中央値は本来の幅になる
    if (!typical) return merged;
    const minimum = typical * 0.6;
    if (merged.length >= 4 && merged[merged.length - 1] - merged[merged.length - 2] < minimum) {
      merged.splice(merged.length - 2, 1);
    }
    if (merged.length >= 4 && merged[1] - merged[0] < minimum) {
      merged.splice(1, 1);
    }
    return merged;
  }

  /* 検出した周期がどれだけ確からしいかを自己相関で測る。
     ドット絵は境界が等間隔に並ぶので、周期ぶんずらすと強く相関する。
     写真は格子が無いため、たまたま周期が見つかっても相関は低い。 */
  function gridPeriodicity(profile, step) {
    const lag = Math.round(step);
    const length = profile.length;
    if (!lag || lag < 2 || length < lag * 4) return 0;
    let sum = 0;
    for (const value of profile) sum += value;
    const mean = sum / length;
    let variance = 0;
    for (const value of profile) { const d = value - mean; variance += d * d; }
    if (variance <= 0) return 0;
    let correlation = 0;
    for (let index = 0; index + lag < length; index += 1) {
      correlation += (profile[index] - mean) * (profile[index + lag] - mean);
    }
    return (correlation / (length - lag)) / (variance / length);
  }

  function snapSourceGrid(source, sourceWidth, sourceHeight) {
    const imageWidth = source.naturalWidth || source.width;
    const imageHeight = source.naturalHeight || source.height;
    const analysis = document.createElement("canvas");
    /* 格子の検出精度は解析解像度で決まる。1024pxに縮めると1254pxの画像で
       13.06px の間隔が 13.5px と測れてしまい、出力が93ドット（本来96）になる。
       1600pxまで上げると3枚の実画像すべてで真の間隔と一致した。
       解析コストは増えるが、実測で最大2.5秒程度に収まる。 */
    const analysisScale = Math.min(1, 1600 / Math.max(imageWidth, imageHeight));
    analysis.width = Math.max(8, Math.round(imageWidth * analysisScale));
    analysis.height = Math.max(8, Math.round(imageHeight * analysisScale));
    const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
    analysisContext.imageSmoothingEnabled = false;
    analysisContext.drawImage(source, 0, 0, analysis.width, analysis.height);
    const sourcePixels = analysisContext.getImageData(0, 0, analysis.width, analysis.height);
    const analysisPixels = gridAnalysisPixels(sourcePixels.data, analysis.width, analysis.height);
    const profiles = gridProfiles(analysisPixels, analysis.width, analysis.height);
    const estimatedColumnStep = estimateGridStepByPeriod(profiles.columns)
      ?? estimateGridStep(profiles.columns) ?? estimateGridStepPlateau(profiles.columns);
    const estimatedRowStep = estimateGridStepByPeriod(profiles.rows)
      ?? estimateGridStep(profiles.rows) ?? estimateGridStepPlateau(profiles.rows);
    /* Pixel Snapper互換の補正では、ピーク間隔の中央値をそのまま使う。
       通常モード向けの細分化を重ねると16px格子を8pxと誤認し、
       論理サイズが縦横とも約2倍になってベタ面が細切れになる。 */
    let detectedStep = resolveGridStep(
      usesStructuredGrid() ? estimatedColumnStep : refineGridStep(profiles.columns, estimatedColumnStep),
      usesStructuredGrid() ? estimatedRowStep : refineGridStep(profiles.rows, estimatedRowStep)
    );
    const maximumStep = Math.min(analysis.width, analysis.height) / 2;
    if (!detectedStep || detectedStep < 2 || detectedStep > maximumStep) {
      if (!usesStructuredGrid()) return null;
      detectedStep = Math.max(2, Math.min(maximumStep, Math.min(analysis.width, analysis.height) / 64));
    }
    /* 写真には本来ドットの格子が無いが、わずかな繰り返しを拾って
       ブロックの大きさが画像ごとにバラついてしまう。両方の軸で周期が
       はっきりしている時だけ格子として扱い、そうでなければ null を返して
       「ドットの大きさで刻む」従来の動作に任せる。
       実測: ドット絵4枚 0.51〜0.82 / 実写写真 0.10。閾値は低めに置き、
       本物の格子を取りこぼす方を避ける。 */
    const periodicity = Math.min(
      gridPeriodicity(profiles.columns, detectedStep),
      gridPeriodicity(profiles.rows, detectedStep)
    );
    if (periodicity < GRID_MIN_PERIODICITY && !usesStructuredGrid()) return null;
    const outputScale = sourceWidth / imageWidth;
    const detectedBlock = detectedStep / analysisScale * outputScale;
    if (!gridSizeAdjusted) pixelSize.value = String(Math.max(1, Math.min(MAX_PIXEL_SIZE, Math.round(detectedBlock * 2) / 2)));
    const requestedBlock = Number(pixelSize.value);
    const requestedStep = requestedBlock / outputScale * analysisScale;
    const step = Math.max(2, Math.min(requestedStep, Math.min(analysis.width, analysis.height) / 2));
    let columns = walkGridCuts(profiles.columns, step, analysis.width);
    let rows = walkGridCuts(profiles.rows, step, analysis.height);
    if (styleSettings[activeStyle]?.gridStabilize) {
      /* セル数の基準は、実際に切れ目を刻むのと同じ step を使う（検出値の生データではない）。
         縮小した解析用キャンバス上の測定値には誤差が乗るため、
         1254pxの実画像では検出12.2pxより丸めた12.0pxの方が真の周期に近かった。 */
      ({ columns, rows } = stabilizeGridAxes(
        profiles,
        columns,
        rows,
        analysis.width,
        analysis.height,
        step,
        usesStructuredGrid()
      ));
    }
    if (!usesStructuredGrid()) {
      columns = mergeEdgeGridCells(columns);
      rows = mergeEdgeGridCells(rows);
    }
    if (columns.length < 5 || rows.length < 5 || columns.length > 514 || rows.length > 514) return null;
    const snapped = document.createElement("canvas");
    snapped.width = columns.length - 1;
    snapped.height = rows.length - 1;
    const snappedContext = snapped.getContext("2d", { willReadFrequently: true });
    const output = snappedContext.createImageData(snapped.width, snapped.height);
    const usesQuantizedCellVoting = usesStructuredGrid();
    for (let row = 0; row < snapped.height; row += 1) for (let column = 0; column < snapped.width; column += 1) {
      const histogram = new Map();
      for (let y = rows[row]; y < rows[row + 1]; y += 1) for (let x = columns[column]; x < columns[column + 1]; x += 1) {
        const offset = (y * analysis.width + x) * 4;
        const alpha = analysisPixels[offset + 3];
        /* 縁のアンチエイリアスは背景と混ざった色を持つ。これを不透明扱いで投票させると、
           輪郭に沿って元絵に無い色（肌色の縁など）の筋が残る。半分以上不透明な画素だけ数える。 */
        const quantizedColor = [
          analysisPixels[offset],
          analysisPixels[offset + 1],
          analysisPixels[offset + 2],
          alpha
        ];
        const key = usesQuantizedCellVoting
          ? quantizedColor.join(",")
          : alpha < GRID_OPAQUE_ALPHA ? -1 : ((analysisPixels[offset] >> 4) << 8) | ((analysisPixels[offset + 1] >> 4) << 4) | (analysisPixels[offset + 2] >> 4);
        const entry = histogram.get(key) || { count: 0, rgba: [0, 0, 0, 0] };
        entry.count += 1;
        if (usesQuantizedCellVoting) entry.rgba = quantizedColor;
        else {
          entry.rgba[0] += sourcePixels.data[offset];
          entry.rgba[1] += sourcePixels.data[offset + 1];
          entry.rgba[2] += sourcePixels.data[offset + 2];
          entry.rgba[3] += sourcePixels.data[offset + 3];
        }
        histogram.set(key, entry);
      }
      const winner = [...histogram.entries()].sort((left, right) => {
        const countDifference = right[1].count - left[1].count;
        if (countDifference) return countDifference;
        return usesQuantizedCellVoting
          ? String(left[0]).localeCompare(String(right[0]))
          : left[0] - right[0];
      })[0];
      const target = (row * snapped.width + column) * 4;
      if (!winner || (!usesQuantizedCellVoting && winner[0] === -1)) continue;
      const entry = winner[1];
      const divisor = usesQuantizedCellVoting ? 1 : entry.count;
      output.data[target] = Math.round(entry.rgba[0] / divisor);
      output.data[target + 1] = Math.round(entry.rgba[1] / divisor);
      output.data[target + 2] = Math.round(entry.rgba[2] / divisor);
      output.data[target + 3] = Math.round(entry.rgba[3] / divisor);
    }
    snappedContext.putImageData(output, 0, 0);
    return { canvas: snapped, block: step / analysisScale * outputScale, detectedBlock, sourceWidth, sourceHeight };
  }

  function isTwoTone() {
    return activeStyle === "two-tone";
  }

  function usesStructuredGrid() {
    return activeStyle === "refine" || activeStyle === "craft";
  }

  // 8bit値を5bit(32段階)に落として8bitへ戻す。SFCの色刻みに合わせるため。
  function quantizeRgb555(color) {
    return color.map((value) => {
      const level = Math.max(0, Math.min(255, Math.round(value))) >> 3;
      return (level << 3) | (level >> 2);
    });
  }

  function dedupePaletteColors(colors) {
    const seen = new Set();
    const unique = [];
    for (const color of colors) {
      const key = `${color[0]},${color[1]},${color[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(color);
    }
    return unique;
  }

  function applyGameHardwareSettings() {
    const hardware = gameHardwareSettings[gameHardware] || gameHardwareSettings.gb;
    colorCount.value = String(hardware.colors);
    edgeBoost.value = String(hardware.edge);
    outline = hardware.outline;
  }

  function setGameHardware(value) {
    if (!gameHardwareSettings[value] || gameHardware === value) return;
    gameHardware = value;
    applyGameHardwareSettings();
    updateControlState();
    scheduleRender(`${gameHardwareSettings[value].label}の色に切り替えました。`);
    track("pixel_game_hardware", { hardware: value });
  }

  function fixedPalette() {
    if (isTwoTone()) return [hexToRgb(inkColor.value)];
    if (["refine", "craft", "auto", "photo"].includes(activeStyle)) return null;
    if (activeStyle === "custom") return customInputs.map((item) => hexToRgb(item.value));
    if (activeStyle === "game") {
      if (gameHardware === "fc") return palettes.famicom.map(hexToRgb);
      // SFCは固定パレットが無いので適応パレットを使い、後段でRGB555に丸める
      if (gameHardware === "sfc") return null;
      return palettes.game.map(hexToRgb);
    }
    return (palettes[activeStyle] || palettes.retro).map(hexToRgb);
  }

  function processPixels(data, width, height, palette, count) {
    const diffusionStrength = dither === "soft" ? 0.45 : dither === "hard" ? 1 : 0;
    const alpha = new Uint8Array(width * height);
    const values = new Float32Array(width * height * 3);
    const saturationAmount = Number(saturationBoost.value) / 100;
    const contrastAmount = Number(contrastBoost.value) / 100;

    for (let index = 0; index < width * height; index += 1) {
      alpha[index] = data[index * 4 + 3];
      const original = [data[index * 4], data[index * 4 + 1], data[index * 4 + 2]];
      const contrasted = contrastAmount > 0 ? adjustContrast(original, contrastAmount) : original;
      const adjusted = saturationAmount > 0 ? adjustSaturation(contrasted, saturationAmount) : contrasted;
      values[index * 3] = adjusted[0];
      values[index * 3 + 1] = adjusted[1];
      values[index * 3 + 2] = adjusted[2];
    }

    const edgeAmount = Number(edgeBoost.value) / 100;
    if (edgeAmount > 0) {
      const source = values.slice();
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          if (alpha[index] < 8) continue;
          const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
            .filter(([nx, ny]) => nx >= 0 && nx < width && ny >= 0 && ny < height && alpha[ny * width + nx] >= 8);
          if (!neighbors.length) continue;
          for (let channel = 0; channel < 3; channel += 1) {
            const average = neighbors.reduce((sum, [nx, ny]) => sum + source[(ny * width + nx) * 3 + channel], 0) / neighbors.length;
            const current = source[index * 3 + channel];
            values[index * 3 + channel] = clamp(current + (current - average) * edgeAmount * 1.15);
          }
        }
      }
    }

    const basePalette = palette || adaptivePalette(values, alpha, count);
    let chosenPalette = isTwoTone()
      ? basePalette
      : mergeSimilarPaletteColors(basePalette, palettePopulations(values, alpha, basePalette));
    // スーパーファミコンは各チャンネル5bit。出力色は必ずパレットから選ばれるので、
    // パレット側を丸めておけば全画素が実機で表現できる色になる。
    if (activeStyle === "game" && gameHardware === "sfc") {
      chosenPalette = dedupePaletteColors(chosenPalette.map(quantizeRgb555));
    }
    if (isTwoTone()) {
      const tones = new Float32Array(width * height);
      for (let index = 0; index < alpha.length; index += 1) {
        if (alpha[index] >= 8) {
          tones[index] = clamp01(rgbLightness(values[index * 3], values[index * 3 + 1], values[index * 3 + 2])) * 255;
        }
      }

      const ink = chosenPalette[0];
      const paper = hexToRgb(paperColor.value);
      const paperMode = toneBackground === "paper";
      const threshold = Number(toneThreshold.value) * 2.55;
      const inkTone = paperMode ? clamp01(rgbLightness(ink[0], ink[1], ink[2])) * 255 : 0;
      const paperTone = paperMode ? clamp01(rgbLightness(paper[0], paper[1], paper[2])) * 255 : 255;

      const diffuseTone = (x, y, error, amount) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const position = y * width + x;
        if (alpha[position] >= 8) tones[position] += error * amount * diffusionStrength;
      };

      for (let y = 0; y < height; y += 1) {
        const reverse = y % 2 === 1;
        const start = reverse ? width - 1 : 0;
        const end = reverse ? -1 : width;
        const direction = reverse ? -1 : 1;
        for (let x = start; x !== end; x += direction) {
          const index = y * width + x;
          const offset = index * 4;
          if (alpha[index] < 8) {
            if (paperMode) {
              data[offset] = paper[0];
              data[offset + 1] = paper[1];
              data[offset + 2] = paper[2];
              data[offset + 3] = 255;
            } else {
              data[offset] = 0;
              data[offset + 1] = 0;
              data[offset + 2] = 0;
              data[offset + 3] = 0;
            }
            continue;
          }

          const tone = tones[index];
          const useInk = tone <= threshold;
          const output = useInk ? ink : paper;
          data[offset] = output[0];
          data[offset + 1] = output[1];
          data[offset + 2] = output[2];
          data[offset + 3] = paperMode ? 255 : (useInk ? alpha[index] : 0);

          if (diffusionStrength) {
            const error = tone - (useInk ? inkTone : paperTone);
            diffuseTone(x + direction, y, error, 7 / 16);
            diffuseTone(x - direction, y + 1, error, 3 / 16);
            diffuseTone(x, y + 1, error, 5 / 16);
            diffuseTone(x + direction, y + 1, error, 1 / 16);
          }
        }
      }
      return paperMode ? [ink, paper] : [ink];
    }

    const pick = paletteMatcher(chosenPalette);
    const diffuse = (x, y, error, amount) => {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      const position = y * width + x;
      if (alpha[position] < 8) return;
      values[position * 3] += error[0] * amount * diffusionStrength;
      values[position * 3 + 1] += error[1] * amount * diffusionStrength;
      values[position * 3 + 2] += error[2] * amount * diffusionStrength;
    };

    for (let y = 0; y < height; y += 1) {
      const reverse = y % 2 === 1;
      const start = reverse ? width - 1 : 0;
      const end = reverse ? -1 : width;
      const direction = reverse ? -1 : 1;
      for (let x = start; x !== end; x += direction) {
        const index = y * width + x;
        const offset = index * 4;
        if (data[offset + 3] === 0) continue;
        const rgb = [values[index * 3], values[index * 3 + 1], values[index * 3 + 2]];
        const next = pick(rgb);
        const error = [rgb[0] - next[0], rgb[1] - next[1], rgb[2] - next[2]];
        data[offset] = clamp(next[0]);
        data[offset + 1] = clamp(next[1]);
        data[offset + 2] = clamp(next[2]);
        if (diffusionStrength) {
          diffuse(x + direction, y, error, 7 / 16);
          diffuse(x - direction, y + 1, error, 3 / 16);
          diffuse(x, y + 1, error, 5 / 16);
          diffuse(x + direction, y + 1, error, 1 / 16);
        }
      }
    }

    if (outline !== "off") {
      const edgeMap = new Uint8Array(width * height);
      const lightness = new Float32Array(width * height);
      for (let index = 0; index < width * height; index += 1) {
        lightness[index] = rgbLightness(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
      }

      const compare = (first, second) => {
        const firstVisible = alpha[first] >= 8;
        const secondVisible = alpha[second] >= 8;
        if (firstVisible !== secondVisible) {
          edgeMap[firstVisible ? first : second] = 1;
          return;
        }
        if (!firstVisible || Math.abs(lightness[first] - lightness[second]) < 0.16) return;
        edgeMap[lightness[first] <= lightness[second] ? first : second] = 1;
      };

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          if (x + 1 < width) compare(index, index + 1);
          if (y + 1 < height) compare(index, index + width);
        }
      }

      const outlineColor = outline === "black"
        ? [0, 0, 0]
        : chosenPalette.reduce((darkest, color) => (
          rgbLightness(color[0], color[1], color[2]) < rgbLightness(darkest[0], darkest[1], darkest[2]) ? color : darkest
        ), chosenPalette[0]);
      for (let index = 0; index < edgeMap.length; index += 1) {
        if (!edgeMap[index]) continue;
        const offset = index * 4;
        data[offset] = outlineColor[0];
        data[offset + 1] = outlineColor[1];
        data[offset + 2] = outlineColor[2];
      }
    }

    return chosenPalette;
  }

  /* 手打ちのドット絵では、同じ色がつながる「色のかたまり」を意識する。
     ここでは線や差し色を壊さないよう、同色の隣接が一つもない点だけを対象にする。
     周囲の75%以上が同じ、かつ色差が小さい時に限って置き換える。 */
  function tidyPixelClusters(data, width, height) {
    if (dither !== "off" || width < 2 || height < 2) return 0;
    const source = new Uint8ClampedArray(data);
    const colorKey = (offset) => source[offset + 3] < 8
      ? "transparent"
      : `${source[offset]},${source[offset + 1]},${source[offset + 2]}`;
    let changed = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        if (source[offset + 3] < 8) continue;
        const currentKey = colorKey(offset);
        const counts = new Map();
        const samples = new Map();
        let neighbors = 0;
        let connected = false;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighborOffset = (ny * width + nx) * 4;
            const key = colorKey(neighborOffset);
            neighbors += 1;
            if (key === currentKey) connected = true;
            counts.set(key, (counts.get(key) || 0) + 1);
            if (!samples.has(key)) samples.set(key, neighborOffset);
          }
        }

        if (connected || !neighbors) continue;
        const [dominantKey, dominantCount] = [...counts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
        if (dominantCount < Math.ceil(neighbors * 0.75)) continue;

        if (dominantKey === "transparent") {
          // 星や目の光など、意図的な1ドットを消さない。不透明度の低い縁の破片だけを除く。
          if (source[offset + 3] >= 128) continue;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 0;
        } else {
          const sample = samples.get(dominantKey);
          const currentLab = rgbToOklab([source[offset], source[offset + 1], source[offset + 2]]);
          const dominantLab = rgbToOklab([source[sample], source[sample + 1], source[sample + 2]]);
          const distance = Math.hypot(
            (currentLab[0] - dominantLab[0]) * 1.2,
            currentLab[1] - dominantLab[1],
            currentLab[2] - dominantLab[2]
          );
          if (distance > 0.075) continue;
          data[offset] = source[sample];
          data[offset + 1] = source[sample + 1];
          data[offset + 2] = source[sample + 2];
          // 輪郭の半透明度は変えず、形が太ったり欠けたりするのを避ける。
          data[offset + 3] = source[offset + 3];
        }
        changed += 1;
      }
    }
    return changed;
  }

  function updatePalettePreview(palette) {
    const safePalette = palette.length ? palette : [[1, 70, 234]];
    currentPaletteHex = safePalette.map(rgbToHex);
    if (paletteCopyButton) paletteCopyButton.disabled = currentPaletteHex.length === 0;
    const sorted = [...safePalette].sort((left, right) => rgbToOklab(left)[0] - rgbToOklab(right)[0]);
    const visible = sorted.length <= 16
      ? sorted
      : Array.from({ length: 16 }, (_, index) => sorted[Math.round(index * (sorted.length - 1) / 15)]);
    palettePreview.replaceChildren(...visible.map((rgb) => {
      const swatch = document.createElement("span");
      swatch.style.backgroundColor = `rgb(${rgb.map(Math.round).join(",")})`;
      return swatch;
    }));
    palettePreview.style.gridTemplateColumns = `repeat(${visible.length}, minmax(0, 1fr))`;
  }

  function tileStats(targetContext, width, height, tileSize = 8) {
    const pixels = targetContext.getImageData(0, 0, width, height).data;
    const columns = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    const unique = new Set();
    for (let tileY = 0; tileY < rows; tileY += 1) {
      for (let tileX = 0; tileX < columns; tileX += 1) {
        let firstHash = 2166136261;
        let secondHash = 2246822519;
        for (let y = 0; y < tileSize; y += 1) {
          for (let x = 0; x < tileSize; x += 1) {
            const sourceX = tileX * tileSize + x;
            const sourceY = tileY * tileSize + y;
            for (let channel = 0; channel < 4; channel += 1) {
              const value = sourceX < width && sourceY < height
                ? pixels[(sourceY * width + sourceX) * 4 + channel]
                : 0;
              firstHash ^= value;
              firstHash = Math.imul(firstHash, 16777619);
              secondHash ^= value + channel * 31;
              secondHash = Math.imul(secondHash, 3266489917);
            }
          }
        }
        unique.add(`${firstHash >>> 0}:${secondHash >>> 0}`);
      }
    }
    return { columns, rows, unique: unique.size };
  }

  function updateConversionStats(width, height, paletteCount, targetContext = smallContext) {
    if (!conversionStats || !width || !height || !targetContext) return;
    const tiles = tileStats(targetContext, width, height);
    logicalSizeStat.textContent = `${width} × ${height}ドット`;
    actualColorsStat.textContent = `${paletteCount}色`;
    tileGridStat.textContent = `${tiles.columns} × ${tiles.rows}枚`;
    uniqueTilesStat.textContent = `${tiles.unique}枚`;
    conversionStats.hidden = false;
  }

  function rgbToHex(rgb) {
    return `#${rgb.map((value) => Math.round(clamp(value)).toString(16).padStart(2, "0")).join("")}`;
  }

  async function copyPaletteCodes() {
    if (editor.mode === "editing") return;
    if (renderFrame) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      if (editor.mode === "edited" && renderSettingsKey() !== lastRender.settingsKey) {
        if (!applyEditedSettingsChange()) return;
      } else if (editor.mode === "convert" && !renderCurrentSettings()) return;
    }
    if (!currentPaletteHex.length) {
      setStatus("画像を選ぶと色コードをコピーできます。", true);
      return;
    }
    const colors = currentPaletteHex.map((color) => color.toUpperCase());
    const text = colors.join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand("copy");
        area.remove();
        if (!copied) throw new Error("clipboard unavailable");
      }
      setStatus(`${colors.length}色のカラーコードをコピーしました。`);
      track("pixel_palette_copy", { palette_size: colors.length });
    } catch (error) {
      console.error("[PIXEL MAKER PALETTE COPY]", error);
      setStatus("色コードをコピーできませんでした。", true);
    }
  }

  function paletteFromContext(targetContext, width, height, limit = 12) {
    if (!targetContext || !width || !height) return [[1, 70, 234]];
    const data = targetContext.getImageData(0, 0, width, height).data;
    const counts = new Map();
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] < 8) continue;
      const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const colors = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([key]) => [(key >> 16) & 255, (key >> 8) & 255, key & 255]);
    return colors.length ? colors : [[1, 70, 234]];
  }

  function setEditorStatus(message = "") {
    if (editorStatus) editorStatus.textContent = message;
  }

  function syncEditorModeUi() {
    const hasImage = Boolean(sourceImage && canvas.width && smallCanvas.width && editContext);
    if (editToggleButton) editToggleButton.hidden = !hasImage;
    if (editToggleButton) editToggleButton.disabled = isLoadingImage;
    if (mainActions) mainActions.classList.toggle("has-edit", hasImage);

    const locked = editor.mode === "editing";
    if (settingsPanel) {
      settingsPanel.inert = locked;
      settingsPanel.classList.toggle("is-locked", locked);
      settingsPanel.classList.toggle("is-waiting", !sourceImage);
      settingsPanel.setAttribute("aria-disabled", String(locked));
    }
    if (editedNote) editedNote.hidden = editor.mode !== "edited";
  }

  function updateEditorPalette() {
    if (!editContext || !editCanvas.width || !editCanvas.height || !editPalette) return;
    const colors = paletteFromContext(editContext, editCanvas.width, editCanvas.height, 12);
    const available = colors.map(rgbToHex);
    if (!available.includes(editor.color.toLowerCase())) editor.color = available[0];
    if (editColorInput) editColorInput.value = editor.color;

    editPalette.replaceChildren(...colors.map((rgb, index) => {
      const color = rgbToHex(rgb);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "edit-color-button";
      button.dataset.color = color;
      button.style.setProperty("--edit-color", color);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `色${index + 1}、${color.toUpperCase()}`);
      button.setAttribute("aria-checked", String(editor.tool === "paint" && editor.color === color));
      button.addEventListener("click", () => {
        editor.color = color;
        if (editColorInput) editColorInput.value = color;
        setEditorTool("paint");
      });
      return button;
    }));
  }

  function updateEditorCursor(ensureVisible = false) {
    if (!editCursor || !editCanvas.width || !editCanvas.height) return;
    editor.cursorX = Math.max(0, Math.min(editCanvas.width - 1, editor.cursorX));
    editor.cursorY = Math.max(0, Math.min(editCanvas.height - 1, editor.cursorY));
    editCursor.style.left = `${editor.cursorX / editCanvas.width * 100}%`;
    editCursor.style.top = `${editor.cursorY / editCanvas.height * 100}%`;
    editCursor.style.width = `${100 / editCanvas.width}%`;
    editCursor.style.height = `${100 / editCanvas.height}%`;

    if (!ensureVisible || !editCanvasScroll || !editCanvasFrame) return;
    const scaleX = editCanvasFrame.offsetWidth / editCanvas.width;
    const scaleY = editCanvasFrame.offsetHeight / editCanvas.height;
    const left = editCanvasFrame.offsetLeft + editor.cursorX * scaleX;
    const top = editCanvasFrame.offsetTop + editor.cursorY * scaleY;
    const right = left + scaleX;
    const bottom = top + scaleY;
    if (left < editCanvasScroll.scrollLeft) editCanvasScroll.scrollLeft = Math.max(0, left - 12);
    else if (right > editCanvasScroll.scrollLeft + editCanvasScroll.clientWidth) {
      editCanvasScroll.scrollLeft = right - editCanvasScroll.clientWidth + 12;
    }
    if (top < editCanvasScroll.scrollTop) editCanvasScroll.scrollTop = Math.max(0, top - 12);
    else if (bottom > editCanvasScroll.scrollTop + editCanvasScroll.clientHeight) {
      editCanvasScroll.scrollTop = bottom - editCanvasScroll.clientHeight + 12;
    }
  }

  function updateEditorCanvasLabel(scale = 1) {
    if (!editCanvas) return;
    const toolName = editor.tool === "fill" ? "面を塗る" : editor.tool === "erase" ? "消す" : editor.tool === "pan" ? "移動" : "塗る";
    const keyboardHelp = editor.tool === "pan"
      ? "矢印キーで画像を移動できます。"
      : "矢印キーで位置を動かし、Enterかスペースで編集できます。";
    editCanvas.setAttribute(
      "aria-label",
      `ドット編集キャンバス。${editCanvas.width}×${editCanvas.height}ドット。${toolName}モード。表示${Math.round(scale * 100)}%。${keyboardHelp}`
    );
  }

  function applyEditorZoom(preserveCenter = true) {
    if (!editCanvasScroll || !editCanvasFrame || !editCanvas.width || !editCanvas.height) return;
    const oldWidth = editCanvasFrame.getBoundingClientRect().width || editCanvas.width;
    const oldHeight = editCanvasFrame.getBoundingClientRect().height || editCanvas.height;
    const centerX = Math.max(0, Math.min(1,
      (editCanvasScroll.scrollLeft + editCanvasScroll.clientWidth / 2 - editCanvasFrame.offsetLeft) / oldWidth
    ));
    const centerY = Math.max(0, Math.min(1,
      (editCanvasScroll.scrollTop + editCanvasScroll.clientHeight / 2 - editCanvasFrame.offsetTop) / oldHeight
    ));

    const availableWidth = Math.max(1, editCanvasScroll.clientWidth - 32);
    const availableHeight = Math.max(1, editCanvasScroll.clientHeight - 32);
    const scale = editor.fit
      ? Math.max(0.1, Math.min(availableWidth / editCanvas.width, availableHeight / editCanvas.height))
      : editor.cellSize;
    const nextWidth = Math.max(1, editCanvas.width * scale);
    const nextHeight = Math.max(1, editCanvas.height * scale);
    editCanvasFrame.style.width = `${nextWidth}px`;
    editCanvasFrame.style.height = `${nextHeight}px`;
    if (editFitButton) editFitButton.setAttribute("aria-pressed", String(editor.fit));
    if (editZoomOutButton) editZoomOutButton.disabled = editor.fit;
    if (editZoomInButton) editZoomInButton.disabled = scale >= MAX_EDIT_CELL_SIZE;
    updateEditorCanvasLabel(scale);
    updateEditorCursor();

    if (!preserveCenter) {
      editCanvasScroll.scrollLeft = Math.max(0, (nextWidth - editCanvasScroll.clientWidth) / 2);
      editCanvasScroll.scrollTop = Math.max(0, (nextHeight - editCanvasScroll.clientHeight) / 2);
      return;
    }
    window.requestAnimationFrame(() => {
      editCanvasScroll.scrollLeft = Math.max(0,
        editCanvasFrame.offsetLeft + centerX * nextWidth - editCanvasScroll.clientWidth / 2
      );
      editCanvasScroll.scrollTop = Math.max(0,
        editCanvasFrame.offsetTop + centerY * nextHeight - editCanvasScroll.clientHeight / 2
      );
    });
  }

  function stepEditorZoom(direction) {
    if (!editCanvasFrame || !editCanvas.width) return;
    const steps = [2, 4, 6, 8, 12, 16, 24, 32, 48, MAX_EDIT_CELL_SIZE];
    const current = editCanvasFrame.getBoundingClientRect().width / editCanvas.width;
    const fitScale = Math.max(0.1, Math.min(
      Math.max(1, editCanvasScroll.clientWidth - 32) / editCanvas.width,
      Math.max(1, editCanvasScroll.clientHeight - 32) / editCanvas.height
    ));
    if (direction > 0) {
      const next = steps.find((value) => value > current + 0.05);
      if (next == null) return;
      editor.cellSize = next;
      editor.fit = false;
    } else {
      const lower = [...steps].reverse().find((value) => value < current - 0.05);
      if (lower == null || lower <= fitScale) editor.fit = true;
      else {
        editor.cellSize = lower;
        editor.fit = false;
      }
    }
    applyEditorZoom();
  }

  function setEditorTool(tool) {
    if (!['paint', 'fill', 'erase', 'pan'].includes(tool)) return;
    editor.tool = tool;
    if (editCanvas) editCanvas.dataset.tool = tool;
    if (editCursor) editCursor.hidden = tool === "pan";
    if (paintEditButton) paintEditButton.setAttribute("aria-pressed", String(tool === "paint"));
    if (fillEditButton) fillEditButton.setAttribute("aria-pressed", String(tool === "fill"));
    if (eraseEditButton) eraseEditButton.setAttribute("aria-pressed", String(tool === "erase"));
    if (panEditButton) panEditButton.setAttribute("aria-pressed", String(tool === "pan"));
    if (editorHelp) {
      editorHelp.textContent = tool === "fill"
        ? "タップした場所と同じ色の、つながった面をまとめて塗ります。"
        : tool === "erase"
        ? "タップまたはなぞったドットを透明にします。"
        : tool === "pan"
          ? "画像をドラッグして移動します。"
          : "タップまたはなぞって塗れます。";
    }
    editPalette?.querySelectorAll("[role='radio']").forEach((button) => {
      button.setAttribute("aria-checked", String((tool === "paint" || tool === "fill") && button.dataset.color === editor.color));
    });
    updateEditorCanvasLabel(editCanvasFrame && editCanvas.width
      ? editCanvasFrame.getBoundingClientRect().width / editCanvas.width
      : 1);
  }

  function pointerToCell(event) {
    if (!editCanvas?.width || !editCanvas.height) return null;
    const rect = editCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
    return {
      x: Math.max(0, Math.min(editCanvas.width - 1, Math.floor((event.clientX - rect.left) / rect.width * editCanvas.width))),
      y: Math.max(0, Math.min(editCanvas.height - 1, Math.floor((event.clientY - rect.top) / rect.height * editCanvas.height)))
    };
  }

  function beginEditorStroke() {
    editor.stroke = new Map();
    editor.lastCell = null;
  }

  function paintEditorCell(x, y) {
    if (!editContext || !editor.stroke) return false;
    const current = editContext.getImageData(x, y, 1, 1).data;
    const desired = editor.tool === "erase"
      ? [0, 0, 0, 0]
      : [...hexToRgb(editor.color), 255];
    if (current[0] === desired[0] && current[1] === desired[1]
      && current[2] === desired[2] && current[3] === desired[3]) return false;

    const index = y * editCanvas.width + x;
    if (!editor.stroke.has(index)) editor.stroke.set(index, Array.from(current));
    if (editor.tool === "erase") editContext.clearRect(x, y, 1, 1);
    else {
      editContext.fillStyle = editor.color;
      editContext.fillRect(x, y, 1, 1);
    }
    editor.cursorX = x;
    editor.cursorY = y;
    updateEditorCursor();
    return true;
  }

  function paintEditorLine(from, to) {
    let x = from.x;
    let y = from.y;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const sx = from.x < to.x ? 1 : -1;
    const sy = from.y < to.y ? 1 : -1;
    let error = dx - dy;
    while (true) {
      paintEditorCell(x, y);
      if (x === to.x && y === to.y) break;
      const doubled = error * 2;
      if (doubled > -dy) { error -= dy; x += sx; }
      if (doubled < dx) { error += dx; y += sy; }
    }
  }

  function floodFillEditor(cell) {
    if (!cell || !editContext || !editor.stroke) return false;
    const image = editContext.getImageData(0, 0, editCanvas.width, editCanvas.height);
    const data = image.data;
    const start = (cell.y * editCanvas.width + cell.x) * 4;
    const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    const fill = [...hexToRgb(editor.color), 255];
    if (target.every((value, index) => value === fill[index])) return false;
    const matches = (offset) => target.every((value, index) => data[offset + index] === value);
    const stack = [cell.x, cell.y];
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < 0 || y < 0 || x >= editCanvas.width || y >= editCanvas.height) continue;
      const index = y * editCanvas.width + x;
      const offset = index * 4;
      if (!matches(offset)) continue;
      if (!editor.stroke.has(index)) editor.stroke.set(index, target.slice());
      data[offset] = fill[0]; data[offset + 1] = fill[1]; data[offset + 2] = fill[2]; data[offset + 3] = fill[3];
      stack.push(x - 1, y, x + 1, y, x, y - 1, x, y + 1);
    }
    editContext.putImageData(image, 0, 0);
    return true;
  }

  function continueEditorStroke(cell) {
    if (!cell || !editor.stroke) return;
    paintEditorLine(editor.lastCell || cell, cell);
    editor.lastCell = cell;
  }

  function endEditorStroke() {
    if (!editor.stroke) return;
    if (editor.stroke.size) {
      editor.undo.push({
        width: editCanvas.width,
        height: editCanvas.height,
        changes: [...editor.stroke.entries()]
      });
      if (editor.undo.length > 50) {
        editor.undo.shift();
        editor.undoFloorDirty = true;
      }
      editor.dirty = true;
    }
    editor.stroke = null;
    editor.lastCell = null;
    if (undoEditButton) undoEditButton.disabled = editor.undo.length === 0;
  }

  function undoEditorStroke() {
    if (!editContext || !editor.undo.length) return;
    const stroke = editor.undo.pop();
    if (stroke.width !== editCanvas.width || stroke.height !== editCanvas.height) {
      editor.undo.length = 0;
      editor.dirty = false;
      if (undoEditButton) undoEditButton.disabled = true;
      return;
    }
    const image = editContext.getImageData(0, 0, editCanvas.width, editCanvas.height);
    stroke.changes.forEach(([index, color]) => {
      const offset = index * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3];
    });
    editContext.putImageData(image, 0, 0);
    editor.dirty = editor.undoFloorDirty || editor.undo.length > 0;
    if (undoEditButton) undoEditButton.disabled = editor.undo.length === 0;
    setEditorStatus("1つ前の状態に戻しました。");
  }

  function redrawOutputFromSmall() {
    if (!context || !smallCanvas.width || !lastRender.block) return;
    canvas.width = smallCanvas.width * lastRender.block;
    canvas.height = smallCanvas.height * lastRender.block;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(smallCanvas, 0, 0, canvas.width, canvas.height);
    const palette = paletteFromContext(smallContext, smallCanvas.width, smallCanvas.height, 1024);
    updatePalettePreview(palette);
    updateConversionStats(smallCanvas.width, smallCanvas.height, palette.length);
    paletteStatus.textContent = "手直し後の色を表示しています";
    const saveLogicalGrid = outputDots > 0 || (usesStructuredGrid() && detectedGridSize > 0);
    stageMeta.textContent = saveLogicalGrid
      ? `ドット ${smallCanvas.width} × ${smallCanvas.height} / PNG ${smallCanvas.width} × ${smallCanvas.height}px`
      : `ドット ${smallCanvas.width} × ${smallCanvas.height} / PNG ${canvas.width} × ${canvas.height}px`;
    canvas.setAttribute("aria-label", `手直し後のドット絵プレビュー。${smallCanvas.width}×${smallCanvas.height}ドット`);
  }

  function closePixelEditor(restoreFocus = true) {
    editor.pointerId = null;
    editor.pan = null;
    editor.stroke = null;
    setEditorDiscardOpen(false);
    if (pixelEditorDialog?.open && typeof pixelEditorDialog.close === "function") pixelEditorDialog.close();
    else pixelEditorDialog?.removeAttribute("open");
    if (restoreFocus) window.setTimeout(() => editToggleButton?.focus(), 0);
  }

  function finalizeEditorInteraction() {
    const pointerId = editor.pointerId;
    if (editor.stroke) endEditorStroke();
    editor.pan = null;
    editor.pointerId = null;
    if (pointerId != null) {
      try { editCanvas?.releasePointerCapture(pointerId); } catch (_) { /* Pointer capture is optional. */ }
    }
  }

  function setEditorDiscardOpen(open) {
    if (!editorDiscard || !pixelEditorDialog) return;
    editorDiscard.hidden = !open;
    pixelEditorDialog.querySelectorAll(".editor-header, .editor-workspace, .editor-controls").forEach((region) => {
      region.inert = open;
    });
    if (open) continueEditButton?.focus();
  }

  function startPixelEdit() {
    if (isLoadingImage || !sourceImage || !editContext || !smallCanvas.width || !smallCanvas.height) return;
    if (renderFrame) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      if (editor.mode === "edited" && renderSettingsKey() !== lastRender.settingsKey) {
        if (!applyEditedSettingsChange()) return;
      } else if (editor.mode === "convert" && !renderCurrentSettings()) return;
    }
    editor.entryMode = editor.mode;
    editor.mode = "editing";
    editor.tool = "paint";
    editor.undo.length = 0;
    editor.undoFloorDirty = false;
    editor.stroke = null;
    editor.pointerId = null;
    editor.pan = null;
    editor.dirty = false;
    editor.fit = true;
    editor.cursorX = 0;
    editor.cursorY = 0;
    editCanvas.width = smallCanvas.width;
    editCanvas.height = smallCanvas.height;
    editContext.clearRect(0, 0, editCanvas.width, editCanvas.height);
    editContext.imageSmoothingEnabled = false;
    editContext.drawImage(smallCanvas, 0, 0);
    if (undoEditButton) undoEditButton.disabled = true;
    setEditorDiscardOpen(false);
    setEditorStatus("");
    updateEditorPalette();
    setEditorTool("paint");
    syncEditorModeUi();

    if (typeof pixelEditorDialog?.showModal === "function") pixelEditorDialog.showModal();
    else pixelEditorDialog?.setAttribute("open", "");
    window.requestAnimationFrame(() => {
      applyEditorZoom(false);
      updateEditorCursor();
      pixelEditorTitle?.focus();
    });
    track("pixel_edit_start");
  }

  function requestClosePixelEditor() {
    finalizeEditorInteraction();
    if (!editor.dirty) {
      editor.mode = editor.entryMode;
      closePixelEditor();
      syncEditorModeUi();
      return;
    }
    setEditorDiscardOpen(true);
  }

  function discardPixelEdit() {
    editor.mode = editor.entryMode;
    editor.dirty = false;
    editor.undo.length = 0;
    editor.undoFloorDirty = false;
    closePixelEditor();
    syncEditorModeUi();
    setStatus("今回の手直しを破棄しました。");
  }

  function finishPixelEdit() {
    if (!editContext || editor.mode !== "editing") return;
    finalizeEditorInteraction();
    const changed = editor.dirty;
    if (changed) {
      smallContext.clearRect(0, 0, smallCanvas.width, smallCanvas.height);
      smallContext.imageSmoothingEnabled = false;
      smallContext.drawImage(editCanvas, 0, 0);
      redrawOutputFromSmall();
    }
    editor.mode = changed || editor.entryMode === "edited" ? "edited" : "convert";
    editor.dirty = false;
    editor.undo.length = 0;
    editor.undoFloorDirty = false;
    closePixelEditor();
    syncEditorModeUi();
    setStatus(changed ? "手直しを反映しました。PNGで保存できます。" : "編集を終えました。");
    if (changed) track("pixel_edit_finish");
  }

  function returnToConversion() {
    if (!sourceImage) return;
    editor.mode = "convert";
    editor.entryMode = "convert";
    editor.undo.length = 0;
    editor.undoFloorDirty = false;
    editor.dirty = false;
    syncEditorModeUi();
    scheduleRender("手直しをリセットしました。設定を変更できます。");
  }

  function resetEditorState(restoreFocus = false) {
    editor.mode = "convert";
    editor.entryMode = "convert";
    editor.tool = "paint";
    editor.undo.length = 0;
    editor.undoFloorDirty = false;
    editor.stroke = null;
    editor.pointerId = null;
    editor.pan = null;
    editor.dirty = false;
    editor.fit = true;
    editor.cursorX = 0;
    editor.cursorY = 0;
    lastRender = { width: 0, height: 0, block: 0, paletteCount: 0, settingsKey: "" };
    if (editCanvas) {
      editCanvas.width = 0;
      editCanvas.height = 0;
    }
    closePixelEditor(restoreFocus);
    syncEditorModeUi();
  }

  function handleEditorPointerDown(event) {
    if (editor.mode !== "editing" || !editCanvas) return;
    if (editor.pointerId != null) return;
    event.preventDefault();
    if (document.activeElement !== editCanvas) {
      try { editCanvas.focus({ preventScroll: true }); } catch (_) { editCanvas.focus(); }
    }
    editor.pointerId = event.pointerId;
    try { editCanvas.setPointerCapture(event.pointerId); } catch (_) { /* Pointer capture is optional. */ }

    if (editor.tool === "pan") {
      editor.pan = {
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: editCanvasScroll.scrollLeft,
        scrollTop: editCanvasScroll.scrollTop
      };
      return;
    }

    const cell = pointerToCell(event);
    if (!cell) {
      editor.pointerId = null;
      return;
    }
    beginEditorStroke();
    if (editor.tool === "fill") {
      floodFillEditor(cell);
      endEditorStroke();
      editor.pointerId = null;
      try { editCanvas.releasePointerCapture(event.pointerId); } catch (_) { /* Pointer capture is optional. */ }
      return;
    }
    continueEditorStroke(cell);
  }

  function handleEditorPointerMove(event) {
    if (editor.mode !== "editing" || event.pointerId !== editor.pointerId) return;
    event.preventDefault();
    if (editor.pan) {
      editCanvasScroll.scrollLeft = editor.pan.scrollLeft - (event.clientX - editor.pan.startX);
      editCanvasScroll.scrollTop = editor.pan.scrollTop - (event.clientY - editor.pan.startY);
      return;
    }
    continueEditorStroke(pointerToCell(event));
  }

  function handleEditorPointerEnd(event) {
    if (event.pointerId !== editor.pointerId) return;
    event.preventDefault();
    if (!editor.pan && editor.stroke) continueEditorStroke(pointerToCell(event));
    endEditorStroke();
    editor.pan = null;
    editor.pointerId = null;
    try { editCanvas.releasePointerCapture(event.pointerId); } catch (_) { /* Pointer capture is optional. */ }
  }

  function handleEditorKeydown(event) {
    if (editor.mode !== "editing") return;
    const moves = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    };
    if (moves[event.key]) {
      event.preventDefault();
      if (editor.tool === "pan") {
        editCanvasScroll.scrollLeft += moves[event.key][0] * 44;
        editCanvasScroll.scrollTop += moves[event.key][1] * 44;
        return;
      }
      editor.cursorX += moves[event.key][0];
      editor.cursorY += moves[event.key][1];
      updateEditorCursor(true);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && editor.tool !== "pan") {
      event.preventDefault();
      beginEditorStroke();
      if (editor.tool === "fill") floodFillEditor({ x: editor.cursorX, y: editor.cursorY });
      else continueEditorStroke({ x: editor.cursorX, y: editor.cursorY });
      endEditorStroke();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      stepEditorZoom(1);
    } else if (event.key === "-") {
      event.preventDefault();
      stepEditorZoom(-1);
    } else if (event.key === "0") {
      event.preventDefault();
      editor.fit = true;
      applyEditorZoom();
    }
  }

  function updateControlState() {
    const usesDetectedGridOutput = usesStructuredGrid();
    document.querySelectorAll("[data-style]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.style === activeStyle));
    });
    document.querySelectorAll("[data-output-dots]").forEach((button) => {
    button.addEventListener("click", () => setOutputDots(button.dataset.outputDots));
  });
  pixelSize.addEventListener("input", () => { if (outputDots > 0) setOutputDots(0); });
  document.querySelectorAll("[data-game-hardware]").forEach((button) => {
    button.addEventListener("click", () => setGameHardware(button.dataset.gameHardware));
  });
  document.querySelectorAll("[data-dither]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.dither === dither));
    });
    document.querySelectorAll("[data-flat-fill]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.flatFill === flatFill));
    });
    document.querySelectorAll("[data-accent-keep]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.accentKeep === (accentKeep ? "on" : "off")));
    });
    document.querySelectorAll("[data-grid-snap]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.gridSnap === gridSnap));
    });
    document.querySelectorAll("[data-outline]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.outline === outline));
    });
    document.querySelectorAll("[data-background]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.background === toneBackground));
    });

    styleHelp.textContent = activeStyle === "game"
      ? (gameHardwareSettings[gameHardware] || gameHardwareSettings.gb).description
      : styleDescriptions[activeStyle];
    pixelSizeOut.textContent = `${Number(pixelSize.value).toFixed(1)} px`;
    if (gridSnapStatus) gridSnapStatus.textContent = gridSnap === "auto"
        ? (detectedGridSize ? `検出 ${detectedGridSize.toFixed(1)}px / 使用 ${appliedGridSize.toFixed(1)}px。スライダーで調整できます。` : "画像を選ぶと元のドット間隔を検出します。検出後もスライダーで調整できます。")
        : "スライダーでドットの大きさを決めます。元の形を保ちやすいモードです。";
    saturationOut.textContent = `${saturationBoost.value}%`;
    contrastOut.textContent = `${contrastBoost.value}%`;
    edgeOut.textContent = `${edgeBoost.value}%`;
    toneThresholdOut.textContent = `${toneThreshold.value}%`;

    const fixed = fixedPalette();
    const colorLocked = Boolean(fixed);
    colorCount.disabled = colorLocked;
    document.querySelectorAll("[data-accent-keep]").forEach((button) => {
      button.disabled = colorLocked || isTwoTone();
    });
    if (isTwoTone()) colorCountOut.textContent = toneBackground === "paper" ? "2色" : "1色＋透明";
    else if (fixed) colorCountOut.textContent = `${fixed.length}色`;
    else colorCountOut.textContent = `${colorCount.value}色`;

    twoToneSettings.hidden = !isTwoTone();
    customSettings.hidden = activeStyle !== "custom";
    if (gameSettings) gameSettings.hidden = activeStyle !== "game";
    document.querySelectorAll("[data-output-dots]").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.outputDots) === outputDots));
      button.disabled = usesDetectedGridOutput;
    });
    // 出力サイズを指定している間は、ドットの大きさは結果として決まるので触らせない
    pixelSize.disabled = outputDots > 0;
    document.querySelectorAll("[data-game-hardware]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.gameHardware === gameHardware));
    });
    outlineSettings.hidden = isTwoTone();

    if (!sourceImage) {
      updatePalettePreview(fixed || [[19, 32, 51], [97, 112, 134], [169, 200, 255], [244, 247, 251]]);
      if (fixed) paletteStatus.textContent = `${fixed.length}色の固定配色です`;
      else {
        currentPaletteHex = [];
        if (paletteCopyButton) paletteCopyButton.disabled = true;
        paletteStatus.textContent = "画像を選ぶと色が表示されます";
      }
    }
  }

  function setStyle(style, announce = true) {
    const next = styleSettings[style];
    if (!next) return;
    activeStyle = style;
    if (style === "refine" || style === "craft") outputDots = 0;
    pixelSize.value = String(next.pixel);
    if (next.colors) colorCount.value = String(next.colors);
    dither = next.dither;
    gridSnap = next.gridSnap || "off";
    detectedGridSize = 0;
    appliedGridSize = 0;
    gridSizeAdjusted = false;
    accentKeep = Boolean(next.accentKeep);
    flatFill = next.flatFill;
    outline = next.outline;
    saturationBoost.value = String(next.saturation);
    contrastBoost.value = String(next.contrast);
    edgeBoost.value = String(next.edge);
    if (next.threshold != null) toneThreshold.value = String(next.threshold);
    if (style === "game") applyGameHardwareSettings();
    updateControlState();
    scheduleRender(announce && sourceImage ? "仕上がりを変更しました。" : "");
    if (announce) track("pixel_style_change", { style_name: style });
  }

  function setOutputDots(value) {
    const next = Number(value) || 0;
    if (outputDots === next) return;
    outputDots = next;
    updateControlState();
    scheduleRender(next > 0 ? `長辺${next}ドットで書き出します。` : "ドットの大きさで決める設定に戻しました。");
    if (next > 0) track("pixel_output_size", { dots: next });
  }

  /* 出力サイズの決め方。
     出力ドット数が指定されていれば「長辺が指定ドット数」になるよう、縦横比を保って割り当てる。
     未指定なら従来どおり、格子検出の結果かドットの大きさから求める。 */
  function resolveOutputSize(sourceWidth, sourceHeight, block, snapped) {
    if (outputDots > 0) {
      const longest = Math.max(1, Math.max(sourceWidth, sourceHeight));
      // 元画像より細かくしても情報は増えないので、長辺のピクセル数で頭打ちにする
      const dots = Math.min(outputDots, longest);
      const ratio = dots / longest;
      return {
        width: Math.max(1, Math.min(dots, Math.round(sourceWidth * ratio))),
        height: Math.max(1, Math.min(dots, Math.round(sourceHeight * ratio))),
        block: Math.max(1, longest / dots)
      };
    }
    if (snapped) return { width: snapped.canvas.width, height: snapped.canvas.height, block };
    return {
      width: Math.max(1, Math.round(sourceWidth / block)),
      height: Math.max(1, Math.round(sourceHeight / block)),
      block
    };
  }

  function render() {
    updateControlState();
    if (editor.mode !== "convert") return;
    if (!sourceImage || !context || !smallContext) return;

    const block = Number(pixelSize.value);
    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
    const sourceWidth = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
    const sourceHeight = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
    /* サイズ指定中でも格子検出は通す。先に元絵のドットを組み直してから
       目的のドット数へ変換しないと、にじんだ元画像をそのまま間引くことになり
       縁の中間色を拾ってしまう。出力サイズの決定だけ指定値を優先する。 */
    const snapped = gridSnap === "auto" && activeStyle !== "photo"
      ? snapSourceGrid(sourceImage, sourceWidth, sourceHeight) : null;
    const { width, height, block: appliedBlock } = resolveOutputSize(sourceWidth, sourceHeight, block, snapped);

    smallCanvas.width = width;
    smallCanvas.height = height;
    smallContext.clearRect(0, 0, width, height);
    const photoSampling = activeStyle === "photo";
    smallContext.imageSmoothingEnabled = photoSampling;
    if (photoSampling) smallContext.imageSmoothingQuality = "high";
    if (snapped) smallContext.drawImage(snapped.canvas, 0, 0, width, height);
    else smallContext.drawImage(sourceImage, 0, 0, width, height);

    const fixed = fixedPalette();
    let palette;
    if (usesStructuredGrid() && snapped) {
      // Pixel Snapper と同じく、セル多数決で選んだ量子化色をそのまま使う。
      // ここで元画像パレットへ再変換すると、ベタ面に別の色が戻ってしまう。
      if (activeStyle === "craft") {
        const pixels = smallContext.getImageData(0, 0, width, height);
        tidyPixelClusters(pixels.data, width, height);
        smallContext.putImageData(pixels, 0, 0);
      }
      palette = paletteFromContext(smallContext, width, height, 64);
    } else {
      const requestedPalette = fixed || stableAutoPalette(Number(colorCount.value));
      const pixels = smallContext.getImageData(0, 0, width, height);
      palette = processPixels(pixels.data, width, height, requestedPalette, Number(colorCount.value));
      if (activeStyle === "craft") tidyPixelClusters(pixels.data, width, height);
      smallContext.putImageData(pixels, 0, 0);
      if (activeStyle === "craft") palette = paletteFromContext(smallContext, width, height, 64);
    }

    const upscaled = snapped && outputDots === 0;
    canvas.width = upscaled ? sourceWidth : Math.max(1, Math.round(width * appliedBlock));
    canvas.height = upscaled ? sourceHeight : Math.max(1, Math.round(height * appliedBlock));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(smallCanvas, 0, 0, canvas.width, canvas.height);

    detectedGridSize = snapped ? snapped.detectedBlock : 0;
    appliedGridSize = snapped && outputDots === 0 ? snapped.block : appliedBlock;
    updateControlState();
    updatePalettePreview(palette);
    updateConversionStats(width, height, palette.length);
    if (isTwoTone()) paletteStatus.textContent = toneBackground === "paper" ? "選んだ2色で変換しています" : "1色と透明背景で変換しています";
    else if (fixed) paletteStatus.textContent = `${palette.length}色の固定配色です`;
    else paletteStatus.textContent = `元画像から${palette.length}色を選びました`;

    stage.classList.add("has-image");
    const saveLogicalGrid = usesStructuredGrid() && Boolean(snapped);
    const savedWidth = outputDots > 0 || saveLogicalGrid ? width : canvas.width;
    const savedHeight = outputDots > 0 || saveLogicalGrid ? height : canvas.height;
    stageMeta.textContent = `ドット ${width} × ${height} / PNG ${savedWidth} × ${savedHeight}px`;
    canvas.setAttribute("aria-label", `変換後のドット絵プレビュー。${width}×${height}ドット、${palette.length}色`);
    lastRender = { width, height, block: snapped && outputDots === 0 ? snapped.block : appliedBlock, paletteCount: palette.length, settingsKey: renderSettingsKey() };
    saveButton.disabled = false;
    resetButton.disabled = false;
    stage.setAttribute("aria-busy", "false");
    syncEditorModeUi();
  }

  function renderCurrentSettings(message = "") {
    try {
      render();
      if (message) setStatus(message);
      return true;
    } catch (error) {
      console.error("[PIXEL MAKER RENDER]", error);
      stage.setAttribute("aria-busy", "false");
      setStatus("変換できませんでした。別の画像か、少ない色数でお試しください。", true);
      return false;
    }
  }

  function applyEditedSettingsChange() {
    if (!sourceImage || editor.mode !== "edited") return false;
    if (renderSettingsKey() === lastRender.settingsKey) {
      stage.setAttribute("aria-busy", "false");
      return true;
    }

    let editedBackup;
    try {
      const smallCopy = document.createElement("canvas");
      smallCopy.width = smallCanvas.width;
      smallCopy.height = smallCanvas.height;
      const copyContext = smallCopy.getContext("2d");
      if (!copyContext) throw new Error("Canvas backup is unavailable");
      copyContext.imageSmoothingEnabled = false;
      copyContext.drawImage(smallCanvas, 0, 0);
      editedBackup = {
        smallCopy,
        lastRender: { ...lastRender },
        mode: editor.mode,
        entryMode: editor.entryMode,
        paletteHtml: palettePreview.innerHTML,
        paletteColumns: palettePreview.style.gridTemplateColumns,
        paletteHex: [...currentPaletteHex],
        paletteStatus: paletteStatus.textContent,
        stageMeta: stageMeta.textContent,
        canvasLabel: canvas.getAttribute("aria-label") || "手直し後のドット絵プレビュー"
      };
    } catch (error) {
      console.error("[PIXEL MAKER EDIT BACKUP]", error);
      restoreSettingsKey(lastRender.settingsKey);
      stage.setAttribute("aria-busy", "false");
      setStatus("設定を変更できなかったため、手直し済みの画像を残しています。", true);
      return false;
    }

    editor.mode = "convert";
    editor.entryMode = "convert";
    editor.undo.length = 0;
    editor.undoFloorDirty = false;
    editor.dirty = false;
    syncEditorModeUi();
    try {
      render();
      setStatus("設定を変更したため、手直しをリセットしました。");
      return true;
    } catch (error) {
      console.error("[PIXEL MAKER RENDER]", error);
      smallCanvas.width = editedBackup.smallCopy.width;
      smallCanvas.height = editedBackup.smallCopy.height;
      smallContext.clearRect(0, 0, smallCanvas.width, smallCanvas.height);
      smallContext.imageSmoothingEnabled = false;
      smallContext.drawImage(editedBackup.smallCopy, 0, 0);
      lastRender = editedBackup.lastRender;
      restoreSettingsKey(lastRender.settingsKey);
      canvas.width = lastRender.width * lastRender.block;
      canvas.height = lastRender.height * lastRender.block;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(smallCanvas, 0, 0, canvas.width, canvas.height);
      palettePreview.innerHTML = editedBackup.paletteHtml;
      palettePreview.style.gridTemplateColumns = editedBackup.paletteColumns;
      currentPaletteHex = editedBackup.paletteHex;
      if (paletteCopyButton) paletteCopyButton.disabled = currentPaletteHex.length === 0;
      paletteStatus.textContent = editedBackup.paletteStatus;
      stageMeta.textContent = editedBackup.stageMeta;
      canvas.setAttribute("aria-label", editedBackup.canvasLabel);
      editor.mode = editedBackup.mode;
      editor.entryMode = editedBackup.entryMode;
      saveButton.disabled = false;
      resetButton.disabled = false;
      stage.classList.add("has-image");
      stage.setAttribute("aria-busy", "false");
      syncEditorModeUi();
      setStatus("設定は反映されていません。手直し済みの画像を残しました。", true);
      return false;
    }
  }

  function scheduleRender(message = "") {
    updateControlState();
    if (editor.mode === "editing" || !sourceImage) return;
    window.cancelAnimationFrame(renderFrame);
    if (editor.mode === "edited") {
      if (renderSettingsKey() === lastRender.settingsKey) {
        stage.setAttribute("aria-busy", "false");
        renderFrame = 0;
        return;
      }
      stage.setAttribute("aria-busy", "true");
      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = 0;
        applyEditedSettingsChange();
      });
      return;
    }
    stage.setAttribute("aria-busy", "true");
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      renderCurrentSettings(message);
    });
  }

  function openImagePicker() {
    input.value = "";
    input.click();
  }

  function loadFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) {
      setStatus("この形式は読み込めません。JPG・PNG・WebPなどの画像を選んでください。", true);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus("画像が20MBを超えています。小さい画像を選んでください。", true);
      return;
    }

    isLoadingImage = true;
    syncEditorModeUi();
    setStatus("画像を読み込んでいます…");
    stage.setAttribute("aria-busy", "true");
    const requestId = ++loadRequestId;
    const candidateUrl = URL.createObjectURL(file);
    const candidateImage = new Image();
    candidateImage.onload = () => {
      if (requestId !== loadRequestId) {
        URL.revokeObjectURL(candidateUrl);
        return;
      }
      if (renderFrame) {
        window.cancelAnimationFrame(renderFrame);
        renderFrame = 0;
        if (sourceImage && editor.mode === "convert") {
          try { render(); } catch (error) { console.error("[PIXEL MAKER PREVIOUS RENDER]", error); }
        }
      }

      const previous = {
        sourceImage,
        sourceObjectUrl,
        mode: editor.mode,
        entryMode: editor.entryMode,
        lastRender: { ...lastRender },
        paletteHtml: palettePreview.innerHTML,
        paletteColumns: palettePreview.style.gridTemplateColumns,
        paletteHex: [...currentPaletteHex],
        paletteStatus: paletteStatus.textContent,
        stageMeta: stageMeta.textContent,
        canvasLabel: canvas.getAttribute("aria-label") || "変換後のドット絵プレビュー",
        hasImage: stage.classList.contains("has-image"),
        saveDisabled: saveButton.disabled,
        resetDisabled: resetButton.disabled,
        changeImageText: changeImageButton.textContent,
        originalSrc: originalPreview.getAttribute("src") || "",
        previewMode,
        settingsKey: renderSettingsKey(),
        outputDots
      };
      const previousUsable = Boolean(previous.sourceImage && smallCanvas.width && previous.lastRender.block && canvas.width);
      let previousSmall = null;
      if (previousUsable) {
        try {
          previousSmall = document.createElement("canvas");
          previousSmall.width = smallCanvas.width;
          previousSmall.height = smallCanvas.height;
          const previousSmallContext = previousSmall.getContext("2d");
          previousSmallContext.imageSmoothingEnabled = false;
          previousSmallContext.drawImage(smallCanvas, 0, 0);
        } catch (error) {
          console.error("[PIXEL MAKER LOAD BACKUP]", error);
          URL.revokeObjectURL(candidateUrl);
          isLoadingImage = false;
          stage.setAttribute("aria-busy", "false");
          syncEditorModeUi();
          setStatus("新しい画像を準備できませんでした。前の画像を残しています。", true);
          return;
        }
      }

      resetEditorState(false);
      sourceObjectUrl = candidateUrl;
      sourceImage = candidateImage;
      changeImageButton.textContent = "別の画像を選ぶ";
      resetButton.disabled = false;
      try {
        render();
      } catch (error) {
        console.error("[PIXEL MAKER LOAD RENDER]", error);
        URL.revokeObjectURL(candidateUrl);
        sourceObjectUrl = previous.sourceObjectUrl;
        sourceImage = previous.sourceImage;
        editor.mode = previous.mode;
        editor.entryMode = previous.entryMode;
        lastRender = previous.lastRender;
        restoreSettingsKey(previous.settingsKey);
        outputDots = previous.outputDots;
        updateControlState();
        if (previousUsable && previousSmall) {
          smallCanvas.width = previousSmall.width;
          smallCanvas.height = previousSmall.height;
          smallContext.clearRect(0, 0, smallCanvas.width, smallCanvas.height);
          smallContext.imageSmoothingEnabled = false;
          smallContext.drawImage(previousSmall, 0, 0);
          canvas.width = previous.lastRender.width * previous.lastRender.block;
          canvas.height = previous.lastRender.height * previous.lastRender.block;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.imageSmoothingEnabled = false;
          context.drawImage(smallCanvas, 0, 0, canvas.width, canvas.height);
        } else {
          smallCanvas.width = 0;
          smallCanvas.height = 0;
          canvas.width = 0;
          canvas.height = 0;
        }
        palettePreview.innerHTML = previous.paletteHtml;
        palettePreview.style.gridTemplateColumns = previous.paletteColumns;
        currentPaletteHex = previous.paletteHex;
        if (paletteCopyButton) paletteCopyButton.disabled = currentPaletteHex.length === 0;
        paletteStatus.textContent = previous.paletteStatus;
        stageMeta.textContent = previous.stageMeta;
        canvas.setAttribute("aria-label", previous.canvasLabel);
        stage.classList.toggle("has-image", previous.hasImage);
        saveButton.disabled = previous.saveDisabled;
        resetButton.disabled = previous.resetDisabled;
        changeImageButton.textContent = previous.changeImageText;
        if (previous.originalSrc) originalPreview.src = previous.originalSrc;
        else originalPreview.removeAttribute("src");
        setPreviewMode(previous.previewMode, false);
        isLoadingImage = false;
        stage.setAttribute("aria-busy", "false");
        syncEditorModeUi();
        setStatus(previousUsable ? "新しい画像を変換できなかったため、前の画像を残しました。" : "画像を変換できませんでした。別の画像をお試しください。", true);
        return;
      }
      originalPreview.src = candidateUrl;
      setPreviewMode("after", false);
      if (previous.sourceObjectUrl) URL.revokeObjectURL(previous.sourceObjectUrl);
      isLoadingImage = false;
      syncEditorModeUi();
      setStatus("変換できました。仕上がりを選んで調整できます。");
      track("pixel_image_loaded", {
        image_type: file.type || "unknown",
        image_size_band: file.size < 1024 * 1024 ? "under_1mb" : file.size < 5 * 1024 * 1024 ? "1_to_5mb" : "over_5mb"
      });
    };
    candidateImage.onerror = () => {
      URL.revokeObjectURL(candidateUrl);
      if (requestId !== loadRequestId) return;
      isLoadingImage = false;
      stage.setAttribute("aria-busy", "false");
      syncEditorModeUi();
      setStatus("画像を読み込めませんでした。別の画像を選んでお試しください。", true);
    };
    candidateImage.src = candidateUrl;
  }

  function resetAll() {
    loadRequestId += 1;
    isLoadingImage = false;
    window.cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
    sourceObjectUrl = "";
    sourceImage = null;
    originalPreview.removeAttribute("src");
    setPreviewMode("after", false);
    input.value = "";
    canvas.width = 0;
    canvas.height = 0;
    stage.classList.remove("has-image", "is-dragging");
    stage.removeAttribute("aria-busy");
    stageMeta.textContent = "まだ画像が選ばれていません";
    if (conversionStats) conversionStats.hidden = true;
    saveButton.disabled = true;
    resetButton.disabled = true;
    changeImageButton.textContent = "画像を選ぶ";
    inkColor.value = "#0146ea";
    paperColor.value = "#f5f7fb";
    toneBackground = "paper";
    customInputs.forEach((item, index) => { item.value = defaultCustomColors[index]; });
    resetEditorState(false);
    clearBatch();
    gameHardware = "gb";
    outputDots = 0;
    setStyle(DEFAULT_STYLE, false);
    setStatus("最初の状態に戻しました。");
  }

  function setBatchStatus(message, isError = false) {
    if (!batchStatus) return;
    batchStatus.textContent = message;
    batchStatus.classList.toggle("is-error", isError);
  }

  function clearBatch() {
    batchEntries = [];
    batchZipName = "holometer-pixel-batch";
    if (batchCount) batchCount.textContent = "0枚";
    if (zipExportButton) zipExportButton.disabled = true;
    if (spriteExportButton) spriteExportButton.disabled = true;
    if (batchProgress) {
      batchProgress.hidden = true;
      batchProgress.value = 0;
    }
    setBatchStatus("PNG・JPEG・WebP・GIF・BMPを最大250枚まで。GIFは先頭フレームを使います。");
  }

  function setBatchBusy(next) {
    batchBusy = next;
    if (next) {
      batchDisabledState = [...document.querySelectorAll("button, input, select")]
        .map((control) => ({ control, disabled: control.disabled }));
      batchDisabledState.forEach(({ control }) => { control.disabled = true; });
    } else {
      batchDisabledState.forEach(({ control, disabled }) => { control.disabled = disabled; });
      batchDisabledState = [];
      if (zipExportButton) zipExportButton.disabled = batchEntries.length === 0;
      if (spriteExportButton) spriteExportButton.disabled = batchEntries.length === 0;
    }
  }

  function cleanZipPath(path) {
    return path.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  }

  function imageMime(path) {
    const extension = path.split(".").pop().toLowerCase();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" })[extension]
      || "application/octet-stream";
  }

  function unzipBytes(bytes) {
    return new Promise((resolve, reject) => {
      if (!window.fflate?.unzip) {
        reject(new Error("ZIP ENGINE NOT READY"));
        return;
      }
      window.fflate.unzip(bytes, (error, files) => error ? reject(error) : resolve(files));
    });
  }

  function zipBytes(files) {
    return new Promise((resolve, reject) => {
      window.fflate.zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolve(data));
    });
  }

  async function loadBatchZip(file) {
    if (!file || batchBusy) return;
    if (file.size > BATCH_MAX_ZIP_BYTES) {
      setBatchStatus("ZIPは150MB以下にしてください。", true);
      return;
    }

    setBatchBusy(true);
    batchProgress.hidden = false;
    batchProgress.removeAttribute("value");
    setBatchStatus("ZIPを確認しています…");
    try {
      const files = await unzipBytes(new Uint8Array(await file.arrayBuffer()));
      const entries = [];
      let extractedBytes = 0;
      for (const [rawPath, bytes] of Object.entries(files)) {
        const path = cleanZipPath(rawPath);
        if (!path || path.startsWith("__MACOSX/") || !BATCH_IMAGE_EXTENSIONS.test(path)) continue;
        extractedBytes += bytes.byteLength;
        if (extractedBytes > BATCH_MAX_EXTRACTED_BYTES) throw new Error("EXTRACTED SIZE LIMIT");
        entries.push({ path, bytes, type: imageMime(path) });
        if (entries.length > BATCH_MAX_IMAGES) throw new Error("IMAGE COUNT LIMIT");
      }
      if (!entries.length) throw new Error("NO SUPPORTED IMAGES");

      batchEntries = entries;
      batchZipName = (file.name.replace(/\.zip$/i, "") || "holometer-pixel-batch").replace(/[^a-zA-Z0-9._-]+/g, "-");
      batchCount.textContent = `${entries.length}枚`;
      zipExportButton.disabled = false;
      spriteExportButton.disabled = false;
      batchProgress.max = entries.length;
      batchProgress.value = 0;
      const first = entries[0];
      loadFile(new File([first.bytes], first.path.split("/").pop(), { type: first.type }));
      setBatchStatus(`${entries.length}枚を読み込みました。先頭画像で仕上がりを決めてから、まとめて保存してください。`);
      track("pixel_batch_loaded", { image_count: entries.length });
    } catch (error) {
      clearBatch();
      const messages = {
        "EXTRACTED SIZE LIMIT": "展開後の合計容量が600MBを超えています。ZIPを分けてください。",
        "IMAGE COUNT LIMIT": "画像が250枚を超えています。ZIPを分けてください。",
        "NO SUPPORTED IMAGES": "対応画像が見つかりません。PNG・JPEG・WebP・GIF・BMPを入れてください。",
        "ZIP ENGINE NOT READY": "ZIP機能を読み込めませんでした。ページを再読み込みしてください。"
      };
      setBatchStatus(messages[error.message] || "ZIPを読み込めませんでした。ファイルが壊れていないか確認してください。", true);
    } finally {
      batchProgress.hidden = true;
      zipInput.value = "";
      setBatchBusy(false);
    }
  }

  function decodeImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.onload = () => resolve({ source: decoded, close: () => URL.revokeObjectURL(url) });
      decoded.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("IMAGE DECODE FAILED"));
      };
      decoded.src = url;
    });
  }

  function canvasPngBytes(sourceCanvas) {
    return new Promise((resolve, reject) => {
      sourceCanvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error("PNG ENCODE FAILED"));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, "image/png");
    });
  }

  function uniqueOutputPath(sourcePath, usedPaths) {
    const path = cleanZipPath(sourcePath);
    const slash = path.lastIndexOf("/");
    const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    const stem = fileName.replace(/\.[^.]+$/, "") || "image";
    let candidate = `${directory}${stem}-pixel.png`;
    let serial = 2;
    while (usedPaths.has(candidate.toLowerCase())) candidate = `${directory}${stem}-pixel-${serial++}.png`;
    usedPaths.add(candidate.toLowerCase());
    return candidate;
  }

  function renderBatchSource(source) {
    const imageWidth = source.naturalWidth || source.width;
    const imageHeight = source.naturalHeight || source.height;
    const block = Number(pixelSize.value);
    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(imageWidth, imageHeight));
    const sourceWidth = Math.max(1, Math.round(imageWidth * scale));
    const sourceHeight = Math.max(1, Math.round(imageHeight * scale));
    const snapped = gridSnap === "auto" && activeStyle !== "photo"
      ? snapSourceGrid(source, sourceWidth, sourceHeight) : null;
    const { width, height, block: appliedBlock } = resolveOutputSize(sourceWidth, sourceHeight, block, snapped);

    batchSmallCanvas.width = width;
    batchSmallCanvas.height = height;
    batchSmallContext.clearRect(0, 0, width, height);
    const photoSampling = activeStyle === "photo";
    batchSmallContext.imageSmoothingEnabled = photoSampling;
    if (photoSampling) batchSmallContext.imageSmoothingQuality = "high";
    if (snapped) batchSmallContext.drawImage(snapped.canvas, 0, 0, width, height);
    else batchSmallContext.drawImage(source, 0, 0, width, height);

    const saveLogicalGrid = usesStructuredGrid() && Boolean(snapped);
    if (saveLogicalGrid && activeStyle === "craft") {
      const pixels = batchSmallContext.getImageData(0, 0, width, height);
      tidyPixelClusters(pixels.data, width, height);
      batchSmallContext.putImageData(pixels, 0, 0);
    } else if (!saveLogicalGrid) {
      const fixed = fixedPalette();
      const requestedPalette = fixed || autoPaletteForSource(source, Number(colorCount.value));
      const pixels = batchSmallContext.getImageData(0, 0, width, height);
      processPixels(pixels.data, width, height, requestedPalette, Number(colorCount.value));
      if (activeStyle === "craft") tidyPixelClusters(pixels.data, width, height);
      batchSmallContext.putImageData(pixels, 0, 0);
    }

    if (outputDots > 0 || saveLogicalGrid) {
      // 単体保存と同じく、指定した時はドット等倍で書き出す
      batchCanvas.width = width;
      batchCanvas.height = height;
    } else {
      batchCanvas.width = snapped ? sourceWidth : Math.max(1, Math.round(width * appliedBlock));
      batchCanvas.height = snapped ? sourceHeight : Math.max(1, Math.round(height * appliedBlock));
    }
    const targetContext = batchCanvas.getContext("2d", { alpha: true });
    targetContext.clearRect(0, 0, batchCanvas.width, batchCanvas.height);
    targetContext.imageSmoothingEnabled = false;
    targetContext.drawImage(batchSmallCanvas, 0, 0, batchCanvas.width, batchCanvas.height);
  }

  function currentBatchSettings() {
    return {
      style: activeStyle,
      pixelSize: Number(pixelSize.value),
      colorCount: Number(colorCount.value),
      dither,
      gridSnap,
      accentKeep,
      flatFill,
      outline,
      saturation: Number(saturationBoost.value),
      contrast: Number(contrastBoost.value),
      edgeClean: Number(edgeBoost.value),
      twoTone: {
        ink: inkColor.value,
        paper: paperColor.value,
        threshold: Number(toneThreshold.value),
        background: toneBackground
      },
      customPalette: customInputs.map((control) => control.value)
    };
  }

  async function exportBatchZip() {
    if (!batchEntries.length || batchBusy) return;
    setBatchBusy(true);
    batchProgress.hidden = false;
    batchProgress.max = batchEntries.length;
    batchProgress.value = 0;
    setBatchStatus(`0 / ${batchEntries.length} 変換中…`);
    const outputFiles = {};
    const usedPaths = new Set();
    const failures = [];

    try {
      for (let index = 0; index < batchEntries.length; index += 1) {
        const entry = batchEntries[index];
        let decoded = null;
        try {
          decoded = await decodeImage(new Blob([entry.bytes], { type: entry.type }));
          const width = decoded.source.naturalWidth || decoded.source.width;
          const height = decoded.source.naturalHeight || decoded.source.height;
          if (!width || !height || width * height > BATCH_MAX_IMAGE_PIXELS) throw new Error("IMAGE SIZE LIMIT");
          renderBatchSource(decoded.source);
          outputFiles[uniqueOutputPath(entry.path, usedPaths)] = await canvasPngBytes(batchCanvas);
        } catch (error) {
          failures.push({ file: entry.path, reason: error.message || "CONVERT FAILED" });
        } finally {
          decoded?.close();
        }
        batchProgress.value = index + 1;
        setBatchStatus(`${index + 1} / ${batchEntries.length} 変換中…${failures.length ? ` / ${failures.length}件スキップ` : ""}`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const settings = {
        tool: "Holometer ドット絵変換ツール",
        generatedAt: new Date().toISOString(),
        inputArchive: `${batchZipName}.zip`,
        processed: Object.keys(outputFiles).length,
        failed: failures,
        settings: currentBatchSettings()
      };
      outputFiles["holometer-pixel-settings.json"] = window.fflate.strToU8(`${JSON.stringify(settings, null, 2)}\n`);
      setBatchStatus("PNGをZIPへまとめています…");
      const zipped = await zipBytes(outputFiles);
      downloadBlob(new Blob([zipped], { type: "application/zip" }), `${batchZipName}-pixel.zip`);
      setBatchStatus(`${Object.keys(outputFiles).length - 1}枚を書き出しました。${failures.length ? `${failures.length}件は設定JSONで確認できます。` : ""}`);
      track("pixel_batch_download", { processed: Object.keys(outputFiles).length - 1, failed: failures.length });
    } catch (error) {
      console.error("[PIXEL MAKER BATCH]", error);
      setBatchStatus("一括書き出しに失敗しました。ZIPを分けるか、少ない色数でお試しください。", true);
    } finally {
      setBatchBusy(false);
      batchProgress.hidden = true;
    }
  }

  async function exportSpriteSheet() {
    if (!batchEntries.length || batchBusy) return;
    const entries = batchEntries.slice(0, SPRITE_MAX_FRAMES);
    setBatchBusy(true);
    batchProgress.hidden = false;
    batchProgress.max = entries.length;
    batchProgress.value = 0;
    setBatchStatus(`0 / ${entries.length} フレーム変換中…`);
    const frames = [];
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const decoded = await decodeImage(new Blob([entry.bytes], { type: entry.type }));
        try {
          renderBatchSource(decoded.source);
          const frame = document.createElement("canvas");
          frame.width = batchCanvas.width; frame.height = batchCanvas.height;
          frame.getContext("2d", { alpha: true }).drawImage(batchCanvas, 0, 0);
          frames.push(frame);
        } finally { decoded.close(); }
        batchProgress.value = index + 1;
        setBatchStatus(`${index + 1} / ${entries.length} フレーム変換中…`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const columns = spriteColumns.value === "auto" ? Math.ceil(Math.sqrt(frames.length)) : Math.min(frames.length, Number(spriteColumns.value));
      const rows = Math.ceil(frames.length / columns);
      const cellWidth = Math.max(...frames.map((frame) => frame.width));
      const cellHeight = Math.max(...frames.map((frame) => frame.height));
      const width = cellWidth * columns; const height = cellHeight * rows;
      if (width * height > SPRITE_MAX_PIXELS || width > 16384 || height > 16384) throw new Error("SPRITE SIZE LIMIT");
      const sheet = document.createElement("canvas");
      sheet.width = width; sheet.height = height;
      const sheetContext = sheet.getContext("2d", { alpha: true });
      sheetContext.imageSmoothingEnabled = false;
      frames.forEach((frame, index) => sheetContext.drawImage(frame, (index % columns) * cellWidth, Math.floor(index / columns) * cellHeight));
      const blob = await new Promise((resolve, reject) => sheet.toBlob((value) => value ? resolve(value) : reject(new Error("PNG ENCODE FAILED")), "image/png"));
      downloadBlob(blob, `${batchZipName}-sprite-${columns}x${rows}.png`);
      setBatchStatus(`${frames.length}フレームを${columns}列×${rows}行で保存しました。${batchEntries.length > entries.length ? `先頭${SPRITE_MAX_FRAMES}枚を使用。` : ""}`);
      track("pixel_sprite_download", { frames: frames.length, columns, rows });
    } catch (error) {
      console.error("[PIXEL MAKER SPRITE]", error);
      setBatchStatus(error.message === "SPRITE SIZE LIMIT" ? "シートが大きすぎます。画像サイズかフレーム数を減らしてください。" : "スプライトシートを書き出せませんでした。", true);
    } finally {
      setBatchBusy(false);
      batchProgress.hidden = true;
    }
  }

  function dataUrlToBlob(dataUrl) {
    const [header, encoded] = dataUrl.split(",");
    const type = header.match(/data:([^;]+)/)?.[1] || "image/png";
    const binary = window.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type });
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function canvasToBlob() {
    /* 画面のcanvasは見やすさのために拡大してあるので、そのまま保存すると
       出力サイズを指定しても元画像と同じ大きさのPNGになる。
       指定がある時はドット等倍の smallCanvas（編集内容も反映済み）を書き出す。 */
    const target = outputCanvas();
    return new Promise((resolve, reject) => {
      target.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas blob unavailable"));
      }, "image/png");
    });
  }

  function outputCanvas() {
    const saveDetectedGrid = usesStructuredGrid() && detectedGridSize > 0;
    return (outputDots > 0 || saveDetectedGrid) && smallCanvas.width ? smallCanvas : canvas;
  }

  async function saveImage() {
    if (editor.mode === "editing") {
      setEditorStatus("先に「編集を終える」を押してください。");
      return;
    }
    if (renderFrame) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      if (editor.mode === "edited" && renderSettingsKey() !== lastRender.settingsKey) {
        if (!applyEditedSettingsChange()) return;
      } else if (editor.mode === "convert" && !renderCurrentSettings()) return;
    }
    if (!sourceImage || !canvas.width || !canvas.height) {
      setStatus("画像を選ぶと保存できます。", true);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `holometer-pixel-${stamp}.png`;
    saveButton.disabled = true;
    setStatus("PNGを準備しています…");

    try {
      const isTouch = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
      if (isTouch && typeof navigator.share === "function" && typeof navigator.canShare === "function" && typeof File === "function") {
        const blob = dataUrlToBlob(outputCanvas().toDataURL("image/png"));
        const file = new File([blob], fileName, { type: "image/png", lastModified: Date.now() });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: "ドット絵変換ツール" });
            setStatus("共有メニューを開きました。保存先を選んでください。");
            track("pixel_image_share");
            return;
          } catch (error) {
            if (error?.name === "AbortError") {
              setStatus("保存をキャンセルしました。");
              return;
            }
          }
        }
        downloadBlob(blob, fileName);
      } else {
        downloadBlob(await canvasToBlob(), fileName);
      }
      setStatus("PNGの保存を開始しました。");
      track("pixel_image_download");
    } catch (error) {
      console.error("[PIXEL MAKER SAVE]", error);
      setStatus("保存できませんでした。ブラウザの保存設定を確認して、もう一度お試しください。", true);
    } finally {
      saveButton.disabled = false;
    }
  }

  function setDither(value) {
    if (!["off", "soft", "hard"].includes(value)) return;
    dither = value;
    updateControlState();
    scheduleRender("色のなじませ方を変更しました。");
  }

  function setFlatFill(value) {
    if (!["off", "soft", "strong"].includes(value)) return;
    flatFill = value;
    updateControlState();
    scheduleRender("ベタ塗りの色ムラ調整を変更しました。");
    track("pixel_flat_fill_change", { flat_fill: value });
  }

  function setAccentKeep(value) {
    if (!["off", "on"].includes(value)) return;
    accentKeep = value === "on";
    updateControlState();
    scheduleRender("細部の色の残し方を変更しました。");
    track("pixel_accent_keep_change", { accent_keep: value });
  }

  function setGridSnap(value) {
    if (!["off", "auto"].includes(value)) return;
    gridSnap = value;
    detectedGridSize = 0;
    appliedGridSize = 0;
    gridSizeAdjusted = false;
    updateControlState();
    scheduleRender("グリッドの決め方を変更しました。");
    track("pixel_grid_snap_change", { grid_snap: value });
  }

  function setOutline(value) {
    if (!["off", "dark", "black"].includes(value)) return;
    outline = value;
    updateControlState();
    scheduleRender("境界線を変更しました。");
  }

  if (!canvas || !context || !smallContext) {
    setStatus("このブラウザでは画像を変換できません。最新のブラウザでお試しください。", true);
    return;
  }

  editToggleButton?.addEventListener("click", startPixelEdit);
  returnSettingsButton?.addEventListener("click", returnToConversion);
  cancelEditButton?.addEventListener("click", requestClosePixelEditor);
  finishEditButton?.addEventListener("click", finishPixelEdit);
  continueEditButton?.addEventListener("click", () => {
    setEditorDiscardOpen(false);
    editCanvas?.focus();
  });
  discardEditButton?.addEventListener("click", discardPixelEdit);
  paintEditButton?.addEventListener("click", () => setEditorTool("paint"));
  fillEditButton?.addEventListener("click", () => setEditorTool("fill"));
  eraseEditButton?.addEventListener("click", () => setEditorTool("erase"));
  panEditButton?.addEventListener("click", () => setEditorTool("pan"));
  undoEditButton?.addEventListener("click", undoEditorStroke);
  editColorInput?.addEventListener("input", () => {
    editor.color = editColorInput.value.toLowerCase();
    setEditorTool("paint");
  });
  editZoomOutButton?.addEventListener("click", () => stepEditorZoom(-1));
  editZoomInButton?.addEventListener("click", () => stepEditorZoom(1));
  editFitButton?.addEventListener("click", () => {
    editor.fit = true;
    applyEditorZoom();
  });
  editCanvas?.addEventListener("pointerdown", handleEditorPointerDown);
  editCanvas?.addEventListener("pointermove", handleEditorPointerMove);
  editCanvas?.addEventListener("pointerup", handleEditorPointerEnd);
  editCanvas?.addEventListener("pointercancel", handleEditorPointerEnd);
  editCanvas?.addEventListener("keydown", handleEditorKeydown);
  editCanvas?.addEventListener("contextmenu", (event) => {
    if (editor.mode === "editing") event.preventDefault();
  });
  pixelEditorDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (editorDiscard && !editorDiscard.hidden) {
      setEditorDiscardOpen(false);
      editCanvas?.focus();
    } else requestClosePixelEditor();
  });
  window.addEventListener("resize", () => {
    if (editor.mode === "editing" && editor.fit) applyEditorZoom(false);
  });

  emptyButton.addEventListener("click", openImagePicker);
  changeImageButton.addEventListener("click", openImagePicker);
  resetButton.addEventListener("click", resetAll);
  saveButton.addEventListener("click", saveImage);
  paletteCopyButton?.addEventListener("click", copyPaletteCodes);
  input.addEventListener("change", () => {
    clearBatch();
    loadFile(input.files?.[0]);
  });
  zipLoadButton?.addEventListener("click", () => {
    zipInput.value = "";
    zipInput.click();
  });
  zipExportButton?.addEventListener("click", exportBatchZip);
  spriteExportButton?.addEventListener("click", exportSpriteSheet);
  zipInput?.addEventListener("change", () => loadBatchZip(zipInput.files?.[0]));

  document.querySelectorAll("[data-preview-mode]").forEach((button) => {
    button.addEventListener("click", () => setPreviewMode(button.dataset.previewMode));
  });

  document.querySelectorAll("[data-style]").forEach((button) => {
    button.addEventListener("click", () => setStyle(button.dataset.style));
  });
  document.querySelectorAll("[data-dither]").forEach((button) => {
    button.addEventListener("click", () => setDither(button.dataset.dither));
  });
  document.querySelectorAll("[data-flat-fill]").forEach((button) => {
    button.addEventListener("click", () => setFlatFill(button.dataset.flatFill));
  });
  document.querySelectorAll("[data-accent-keep]").forEach((button) => {
    button.addEventListener("click", () => setAccentKeep(button.dataset.accentKeep));
  });
  document.querySelectorAll("[data-grid-snap]").forEach((button) => {
    button.addEventListener("click", () => setGridSnap(button.dataset.gridSnap));
  });
  document.querySelectorAll("[data-outline]").forEach((button) => {
    button.addEventListener("click", () => setOutline(button.dataset.outline));
  });
  document.querySelectorAll("[data-background]").forEach((button) => {
    button.addEventListener("click", () => {
      toneBackground = button.dataset.background;
      updateControlState();
      scheduleRender("背景を変更しました。");
    });
  });

  pixelSize.addEventListener("input", () => {
    if (gridSnap === "auto") gridSizeAdjusted = true;
    scheduleRender();
  });
  [toneThreshold, saturationBoost, contrastBoost, edgeBoost].forEach((control) => {
    control.addEventListener("input", () => scheduleRender());
  });
  colorCount.addEventListener("change", () => scheduleRender("色の数を変更しました。"));
  [inkColor, paperColor].forEach((control) => {
    control.addEventListener("input", () => {
      updateControlState();
      scheduleRender();
    });
  });
  customInputs.forEach((control) => {
    control.addEventListener("input", () => {
      updateControlState();
      if (activeStyle === "custom") scheduleRender();
    });
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    stage.addEventListener(eventName, (event) => {
      event.preventDefault();
      stage.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    stage.addEventListener(eventName, (event) => {
      event.preventDefault();
      stage.classList.remove("is-dragging");
    });
  });
  stage.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file && (/\.zip$/i.test(file.name) || /zip/i.test(file.type))) loadBatchZip(file);
    else {
      clearBatch();
      loadFile(file);
    }
  });
  window.addEventListener("pagehide", () => {
    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  });

  setStyle(DEFAULT_STYLE, false);
  clearBatch();
  syncEditorModeUi();
})();
