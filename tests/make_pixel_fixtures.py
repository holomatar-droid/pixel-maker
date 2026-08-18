"""格子検出の精度測定用に、真値が確定した擬似AI画像を生成する。

小さなドット絵を既知の倍率で拡大し、AI出力に特有の劣化（にじみ・ノイズ・
わずかな拡大ずれ）を加える。元のドット数が分かっているので、検出結果を
そのまま正解と突き合わせられる。
"""
from PIL import Image, ImageFilter
import random, os, json

OUT = os.path.join(os.path.dirname(__file__), 'pixel_fixtures')

def sprite(dots, seed, alpha=False):
    """ドット絵らしい絵柄（面・輪郭・細部）を持つ小さな画像を作る。"""
    rnd = random.Random(seed)
    im = Image.new('RGBA', (dots, dots), (0, 0, 0, 0) if alpha else (250, 248, 244, 255))
    px = im.load()
    palette = [(rnd.randrange(30, 230), rnd.randrange(30, 230), rnd.randrange(30, 230), 255)
               for _ in range(6)]
    # 大きな面
    for _ in range(5):
        cx, cy = rnd.randrange(dots), rnd.randrange(dots)
        r = rnd.randrange(max(2, dots // 8), max(3, dots // 3))
        c = rnd.choice(palette)
        for y in range(max(0, cy - r), min(dots, cy + r)):
            for x in range(max(0, cx - r), min(dots, cx + r)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    px[x, y] = c
    # 1ドット幅の輪郭・細部（検出精度が落ちると最初に壊れる部分）
    dark = (20, 18, 26, 255)
    for _ in range(dots // 2):
        x, y = rnd.randrange(dots), rnd.randrange(dots)
        for k in range(rnd.randrange(2, max(3, dots // 4))):
            if x + k < dots:
                px[x + k, y] = dark
    for _ in range(dots // 3):
        px[rnd.randrange(dots), rnd.randrange(dots)] = (255, 255, 255, 255)
    return im

def degrade(im, scale, blur, noise, seed):
    """拡大してAI出力っぽく劣化させる。"""
    rnd = random.Random(seed + 999)
    w = int(round(im.width * scale))
    big = im.resize((w, w), Image.NEAREST)
    if blur:
        big = big.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        px = big.load()
        for y in range(big.height):
            for x in range(big.width):
                r, g, b, a = px[x, y]
                n = lambda v: max(0, min(255, v + rnd.randint(-noise, noise)))
                px[x, y] = (n(r), n(g), n(b), a)
    return big

def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(('.png', '.json')):
            os.remove(os.path.join(OUT, f))
    cases = []
    seed = 0
    # ドット数 × 劣化の強さ を組み合わせる
    for dots in (16, 32, 48, 64, 96, 128):
        for label, blur, noise in (('clean', 0, 0), ('soft', 1.2, 6), ('rough', 2.2, 14)):
            seed += 1
            scale = 1024 / dots           # 1024px前後に揃える（AI出力の典型）
            im = degrade(sprite(dots, seed), scale, blur, noise, seed)
            name = f'{dots:03d}dots_{label}.png'
            im.convert('RGB').save(os.path.join(OUT, name))
            cases.append({'file': name, 'dots': dots, 'width': im.width,
                          'pitch': im.width / dots, 'variant': label, 'alpha': False})
    # 背景透過あり
    for dots in (32, 64):
        seed += 1
        im = degrade(sprite(dots, seed, alpha=True), 1024 / dots, 1.2, 6, seed)
        name = f'{dots:03d}dots_alpha.png'
        im.save(os.path.join(OUT, name))
        cases.append({'file': name, 'dots': dots, 'width': im.width,
                      'pitch': im.width / dots, 'variant': 'alpha', 'alpha': True})
    # 縦横比が1でない画像（長辺基準で判定されるか）
    for dots in (48, 96):
        seed += 1
        base = sprite(dots, seed)
        scale = 1024 / dots
        im = degrade(base, scale, 1.2, 6, seed).crop((0, 0, int(dots * scale), int(dots * scale * 0.7)))
        name = f'{dots:03d}dots_wide.png'
        im.convert('RGB').save(os.path.join(OUT, name))
        cases.append({'file': name, 'dots': dots, 'width': im.width,
                      'pitch': im.width / dots, 'variant': 'wide', 'alpha': False})
    with open(os.path.join(OUT, 'expected.json'), 'w') as fh:
        json.dump(cases, fh, indent=1, ensure_ascii=False)
    print(f'{len(cases)}件 生成 → {OUT}')
    for c in cases[:4]:
        print(f"  {c['file']:<22} {c['width']}px / 真値 {c['dots']}ドット (1ドット={c['pitch']:.2f}px)")

main()
