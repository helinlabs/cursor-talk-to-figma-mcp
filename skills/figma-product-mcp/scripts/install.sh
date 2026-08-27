#!/bin/zsh
# Install this skill onto a machine that runs Figma (the fleet mac minis).
#
# The launcher that actually runs lives at ~/.codex/skills/figma-product-mcp —
# NOT in this repo — so a fix here reaches nothing until it is copied over.
# That gap is how the device copy drifted from the repo (different
# defaultProjectIDs) and why a launcher bug survived a repo fix.
#
#   ./scripts/install.sh              # install code, leave projects.json alone
#   ./scripts/install.sh --with-config  # also overwrite projects.json
set -u

source_dir="${0:A:h:h}"
target_dir="$HOME/.codex/skills/figma-product-mcp"
with_config=0
[[ "${1-}" == "--with-config" ]] && with_config=1

mkdir -p "$target_dir/scripts" "$target_dir/references"
cp "$source_dir/SKILL.md" "$target_dir/SKILL.md"
cp "$source_dir/references/"*.md "$target_dir/references/"
cp "$source_dir/scripts/figma_product_mcp.swift" "$target_dir/scripts/"
cp "$source_dir/scripts/run.sh" "$target_dir/scripts/"
cp "$source_dir/scripts/install.sh" "$target_dir/scripts/"
chmod +x "$target_dir/scripts/run.sh" "$target_dir/scripts/install.sh"

# projects.json is operational state (which files this machine opens), so the
# installed copy wins unless asked otherwise — but never silently: a drift is
# printed so somebody decides which side is right.
if [[ ! -f "$target_dir/scripts/projects.json" || $with_config -eq 1 ]]; then
  cp "$source_dir/scripts/projects.json" "$target_dir/scripts/projects.json"
  echo "installed projects.json"
elif ! diff -q "$source_dir/scripts/projects.json" "$target_dir/scripts/projects.json" >/dev/null; then
  echo "⚠️  projects.json differs between repo and $target_dir — kept the installed one:"
  diff "$source_dir/scripts/projects.json" "$target_dir/scripts/projects.json" || true
  echo "   rerun with --with-config to take the repo's version."
fi

# Drop the cached binary so the next run rebuilds from the new source.
rm -f "${TMPDIR:-/tmp}/figma-product-mcp-${UID}/figma-product-mcp"
echo "installed to $target_dir"
"$target_dir/scripts/run.sh" --dry-run >/dev/null || { echo "dry-run failed"; exit 1; }
echo "dry-run OK"
