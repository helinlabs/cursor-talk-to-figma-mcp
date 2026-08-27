#!/bin/zsh
set -u

script_dir="${0:A:h}"
source_file="$script_dir/figma_product_mcp.swift"
config_file="$script_dir/projects.json"
cache_root="${TMPDIR:-/tmp}/figma-product-mcp-${UID}"
binary_file="$cache_root/figma-product-mcp"

mkdir -p "$cache_root"
if [[ ! -x "$binary_file" || "$source_file" -nt "$binary_file" ]]; then
  /usr/bin/swiftc -O "$source_file" -o "$binary_file" || exit 70
fi

exec "$binary_file" --config "$config_file" "$@"
