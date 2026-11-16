#!/usr/bin/env bash
# Stands in for Claude in `make e2e/fake` (SCHMEIDE_AGENT_CMD): no model calls, no usage.
# `spec` prints a fixed spec; `build` makes a small real change that keeps the template's checks green;
# `interview` prints one turn that adds a plan item and asks nothing further.
set -euo pipefail

case "${1:-}" in
  spec)
    printf '%s\n' "## Features" "- Fake spec for the end-to-end fixture" "" \
      "## Screens" "- The template's sample screen" "" "## Data it stores" "- The template's sample data"
    ;;
  build)
    title="Schmeide e2e fixture $(date +%s)"
    sed -i.bak "s|<title>[^<]*</title>|<title>${title}</title>|" frontend/index.html
    rm frontend/index.html.bak
    git add -A
    git commit -q -m "retitle the page to ${title}"
    echo "fake agent: retitled the page to ${title}"
    ;;
  interview)
    printf '%s\n' '{"add":[{"section":"does","text":"Fake plan item for the end-to-end fixture","phase":"day_one"}],"update":[],"remove":[],"ready":["does"],"question":null}'
    ;;
  *)
    echo "usage: $0 spec|build|interview (prompt in AGENT_PROMPT)" >&2
    exit 2
    ;;
esac
