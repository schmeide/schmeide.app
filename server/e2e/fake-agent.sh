#!/usr/bin/env bash
# Stands in for Claude in `make e2e/fake` (SCHMEIDE_AGENT_CMD): no model calls, no usage.
# `spec` prints a fixed spec; `build` makes a small real change that keeps the template's checks green and adds a stylesheet;
# `interview` prints one turn that adds a plan item and asks nothing further;
# `website mine|someone_else` prints one reading of a website.
# `read` prints one reading of an uploaded picture, with one proposed plan item.
# `summary` prints one line of a build's running summary.
# `design` prints the design lead's choice of look, `review` a design review that finds nothing
# (both only with SCHMEIDE_DESIGN_TEAM=1).
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
    # The template ships no stylesheet, and Schmeide's phone check fails a build without one.
    if [[ ! -f frontend/src/e2e.css ]]; then
      printf '%s\n' 'body {' '  margin: 0;' '  font-family: system-ui, sans-serif;' '}' >frontend/src/e2e.css
      sed -i.bak 's|</head>|  <link rel="stylesheet" href="/src/e2e.css" />\n  </head>|' frontend/index.html
      rm frontend/index.html.bak
    fi
    git add -A
    git commit -q -m "retitle the page to ${title}"
    echo "fake agent: retitled the page to ${title}"
    ;;
  interview)
    printf '%s\n' '{"add":[{"section":"does","text":"Fake plan item for the end-to-end fixture","phase":"day_one"}],"update":[],"remove":[],"ready":["does"],"question":null}'
    ;;
  website)
    if [[ "${2:-}" == mine ]]; then
      printf '%s\n' '{"businessName":"Fake business for the end-to-end fixture","logo":null,"colors":[],"offers":["A fake offer for the end-to-end fixture"],"features":[{"section":"does","text":"Fake feature read from a website"}]}'
    else
      printf '%s\n' '{"features":[{"section":"does","text":"Fake feature read from a website"}]}'
    fi
    ;;
  design)
    printf '%s\n' '{"style":"calm","reason":"The end-to-end fixture gets the calm look.","screens":[]}'
    ;;
  review)
    printf '%s\n' '{"problems":[]}'
    ;;
  read)
    printf '%s\n' '{"outcome":"read","items":[{"section":"keeps","text":"Fake item read from the picture"}]}'
    ;;
  summary)
    echo "Fake summary for the end-to-end fixture."
    ;;
  *)
    echo "usage: $0 spec|build|interview|website|read|summary|design|review (prompt in AGENT_PROMPT)" >&2
    exit 2
    ;;
esac
