#!/bin/zsh
set -u

script_dir="${0:A:h}"
source_file="$script_dir/figma_product_mcp.swift"
config_file="$script_dir/projects.json"
cache_root="${TMPDIR:-/tmp}/figma-product-mcp-${UID}"
binary_file="$cache_root/figma-product-mcp"

mkdir -p "$cache_root"
# Compile to a private path and swap it in atomically. A failing MCP call now
# tells every agent to run this action, so several machines can invoke the
# launcher at the same moment; two swiftc runs writing the shared binary in
# place would let a third process exec a half-written file. rename(2) is atomic
# within a filesystem, so a concurrent exec sees either the old binary or the
# new one — never a partial one — and no lock is needed for this part.
if [[ ! -x "$binary_file" || "$source_file" -nt "$binary_file" ]]; then
  staging_file="$binary_file.$$.tmp"
  /usr/bin/swiftc -O "$source_file" -o "$staging_file" || { rm -f "$staging_file"; exit 70; }
  mv -f "$staging_file" "$binary_file" || { rm -f "$staging_file"; exit 70; }
fi

exec "$binary_file" --config "$config_file" "$@"
