#!/usr/bin/env bash
#
# Send a fix made on the device back to the repo as a pull request.
#
# `~/.codex/skills/figma-product-mcp` on a device is a build output: install.sh
# copies it out of the repo. But it is also the copy that runs, so when a
# launcher run fails at 2am the fix gets made *there* — that is where the
# failing code is, and it is the only copy whose edit takes effect immediately.
# Measured 2026-08-31: a broker fallback session diagnosed an upstream Figma
# accessibility regression and fixed the launcher entirely in the device copy.
#
# Left alone, the next `figma-skill-install` runs `git pull` and install.sh over
# the top, and the fix is gone. Nothing errors. The person who made it has long
# since finished their session, so nobody is watching when it disappears.
#
# So make the way back one command. Output -> repo -> branch -> PR. Review and
# merge stay human; after the merge, `figma-skill-install` puts the device and
# the repo back in step.
#
# Deliberately excluded:
#   projects.json   device configuration, not source (install.sh preserves it)
#   *.bak-*         backups a session left behind
#
set -euo pipefail

DEVICE_SKILL="${DEVICE_SKILL:-$HOME/.codex/skills/figma-product-mcp}"
REPO="${REPO:-$HOME/Projects/cursor-talk-to-figma-mcp}"
SKILL_IN_REPO="$REPO/skills/figma-product-mcp"

[ -d "$DEVICE_SKILL" ] || { echo "ABORT: 기기 스킬이 없다: $DEVICE_SKILL"; exit 1; }
[ -d "$SKILL_IN_REPO" ] || { echo "ABORT: 레포 사본이 없다: $SKILL_IN_REPO"; exit 1; }

cd "$REPO"

# A device-fix/* branch is this script's own leftover: an earlier run that got
# as far as committing and then failed (a push that could not authenticate is
# how it happened the first time). Everything on it is regenerable from the
# device in the next few lines, so clear it rather than making a person do it.
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" == device-fix/* ]]; then
  echo "이전 실행이 남긴 $branch 를 정리하고 다시 만든다"
  git reset --hard --quiet
  git checkout --quiet main
  git branch -D --quiet "$branch"
  branch=main
fi

# Refuse to touch a checkout someone else is mid-thought in. Committing on top
# of unrelated work would put it in a PR nobody meant to open.
if [ "$branch" != main ]; then
  echo "ABORT: 레포가 main 이 아니라 $branch 다. 사람이 정리해야 한다"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "ABORT: 레포에 커밋 안 된 변경이 있다. 사람이 정리해야 한다"
  git status --short | head -20
  exit 1
fi

git fetch --quiet origin main
git merge --quiet --ff-only origin/main

rsync -a --exclude '*.bak-*' --exclude 'projects.json' "$DEVICE_SKILL/" "$SKILL_IN_REPO/"

if git diff --quiet; then
  echo "NO_DRIFT: 기기와 레포가 같다. 올릴 것 없음"
  exit 0
fi

echo "=== 올릴 변경 ==="
git diff --stat
echo

pr_branch="device-fix/$(date +%Y%m%d-%H%M%S)"
git checkout --quiet -b "$pr_branch"
git add -A skills/figma-product-mcp

# The device cannot know *why* the change was made — that context lives in the
# session that made it. Say plainly where it came from and leave the reasoning
# to review, rather than inventing a rationale here.
git commit --quiet -m "기기에서 고친 런처 수정을 레포로 되돌린다" -m \
"$(hostname -s) 의 ~/.codex/skills/figma-product-mcp 에서 직접 고친 변경이다.
그대로 두면 다음 figma-skill-install 이 덮어쓴다.

무엇을 왜 고쳤는지는 그 수정을 한 세션에 있다. 리뷰에서 확인할 것."

# The remote is HTTPS and the device has no git credential helper, so a plain
# push fails with "Password authentication is not supported". `gh` is logged in
# though, so borrow its credentials for this one command. Passing the token in
# the URL would work too, but that puts it in the process list.
git -c credential.helper='!gh auth git-credential' push --quiet -u origin "$pr_branch"

gh pr create --base main --head "$pr_branch" \
  --title "기기에서 고친 런처 수정을 레포로 되돌린다" \
  --body "$(printf '%s\n' \
    "\`$(hostname -s)\` 의 기기 산출물(\`~/.codex/skills/figma-product-mcp\`)에서 직접 고친 변경을 레포로 옮긴 PR 이다. \`skill-pr.sh\` 가 자동으로 열었다." \
    "" \
    "**왜 자동인가** — 기기 산출물은 다음 \`figma-skill-install\` 의 \`git pull\` + \`install.sh\` 가 조용히 덮어쓴다. 오류도 안 나고, 고친 사람은 이미 세션을 끝낸 뒤다." \
    "" \
    "**무엇을 왜 고쳤는지는 이 PR 이 모른다.** 그 맥락은 수정을 한 세션에 있다. 리뷰에서 확인할 것." \
    "" \
    "머지한 뒤 \`figma-skill-install\` 을 돌리면 기기와 레포가 다시 같아진다.")"

echo
echo "머지 후 figma-skill-install 을 돌려 기기와 레포를 맞출 것"

# Leave the checkout on main.
#
# The branch is pushed and the PR is open, so nothing here needs the working
# tree any more — but every other action that touches this repo starts with a
# plain `git pull`, and that fails on a branch whose upstream was deleted when
# the PR merged. Measured: `figma-skill-install` broke exactly this way one
# minute after the first successful PR.
git checkout --quiet main
