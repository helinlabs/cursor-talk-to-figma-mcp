#!/usr/bin/env python3
"""워치 목업의 액정에 앱 화면을 합성한다.

**왜 Figma 밖에서 하나** — 워치는 폰과 달리 `Paste content here` 슬롯이 없다. 시계 사진 한 장에
화면이 통째로 구워져 있어서, 문구를 바꾸려면 픽셀을 갈아 끼우는 수밖에 없다.

**입력**
  --mockup   워치 사진 (Figma 에서 export). 액정에 옛 내용이 구워져 있어도 된다
  --cover    옛 내용을 덮을 폴리곤들 (JSON [[ [x,y], ... ], ...]) — 액정색으로 채운다
  --quad     액정 네 꼭짓점 (JSON [[x,y]×4]). 디자이너가 그려 준 패스를 쓰는 게 가장 정확하다
  --screen   넣을 화면 (Figma 프레임을 8x 로 export). 배경은 순검정이어야 한다

좌표는 전부 **mockup 이미지 픽셀 기준**이다. Figma 벡터에서 옮길 때는
  (정점 + absoluteTransform 이동분 - 목업사각형 원점) × (이미지폭 / 사각형폭)

**기본값은 실측치다** (2026-08, gymwork ASO). 근거는 각 인자 설명에 적었다.
"""

import argparse
import json

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def perspective_coeffs(src_corners, dst_corners):
    """PIL `Image.transform(PERSPECTIVE)` 용 8계수 (출력→입력 방향)."""
    m = []
    for (dx, dy), (sx, sy) in zip(dst_corners, src_corners):
        m.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        m.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    return np.linalg.solve(np.array(m, np.float64), np.array(src_corners, np.float64).reshape(8))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mockup", required=True)
    ap.add_argument("--screen", required=True)
    ap.add_argument("--quad", required=True, help="액정 4점 JSON. 순서는 아무렇게나 — 아래에서 정렬한다")
    ap.add_argument("--cover", help="옛 내용을 덮을 폴리곤 JSON. 없으면 덮지 않는다")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lcd", default="30,30,29",
                    help="액정 배경색. 원본 유리의 어두운 픽셀 중앙값으로 잡는다")
    ap.add_argument("--inset", type=float, default=0.98,
                    help="패스보다 살짝 안쪽으로. 1.0 이면 말풍선이 화면 밖으로 잘린다")
    ap.add_argument("--radius", type=float, default=0.20,
                    help="모서리 라운드 (소스 폭 대비). 마스크를 소스 공간에서 만들어 "
                         "같은 원근으로 뒤틀어야 기울기에 맞게 둥글어진다")
    ap.add_argument("--gain", type=float, default=0.851,
                    help="유리 너머 톤: out = gain*in + lift. 대비 축소 + 블랙 리프트다. "
                         "기준점 3개(말풍선·강조색·흰색)를 원본과 대조해 구했다")
    ap.add_argument("--lift", type=float, default=21.0)
    ap.add_argument("--key-lo", type=float, default=4.0,
                    help="이 휘도 이하는 완전 투명. 소스 배경은 순검정(0)이고 말풍선은 26 이라 "
                         "둘은 구분된다 — 임계값을 올리면 말풍선까지 반투명해져 색이 뭉개진다")
    ap.add_argument("--key-hi", type=float, default=12.0)
    args = ap.parse_args()

    base = Image.open(args.mockup).convert("RGBA")
    lcd = tuple(int(v) for v in args.lcd.split(","))

    # 1) 옛 내용을 액정색으로 덮어 빈 화면을 만든다.
    #    광택을 원본에서 되살리는 방식(저주파 차이 전이)도 해 봤지만, 옛 말풍선이 큰 저주파라
    #    유령처럼 같이 얹혔다. 덮어서 지우는 쪽이 깨끗하다.
    if args.cover:
        d = ImageDraw.Draw(base)
        for poly in json.load(open(args.cover)):
            d.polygon([tuple(p) for p in poly], fill=lcd + (255,))

    # 2) 액정 사각형. 입력 순서와 무관하게 좌상→우상→우하→좌하로 정렬한다.
    q = np.array(json.load(open(args.quad)), np.float64)
    c = q.mean(axis=0)
    q = q[np.argsort((np.arctan2(q[:, 1] - c[1], q[:, 0] - c[0]) + np.pi * 3 / 4) % (2 * np.pi))]
    cx, cy = q[:, 0].mean(), q[:, 1].mean()
    dst = [(cx + (x - cx) * args.inset, cy + (y - cy) * args.inset) for x, y in q]

    src = Image.open(args.screen).convert("RGBA")
    sw, sh = src.size
    coeffs = perspective_coeffs([(0, 0), (sw, 0), (sw, sh), (0, sh)], dst)

    # 3) 소스 손질 — 순검정 배경만 투명으로 빼고, 유리 너머 톤을 입힌다.
    a = np.asarray(src).astype(np.float32).copy()
    lum = a[..., :3].mean(2)
    a[..., 3] *= np.clip((lum - args.key_lo) / max(args.key_hi - args.key_lo, 1e-6), 0, 1)
    a[..., :3] = np.clip(a[..., :3] * args.gain + args.lift, 0, 255)
    toned = Image.fromarray(a.astype(np.uint8), "RGBA")

    # 4) 라운드 마스크를 **소스 공간에서** 만들고 같은 원근으로 뒤튼다.
    #    결과 공간에서 사각형을 둥글리면 기울기와 어긋난다.
    m0 = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(m0).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=int(sw * args.radius), fill=255)
    clip = m0.transform(base.size, Image.PERSPECTIVE, coeffs, Image.BILINEAR).filter(
        ImageFilter.GaussianBlur(2))

    warped = toned.transform(base.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    wa = np.asarray(warped).astype(np.float32).copy()
    wa[..., 3] *= np.asarray(clip, np.float32) / 255.0

    out = base.copy()
    out.alpha_composite(Image.fromarray(wa.astype(np.uint8), "RGBA"))
    out.save(args.out, "PNG")   # RGBA 유지 — RGB 로 저장하면 시계 주변 투명이 검게 찬다
    print(f"합성 완료: {args.out} ({out.size[0]}×{out.size[1]}, 액정 {lcd}, "
          f"inset {args.inset}, tone {args.gain}x+{args.lift})")


if __name__ == "__main__":
    main()
