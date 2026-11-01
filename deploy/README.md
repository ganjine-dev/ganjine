# deploy/

- `docker-compose.yml` — local development: Postgres only, until the framework has something to run. Listens on host port 5434; override with `GANJINE_PG_PORT`.
- `k8s/` — arrives in Phase 5 (CNPG Postgres, the Ganjine service, ingress).
