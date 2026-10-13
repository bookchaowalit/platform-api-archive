# platform-api-archive (archive)

Archived copy of solo-empire `infra/api/` (REST server `server.ts`, auth, rate limit, LINE/Stripe webhooks,
OpenTelemetry, and the `platform/` building blocks: identity verify, Thai tax/invoice preview, email, presigned files)
with its history (subtree split, 2026-10-11). solo-empire's local runtime (`infra/api`, `infra/dashboard`) was retired
the same day; domain data lives in the cell APIs and the web surface is `bookchaowalit/life-dashboard-web`.

- Not runnable standalone: it was built for the solo-empire `infra/` tree (imports `../database`, `../platform/*.yaml`,
  `../mcp-server` stores). `tests/` are the copies of `infra/tests/api/*` kept only for reference.
- `media_router.ts` moved to solo-empire `infra/media-worker/core/media_router.ts` (the media worker still uses it).
- `external_app_registry.ts` moved to solo-empire `integrations/external_app_registry.ts` (Tools Hub source of truth).
- Reuse: lift a module (e.g. `platform/thai_tax.ts`) into the owning cell repo when that capability is needed.
