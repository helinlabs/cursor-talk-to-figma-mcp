#!/usr/bin/env python3
"""Figma export 를 스토어에 올릴 수 있는 상태로 다듬고, 나중에 재현되는지 확인한다.

세 가지 다 "없으면 조용히 망하는" 것들이라 코드로 고정해 둔다.

  flatten  알파 제거. **App Store 는 알파가 있으면 업로드를 거절한다**(IMAGE_ALPHA_NOT_ALLOWED).
           Figma export 는 기본이 RGBA 라 그대로 올리면 전부 FAILED 가 된다.
  check    크기·모드 검증. 디스플레이 타입과 픽셀 크기가 어긋나면 업로드가 끝난 뒤에야
           IMAGE_INCORRECT_DIMENSIONS 로 떨어진다 — 보내기 전에 거른다.
  diff     두 디렉토리를 픽셀로 대조. "지금 다시 뽑아도 같은 게 나오는가" 를 확인하는 용도다.

사용:
  python3 image-prep.py flatten <dir>
  python3 image-prep.py check   <dir> --size 1284x2778 [--size 1024x500]
  python3 image-prep.py diff    <dirA> <dirB>
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image


def walk(root):
    for dirpath, _, files in os.walk(root):
        for f in sorted(files):
            if f.lower().endswith(".png"):
                yield os.path.join(dirpath, f)


def cmd_flatten(args):
    n = 0
    for p in walk(args.dir):
        im = Image.open(p)
        if im.mode == "RGB":
            continue
        # 검은 배경 위에 합성한다. 스토어 컷은 불투명 프레임이라 결과가 원본과 같고,
        # 투명 테두리가 있는 자산(워치 등)은 애초에 스토어에 직접 올리지 않는다.
        bg = Image.new("RGB", im.size, (0, 0, 0))
        bg.paste(im, mask=im.split()[-1] if im.mode in ("RGBA", "LA") else None)
        bg.save(p, "PNG")
        n += 1
    print(f"알파 제거 {n}장 (이미 RGB 인 것은 건너뜀)")


def cmd_check(args):
    allowed = set()
    for s in args.size:
        w, h = s.lower().split("x")
        allowed.add((int(w), int(h)))
    bad = []
    total = 0
    skipped = 0
    for p in walk(args.dir):
        # 규격이 다른 갈래는 건너뛴다. 스토어마다 규칙이 다른데(Play 는 범위·비율, 워치는
        # 기기별) 그 지식을 여기까지 복제하면 반드시 갈린다 — 그런 파일은 올릴 때
        # 서버가 본다. 이름으로 골라내는 이유는 그게 이미 「무엇인지」를 담고 있어서다.
        if any(tag in os.path.basename(p) for tag in args.skip):
            skipped += 1
            continue
        im = Image.open(p)
        total += 1
        why = []
        if im.mode != "RGB":
            why.append(f"mode={im.mode}")
        if allowed and im.size not in allowed:
            why.append(f"size={im.size[0]}x{im.size[1]}")
        if why:
            bad.append((os.path.relpath(p, args.dir), ", ".join(why)))
    print(f"검사 {total}장 / 위반 {len(bad)}장" + (f" / 건너뜀 {skipped}장" if skipped else ""))
    for f, why in bad:
        print(f"  ⚠️ {f}: {why}")
    return 1 if bad else 0


def cmd_diff(args):
    a_files = {os.path.relpath(p, args.a): p for p in walk(args.a)}
    b_files = {os.path.relpath(p, args.b): p for p in walk(args.b)}
    only_a = sorted(set(a_files) - set(b_files))
    only_b = sorted(set(b_files) - set(a_files))
    same = diff = 0
    worst = []
    for k in sorted(set(a_files) & set(b_files)):
        ia = Image.open(a_files[k]).convert("RGB")
        ib = Image.open(b_files[k]).convert("RGB")
        if ia.size != ib.size:
            worst.append((k, f"크기 {ia.size}≠{ib.size}"))
            diff += 1
            continue
        d = np.abs(np.asarray(ia, np.int16) - np.asarray(ib, np.int16))
        m = float(d.mean())
        if m > args.tol:
            worst.append((k, f"MAE {m:.3f} 최대 {int(d.max())}"))
            diff += 1
        else:
            same += 1
    print(f"동일 {same} / 다름 {diff} / A 에만 {len(only_a)} / B 에만 {len(only_b)}")
    for k, why in worst:
        print(f"  ⚠️ {k}: {why}")
    for k in only_a:
        print(f"  A 에만: {k}")
    for k in only_b:
        print(f"  B 에만: {k}")
    return 1 if (diff or only_a or only_b) else 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("flatten", help="알파 제거 (제자리 수정)")
    f.add_argument("dir")

    c = sub.add_parser("check", help="크기·모드 검증")
    c.add_argument("dir")
    c.add_argument("--size", action="append", default=[],
                   help="허용 크기 (예: 1284x2778). 여러 번 줄 수 있다")
    c.add_argument("--skip", action="append", default=[],
                   help="이 문자열이 파일명에 있으면 검사하지 않는다 (예: _play_). 여러 번 가능")

    d = sub.add_parser("diff", help="두 디렉토리 픽셀 대조")
    d.add_argument("a")
    d.add_argument("b")
    d.add_argument("--tol", type=float, default=0.01, help="이 MAE 이하는 같다고 본다")

    args = ap.parse_args()
    rc = {"flatten": cmd_flatten, "check": cmd_check, "diff": cmd_diff}[args.cmd](args)
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
