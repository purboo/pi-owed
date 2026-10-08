#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
[ -f tla2tools.jar ] || curl -fL -o tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
echo "expected 7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d"; sha256sum tla2tools.jar
