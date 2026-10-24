# services

Deyao's own services: things he runs for himself that are not part of any Jarvis. Jarvis 4's job is narrow (secrets
and the lifecycle of Fly containers and runners); these only share its cluster as a tenant, in the namespace
`services`, applied by Flux from this repo as a service account that can change nothing outside that namespace
(DE0CH/jarvis4 `k8s/cluster/tenants/services.yaml` makes the namespace, its quota and that account).

## Transcript search (`search/`, `k8s/search/`)

Hybrid keyword + semantic search over every Claude session transcript of every Jarvis on the Storage Box
(`claude-records/`: archives, `.live/` copies of running sessions, Jarvis 1's `.paused/` snapshots) and the task
records. One SQLite index on a volume, two replicas, one writer (lease in the database); the index is copied to
`claude-records/.services/search.db.gz` daily and a new volume is seeded from it.

Reached only at **https://search.deyaochen.com**, behind the Cloudflare Access app "Transcript search" through this
repo's own tunnel `services` (`k8s/edge`):
- Deyao: the page at `/` in a browser (his email).
- Sessions: `scripts/transcript-search.py` in DE0CH/claude-env, with the Access service token `transcript-search`
  (`SEARCH_ACCESS_ID` / `SEARCH_ACCESS_SECRET` in the `default` store).

API (all GET unless noted; JSON):
- `/search?q=…` — `mode` hybrid|keyword|semantic, `kind` msg,tool,doc, `state` live,paused,archive, `after`/`before`
  YYYY-MM-DD, `session` (title or uuid), `limit` ≤50, `rerank` (default on), `group=1` (best sessions), `full=1`.
- `/context?id=N&before=3&after=3` — the chunks around hit N (≤30 each side).
- `/status` — index size, the last crawl and its error, replicas, memory.
- `POST /reindex` (`?full=1` rebuilds; embeddings are cached by text hash) — a crawl now instead of within 5 min.

## Setup

- `infra/cloudflare.py OUT` — tunnel, Access app, service token, DNS (idempotent; `CF_JARVIS2_INFRA_TOKEN`,
  `CLOUDFLARE_API`).
- `infra/secrets.py search STORAGEBOX_HOST STORAGEBOX_USER STORAGEBOX_PASSWORD OPENROUTER_API` and
  `infra/secrets.py tunnel token=env:TUNNEL_TOKEN` — the Secrets, SOPS-encrypted to the cluster's age key
  (`keys/cluster-age.pub`).
- `.github/workflows/search.yml` builds and pins the image; the GHCR package `services-search` is public.
