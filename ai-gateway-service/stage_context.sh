#!/usr/bin/env bash
# Assemble the minimal Docker/Railway build context for the hosted AI gateway.
#
# Usage: bash infra/api/ai-gateway-service/stage_context.sh <empty-output-dir>
#
# The context mirrors the infra/ layout (api/, database/migrations/) but holds
# only the gateway modules, the service, and the shared telemetry migration,
# with railway.json at its root. No env files or secrets are copied.
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SERVICE_DIR/../.." && pwd)"
OUT="${1:-}"

if [[ -z "$OUT" ]]; then
  echo "usage: $0 <empty-output-dir>" >&2
  exit 2
fi
if [[ -e "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "output directory must be empty or absent: $OUT" >&2
  exit 2
fi

mkdir -p "$OUT/api/ai-gateway-service" "$OUT/database/migrations" "$OUT/platform"
for file in Dockerfile entrypoint.sh package.json package-lock.json main.ts service.ts store.ts; do
  cp "$SERVICE_DIR/$file" "$OUT/api/ai-gateway-service/$file"
done
for module in ai_gateway ai_budget ai_rate_limit auth media_router; do
  cp "$INFRA_DIR/api/$module.ts" "$OUT/api/$module.ts"
done
cp "$INFRA_DIR/database/migrations/025_ai_run_telemetry.sql" "$OUT/database/migrations/"
cp "$INFRA_DIR/platform/media-transcription-routing.json" "$OUT/platform/"
cp "$SERVICE_DIR/railway.json" "$OUT/railway.json"
# Railway `up --path-as-root` falls back to Railpack unless a Dockerfile sits at the
# context root, so place the (context-root-relative) Dockerfile there as well.
cp "$SERVICE_DIR/Dockerfile" "$OUT/Dockerfile"

echo "$OUT"
