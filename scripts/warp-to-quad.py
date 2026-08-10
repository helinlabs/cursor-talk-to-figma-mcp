#!/usr/bin/env python3
"""직사각형 PNG 를 임의의 사각형(4포인트)에 맞게 원근 워프한다.

**왜 Figma 밖에서 하나** — Figma 는 skew 를 지원하지 않는다. 기기 각도에 맞춘 앱 화면은
전부 목업 플러그인이 "레이어를 이미지로 뽑아 4포인트 벡터에 맞게 뒤틀어" 만든 결과물이다.
이미지 fill 의 `imageTransform` 은 아핀이라 원근을 담지 못하고, 애초에 기존 자산에는
그 값이 들어 있지도 않다(실측). 그래서 워프만 밖에서 하고 결과를 되돌려 넣는다.

사용:
    python3 warp-to-quad.py --src screen.png --quad '[[x,y],[x,y],[x,y],[x,y]]' \\
        --width 1537 --height 2315 --scale 3 --out warped.png

`--quad` 는 **노드 로컬 좌표**(0..width, 0..height)의 네 꼭짓점을 좌상단부터 시계방향으로.
`get_node_geometry` 가 돌려주는 `vertices` 를 그대로 쓰면 된다(순서는 정렬해 준다).
`--width/--height` 는 타깃 노드의 크기 — 출력 캔버스가 그 크기 × scale 이 된다.

출력은 stdout 에 base64 로도 찍는다(`--base64`) — `set_image_fill_from_bytes` 에 바로 넣게.

**기본값 근거(실측)** — 디자이너의 기존 목업 플러그인이 구워 놓은 DE_02 를 정답지로 두고,
양쪽 내용이 동일한 헤더 구간만 떼어 재표본 품질을 비교했다(정렬 오프셋은 전 변형 dx=0 dy=0):

    소스 3x → 1538×2317 bilinear   MAE 0.840  선명도 18.29
    소스 3x → 1538×2317 bicubic    MAE 0.761  선명도 19.55
    소스 3x → 2720×4096 bicubic    MAE 0.498  선명도 21.18   ← 현재 기본값
    소스 8x → 2720×4096 bicubic    MAE 0.439  선명도 22.95
    소스 8x → 2720×4096 bilinear   MAE 0.402  선명도 22.37   (정답지 선명도 21.77)

읽을 점은 **필터보다 출력 해상도가 지배적**이라는 것 — `MAX_SIDE` 까지 키워 뽑고 축소는
Figma 에 맡기면 필터를 뭘 쓰든 차이가 계측기 영역으로 내려간다. 그래서 `--supersample`
기본값은 1(끄기)이고 `--scale` 은 상한에 걸릴 만큼 크게 잡아 둔다. 소스를 8x 로 뽑으면
워프가 축소만 하게 되어 조금 더 좋지만, 육안 차이는 없고 6500px 소스 취급 비용만 든다.
"""

import argparse
import base64
import json
import sys

import numpy as np
from PIL import Image

# Figma `createImage` 상한. 넘으면 "Image is too large" 로 거부된다.
MAX_SIDE = 4096


def order_quad(points):
    """네 점을 좌상→우상→우하→좌하 순으로 정렬한다.

    벡터의 정점 순서는 파일마다 다르다(패스를 어느 방향으로 그렸느냐에 달렸다).
    중심 기준 각도로 정렬하면 그리기 방향과 무관하게 같은 순서가 나온다.
    """
    pts = np.array(points, dtype=np.float64)
    center = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - center[1], pts[:, 0] - center[0])
    # 화면 좌표계(y 아래로 증가)에서 좌상단은 각도 -3/4π 근처다.
    order = np.argsort((angles + np.pi * 3 / 4) % (2 * np.pi))
    return pts[order]


def perspective_coeffs(src_corners, dst_corners):
    """PIL `Image.transform(PERSPECTIVE)` 용 8계수.

    PIL 은 **출력 → 입력** 방향의 매핑을 원한다(역방향). 그래서 dst 를 입력으로,
    src 를 출력으로 두고 푼다 — 이걸 뒤집으면 결과가 조용히 어긋난다.
    """
    matrix = []
    for (dx, dy), (sx, sy) in zip(dst_corners, src_corners):
        matrix.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        matrix.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    A = np.array(matrix, dtype=np.float64)
    B = np.array(src_corners, dtype=np.float64).reshape(8)
    return np.linalg.solve(A, B)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--quad", required=True, help="JSON [[x,y]×4] in node-local coords")
    ap.add_argument("--width", type=float, required=True, help="target node width")
    ap.add_argument("--height", type=float, required=True, help="target node height")
    ap.add_argument("--scale", type=float, default=3.0)
    ap.add_argument(
        "--filter",
        choices=("nearest", "bilinear", "bicubic"),
        default="bicubic",
        help="워프 시 재표본 필터. PIL transform 은 lanczos 를 지원하지 않는다",
    )
    ap.add_argument(
        "--supersample",
        type=float,
        default=1.0,
        help="이 배수로 크게 워프한 뒤 LANCZOS 로 목표 크기까지 줄인다 (안티에일리어싱)",
    )
    ap.add_argument("--out", required=True)
    ap.add_argument("--base64", action="store_true")
    args = ap.parse_args()

    resample = {
        "nearest": Image.NEAREST,
        "bilinear": Image.BILINEAR,
        "bicubic": Image.BICUBIC,
    }[args.filter]

    quad = order_quad(json.loads(args.quad))

    scale = args.scale
    out_w, out_h = args.width * scale, args.height * scale
    longest = max(out_w, out_h)
    if longest > MAX_SIDE:
        shrink = MAX_SIDE / longest
        scale *= shrink
        out_w, out_h = args.width * scale, args.height * scale
        print(
            f"⚠️  {MAX_SIDE}px 상한 때문에 배율을 {args.scale} → {scale:.2f} 로 낮춤",
            file=sys.stderr,
        )
    out_w, out_h = int(round(out_w)), int(round(out_h))

    src = Image.open(args.src).convert("RGBA")
    sw, sh = src.size

    # 소스의 네 모서리 → 목표 사각형(스케일 적용)
    # 슈퍼샘플: 크게 뒤튼 뒤 LANCZOS 로 줄이면 워프가 만드는 계단이 눌린다.
    ss = max(1.0, args.supersample)
    work_scale = scale * ss

    src_corners = [(0, 0), (sw, 0), (sw, sh), (0, sh)]
    dst_corners = [(x * work_scale, y * work_scale) for x, y in quad]

    coeffs = perspective_coeffs(src_corners, dst_corners)
    warped = src.transform(
        (int(round(out_w * ss)), int(round(out_h * ss))),
        Image.PERSPECTIVE,
        coeffs,
        resample,
    )
    if ss > 1.0:
        warped = warped.resize((out_w, out_h), Image.LANCZOS)

    warped.save(args.out, "PNG")
    data = open(args.out, "rb").read()
    print(
        f"워프 완료: {sw}×{sh} → {out_w}×{out_h} ({len(data):,} bytes, "
        f"scale {scale:.2f}, filter {args.filter}, supersample ×{ss:g})",
        file=sys.stderr,
    )
    if args.base64:
        sys.stdout.write(base64.b64encode(data).decode())


if __name__ == "__main__":
    main()
