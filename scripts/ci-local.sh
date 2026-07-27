#!/usr/bin/env bash
# scripts/ci-local.sh
#
# Local CI gate. Runs the same checks GH Actions does (and a stricter superset
# of E2E) inside Docker. See docker-compose.ci.yml.
#
# Modes:
#   bash scripts/ci-local.sh              # full local gate: gitleaks + unit + ALL E2E (4-way sharded)
#   bash scripts/ci-local.sh --diff       # full local gate: gitleaks + unit + selected E2E (4-way sharded)
#   bash scripts/ci-local.sh --no-pull    # skip docker compose pull (offline / debug)
#   bash scripts/ci-local.sh --clean      # nuke named volumes for cold debug
#   bash scripts/ci-local.sh --no-shard   # debug: run E2E sequentially against postgres-1 only
#
# Adaptive E2E sharding: up to 12 pgvector services on host ports 5434-5445.
# E2E files split into weighted shards and run in parallel. Within a shard,
# files remain sequential (the TRUNCATE CASCADE no-race property is documented
# in run-e2e.sh). Heavy and light unit profiles share the same worker queue.
#
# Stronger than PR CI: PR CI runs only Tier 1's 2 files; this runs all 36.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.ci.yml"

DIFF=0
NO_PULL=0
CLEAN=0
NO_SHARD=0
SHARD_COUNT="${GBRAIN_CI_SHARDS:-}"
HEAVY_UNIT_SHARD_COUNT="${GBRAIN_CI_HEAVY_UNIT_SHARDS:-}"
LIGHT_UNIT_SHARD_COUNT="${GBRAIN_CI_LIGHT_UNIT_SHARDS:-}"
INITIAL_HEAVY_UNIT_SHARDS="${GBRAIN_CI_INITIAL_HEAVY_UNIT_SHARDS:-}"
UNIT_MAX_CONCURRENCY="${GBRAIN_CI_UNIT_CONCURRENCY:-}"
HEAVY_UNIT_MAX_CONCURRENCY="${GBRAIN_CI_HEAVY_UNIT_CONCURRENCY:-$UNIT_MAX_CONCURRENCY}"
LIGHT_UNIT_MAX_CONCURRENCY="${GBRAIN_CI_LIGHT_UNIT_CONCURRENCY:-$UNIT_MAX_CONCURRENCY}"
HEAVY_UNIT_BATCH_SIZE="${GBRAIN_CI_HEAVY_UNIT_BATCH_SIZE:-}"
LIGHT_UNIT_BATCH_SIZE="${GBRAIN_CI_LIGHT_UNIT_BATCH_SIZE:-}"

for arg in "$@"; do
  case "$arg" in
    --diff) DIFF=1 ;;
    --no-pull) NO_PULL=1 ;;
    --clean) CLEAN=1 ;;
    --no-shard) NO_SHARD=1 ;;
    *)
      echo "Usage: $0 [--diff] [--no-pull] [--clean] [--no-shard]" >&2
      exit 1
      ;;
  esac
done

HOST_MEMORY_KB=0
HOST_SWAP_KB=0
if [ -r /proc/meminfo ]; then
  HOST_MEMORY_KB=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  HOST_SWAP_KB=$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)
fi

# Hosts with at least 14 GiB use shorter shards and a wider queue to avoid
# long-tail skew. The 14–24 GiB tier starts two heavy workers beside 12 E2E
# workers; larger or swap-backed hosts start four. Smaller hosts retain the
# conservative shape.
if [ "${HOST_MEMORY_KB:-0}" -ge 25165824 ] || [ "${HOST_SWAP_KB:-0}" -ge 8388608 ]; then
  SHARD_COUNT="${SHARD_COUNT:-12}"
  HEAVY_UNIT_SHARD_COUNT="${HEAVY_UNIT_SHARD_COUNT:-128}"
  LIGHT_UNIT_SHARD_COUNT="${LIGHT_UNIT_SHARD_COUNT:-64}"
  INITIAL_HEAVY_UNIT_SHARDS="${INITIAL_HEAVY_UNIT_SHARDS:-4}"
elif [ "${HOST_MEMORY_KB:-0}" -ge 14680064 ]; then
  SHARD_COUNT="${SHARD_COUNT:-12}"
  HEAVY_UNIT_SHARD_COUNT="${HEAVY_UNIT_SHARD_COUNT:-128}"
  LIGHT_UNIT_SHARD_COUNT="${LIGHT_UNIT_SHARD_COUNT:-64}"
  INITIAL_HEAVY_UNIT_SHARDS="${INITIAL_HEAVY_UNIT_SHARDS:-2}"
else
  SHARD_COUNT="${SHARD_COUNT:-8}"
  HEAVY_UNIT_SHARD_COUNT="${HEAVY_UNIT_SHARD_COUNT:-12}"
  LIGHT_UNIT_SHARD_COUNT="${LIGHT_UNIT_SHARD_COUNT:-4}"
  INITIAL_HEAVY_UNIT_SHARDS="${INITIAL_HEAVY_UNIT_SHARDS:-4}"
fi

if ! [[ "$SHARD_COUNT" =~ ^([1-9]|1[0-2])$ ]]; then
  echo "[ci-local] ERROR: GBRAIN_CI_SHARDS must be an integer from 1 through 12." >&2
  exit 1
fi
for unit_count in "$HEAVY_UNIT_SHARD_COUNT" "$LIGHT_UNIT_SHARD_COUNT"; do
  if ! [[ "$unit_count" =~ ^[0-9]+$ ]] || [ "$unit_count" -lt 1 ] || [ "$unit_count" -gt 512 ]; then
    echo "[ci-local] ERROR: unit shard counts must be integers from 1 through 512." >&2
    exit 1
  fi
done
if ! [[ "$INITIAL_HEAVY_UNIT_SHARDS" =~ ^[0-9]+$ ]] || \
   [ "$INITIAL_HEAVY_UNIT_SHARDS" -gt "$HEAVY_UNIT_SHARD_COUNT" ]; then
  echo "[ci-local] ERROR: initial heavy unit shards must be 0..heavy shard count." >&2
  exit 1
fi
if [ "$NO_SHARD" = "0" ] && [ -r /proc/meminfo ]; then
  if [ "${HOST_MEMORY_KB:-0}" -lt 25165824 ]; then
    HEAVY_UNIT_MAX_CONCURRENCY="${HEAVY_UNIT_MAX_CONCURRENCY:-1}"
    LIGHT_UNIT_MAX_CONCURRENCY="${LIGHT_UNIT_MAX_CONCURRENCY:-4}"
    HEAVY_UNIT_BATCH_SIZE="${HEAVY_UNIT_BATCH_SIZE:-1}"
    LIGHT_UNIT_BATCH_SIZE="${LIGHT_UNIT_BATCH_SIZE:-12}"
    echo "[ci-local] Host memory is below 24 GiB; bounding each shard to avoid OOM (override with GBRAIN_CI_SHARDS/GBRAIN_CI_UNIT_*)."
  fi
fi
if [ "$NO_SHARD" = "1" ]; then
  SHARD_COUNT=1
  HEAVY_UNIT_SHARD_COUNT=1
  LIGHT_UNIT_SHARD_COUNT=1
  INITIAL_HEAVY_UNIT_SHARDS=1
fi
INITIAL_WORKER_COUNT=$((INITIAL_HEAVY_UNIT_SHARDS + SHARD_COUNT))
for concurrency in "$HEAVY_UNIT_MAX_CONCURRENCY" "$LIGHT_UNIT_MAX_CONCURRENCY"; do
  if [ -n "$concurrency" ] && ! [[ "$concurrency" =~ ^[1-9][0-9]*$ ]]; then
    echo "[ci-local] ERROR: unit concurrency values must be positive integers." >&2
    exit 1
  fi
done
for batch_size in "$HEAVY_UNIT_BATCH_SIZE" "$LIGHT_UNIT_BATCH_SIZE"; do
  if [ -n "$batch_size" ] && ! [[ "$batch_size" =~ ^[1-9][0-9]*$ ]]; then
    echo "[ci-local] ERROR: unit batch sizes must be positive integers." >&2
    exit 1
  fi
done
HEAVY_UNIT_ARGS="--profile=heavy"
LIGHT_UNIT_ARGS="--profile=light"
if [ -n "$HEAVY_UNIT_MAX_CONCURRENCY" ]; then
  HEAVY_UNIT_ARGS="--max-concurrency=$HEAVY_UNIT_MAX_CONCURRENCY $HEAVY_UNIT_ARGS"
  echo "[ci-local] Heavy unit concurrency capped at $HEAVY_UNIT_MAX_CONCURRENCY per shard."
fi
if [ -n "$LIGHT_UNIT_MAX_CONCURRENCY" ]; then
  LIGHT_UNIT_ARGS="--max-concurrency=$LIGHT_UNIT_MAX_CONCURRENCY $LIGHT_UNIT_ARGS"
  echo "[ci-local] Light unit concurrency capped at $LIGHT_UNIT_MAX_CONCURRENCY per shard."
fi
if [ -n "$HEAVY_UNIT_BATCH_SIZE" ]; then
  HEAVY_UNIT_ARGS="$HEAVY_UNIT_ARGS --batch-size=$HEAVY_UNIT_BATCH_SIZE"
  echo "[ci-local] Heavy unit batches capped at $HEAVY_UNIT_BATCH_SIZE files."
fi
if [ -n "$LIGHT_UNIT_BATCH_SIZE" ]; then
  LIGHT_UNIT_ARGS="$LIGHT_UNIT_ARGS --batch-size=$LIGHT_UNIT_BATCH_SIZE"
  echo "[ci-local] Light unit batches capped at $LIGHT_UNIT_BATCH_SIZE files."
fi

cleanup() {
  echo ""
  echo "[ci-local] Tearing down postgres..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tail -5 || true
}
trap cleanup EXIT

if [ "$CLEAN" = "1" ]; then
  echo "[ci-local] --clean: removing named volumes..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>&1 | tail -5 || true
fi

# Tier 2: --diff fast-path. If the diff is doc-only (or empty), skip the
# whole heavy gate (postgres + bun install + unit + E2E) and just verify
# gitleaks on host. Doc-only diffs go from ~25 min to ~5 seconds.
if [ "$DIFF" = "1" ]; then
  CLASSIFICATION=$(bun run scripts/select-e2e.ts --classify-only 2>/dev/null || echo "ERR")
  case "$CLASSIFICATION" in
    DOC_ONLY)
      echo "[ci-local] --diff: diff is doc-only — skipping postgres + unit + E2E (Tier 2 fast-path)."
      echo "[ci-local] Running gitleaks on host as the only gate..."
      if ! command -v gitleaks >/dev/null 2>&1; then
        echo "[ci-local] WARN: gitleaks not installed; skipping. brew install gitleaks." >&2
      else
        gitleaks dir . --redact --no-banner
        gitleaks git . --redact --no-banner --log-opts="origin/master..HEAD"
      fi
      echo "[ci-local] Doc-only fast-path complete. No code paths exercised."
      trap - EXIT
      exit 0
      ;;
    EMPTY)
      echo "[ci-local] --diff: diff is empty (clean branch) — running full gate per fail-closed contract."
      ;;
    SRC)
      echo "[ci-local] --diff: diff touches src/ — running selected E2E + full unit phase."
      ;;
    *)
      echo "[ci-local] WARN: select-e2e.ts --classify-only returned '$CLASSIFICATION' — running full gate." >&2
      ;;
  esac
fi

# Pre-flight: postgres host ports for active shards. Defaults to 5434-5437 (avoid
# 5432 manual gbrain-test-pg, 5433 commonly held by sibling projects).
# GBRAIN_CI_PG_PORT defines BASE; shards take BASE..BASE+3.
PG_PORT_BASE="${GBRAIN_CI_PG_PORT:-5434}"
for shard in $(seq 1 "$SHARD_COUNT"); do
  port=$((PG_PORT_BASE + shard - 1))
  PORT_OWNER=$(docker ps --filter "publish=$port" --format "{{.Names}}" | head -1)
  if [ -n "$PORT_OWNER" ]; then
    echo "[ci-local] ERROR: host port $port (shard $shard) is already used by docker container '$PORT_OWNER'." >&2
    echo "[ci-local] Either stop that container or run with: GBRAIN_CI_PG_PORT=NNNN bun run ci:local" >&2
    exit 1
  fi
  if lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    echo "[ci-local] ERROR: host port $port (shard $shard) is held by a non-docker process." >&2
    echo "[ci-local] Run with: GBRAIN_CI_PG_PORT=NNNN bun run ci:local" >&2
    exit 1
  fi
done
export GBRAIN_CI_PG_PORT="$PG_PORT_BASE"
for shard in $(seq 2 "$SHARD_COUNT"); do
  port_var="GBRAIN_CI_PG_PORT_$shard"
  printf -v "$port_var" '%s' "$((PG_PORT_BASE + shard - 1))"
  export "$port_var"
done

# Step 0: gitleaks on the host (no docker, no postgres, no bun needed).
# Mirrors test.yml's separate gitleaks job. Fail loudly if not installed.
echo "[ci-local] gitleaks detect (host)..."
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[ci-local] ERROR: gitleaks not installed on host." >&2
  echo "[ci-local]   macOS:  brew install gitleaks" >&2
  echo "[ci-local]   Linux:  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 1
fi
# Two scopes for pre-push:
#   1. Working-tree files (catch uncommitted secrets sitting in files)
#   2. Branch commits vs origin/master (catch secrets committed on this branch)
# Full-history scan is ~4 min on this repo's 3700+ commits; not useful pre-push.
gitleaks dir . --redact --no-banner
gitleaks git . --redact --no-banner --log-opts="origin/master..HEAD"

# Step 1: pull. Refreshes pgvector + oven/bun:1 (both are `image:` not `build:`).
if [ "$NO_PULL" = "0" ]; then
  echo "[ci-local] Pulling base images (use --no-pull to skip)..."
  docker compose -f "$COMPOSE_FILE" pull 2>&1 | tail -5
fi

# Step 2: active postgres shards up + wait for healthy.
POSTGRES_SERVICES=()
for shard in $(seq 1 "$SHARD_COUNT"); do
  POSTGRES_SERVICES+=("postgres-$shard")
done
echo "[ci-local] Starting $SHARD_COUNT postgres shard(s)..."
docker compose -f "$COMPOSE_FILE" up -d "${POSTGRES_SERVICES[@]}"
echo "[ci-local] Waiting for $SHARD_COUNT postgres shard(s) healthy..."
for i in {1..40}; do
  all_healthy=1
  for shard in $(seq 1 "$SHARD_COUNT"); do
    status=$(docker compose -f "$COMPOSE_FILE" ps --format json postgres-$shard 2>/dev/null | grep -o '"Health":"[^"]*"' | head -1 | sed 's/.*":"//;s/"//')
    if [ "$status" != "healthy" ]; then
      all_healthy=0
      break
    fi
  done
  if [ "$all_healthy" = "1" ]; then
    echo "[ci-local] All $SHARD_COUNT postgres shard(s) healthy."
    break
  fi
  if [ "$i" = "40" ]; then
    echo "[ci-local] ERROR: not all postgres shards became healthy in 40 attempts" >&2
    exit 1
  fi
  sleep 1
done

# Step 3: smoke-test run-e2e.sh argv + shard handling.
echo "[ci-local] Smoke: run-e2e.sh argv + shard..."
SMOKE_NO_ARGS=$(bash scripts/run-e2e.sh --dry-run-list | wc -l | tr -d ' ')
EXPECTED_ALL=$(ls test/e2e/*.test.ts | wc -l | tr -d ' ')
if [ "$SMOKE_NO_ARGS" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: --dry-run-list (no args) printed $SMOKE_NO_ARGS, expected $EXPECTED_ALL" >&2
  exit 1
fi
SMOKE_ONE_ARG=$(bash scripts/run-e2e.sh --dry-run-list test/e2e/sync.test.ts)
if [ "$SMOKE_ONE_ARG" != "test/e2e/sync.test.ts" ]; then
  echo "[ci-local] ERROR: --dry-run-list with 1 arg printed '$SMOKE_ONE_ARG'" >&2
  exit 1
fi
SHARD_TOTAL=0
for shard in $(seq 1 "$SHARD_COUNT"); do
  shard_files=$(SHARD="$shard/$SHARD_COUNT" bash scripts/run-e2e.sh --dry-run-list | wc -l)
  SHARD_TOTAL=$((SHARD_TOTAL + shard_files))
done
if [ "$SHARD_TOTAL" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: $SHARD_COUNT shard(s) covered $SHARD_TOTAL files, expected $EXPECTED_ALL" >&2
  exit 1
fi
echo "[ci-local] Smoke OK ($SMOKE_NO_ARGS files no-arg, 1 single-arg, ${SHARD_TOTAL}=${SHARD_COUNT}-shard total)."

# Unit profile smoke: heavy and light must remain an exact, disjoint partition
# of the full fast unit set. This makes the memory-aware split fail closed.
UNIT_SMOKE_DIR=$(mktemp -d /tmp/gbrain-unit-profile-smoke.XXXXXX)
bash scripts/run-unit-shard.sh --profile=all --dry-run-list > "$UNIT_SMOKE_DIR/all"
bash scripts/run-unit-shard.sh --profile=heavy --dry-run-list > "$UNIT_SMOKE_DIR/heavy"
bash scripts/run-unit-shard.sh --profile=light --dry-run-list > "$UNIT_SMOKE_DIR/light"
sort "$UNIT_SMOKE_DIR/heavy" "$UNIT_SMOKE_DIR/light" > "$UNIT_SMOKE_DIR/combined"
if ! cmp -s "$UNIT_SMOKE_DIR/all" "$UNIT_SMOKE_DIR/combined"; then
  echo "[ci-local] ERROR: heavy/light unit profiles do not exactly cover the full unit set." >&2
  rm -rf "$UNIT_SMOKE_DIR"
  exit 1
fi
if [ -n "$(comm -12 "$UNIT_SMOKE_DIR/heavy" "$UNIT_SMOKE_DIR/light")" ]; then
  echo "[ci-local] ERROR: heavy/light unit profiles overlap." >&2
  rm -rf "$UNIT_SMOKE_DIR"
  exit 1
fi
UNIT_ALL_COUNT=$(wc -l < "$UNIT_SMOKE_DIR/all" | tr -d ' ')
UNIT_HEAVY_COUNT=$(wc -l < "$UNIT_SMOKE_DIR/heavy" | tr -d ' ')
UNIT_LIGHT_COUNT=$(wc -l < "$UNIT_SMOKE_DIR/light" | tr -d ' ')
rm -rf "$UNIT_SMOKE_DIR"
echo "[ci-local] Unit profile smoke OK (${UNIT_HEAVY_COUNT} heavy + ${UNIT_LIGHT_COUNT} light = ${UNIT_ALL_COUNT})."

# Step 4: build the runner-side command.
# Tier 1: independent unit and E2E shard pools run concurrently. E2E remains
# sequential within each database shard; unit batches are memory-bounded.
# Guards + typecheck run ONCE before fan-out.
# --no-shard runs the legacy unsharded flow (debug aid).
if [ "$NO_SHARD" = "1" ]; then
  if [ "$DIFF" = "1" ]; then
    RUN_PHASES_CMD='echo "[runner] guards + typecheck"
bash scripts/check-jsonb-pattern.sh
bash scripts/check-progress-to-stdout.sh
bash scripts/check-trailing-newline.sh
bash scripts/check-wasm-embedded.sh
bun run typecheck
echo "[runner] unit (unsharded, DATABASE_URL unset)"
env -u DATABASE_URL bash scripts/run-unit-shard.sh
echo "[runner] e2e (unsharded, --diff selected)"
SELECTED=$(bun run scripts/select-e2e.ts)
if [ -z "$SELECTED" ]; then
  echo "[runner] selector emitted nothing (doc-only diff); skipping E2E."
else
  DATABASE_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test \
  GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@pgbouncer:5432/gbrain_pgbouncer \
  GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test \
  echo "$SELECTED" | xargs bash scripts/run-e2e.sh
fi'
  else
    RUN_PHASES_CMD='echo "[runner] guards + typecheck"
bash scripts/check-jsonb-pattern.sh
bash scripts/check-progress-to-stdout.sh
bash scripts/check-trailing-newline.sh
bash scripts/check-wasm-embedded.sh
bun run typecheck
echo "[runner] unit (unsharded, DATABASE_URL unset)"
env -u DATABASE_URL bash scripts/run-unit-shard.sh
echo "[runner] e2e (unsharded)"
DATABASE_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test \
GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@pgbouncer:5432/gbrain_pgbouncer \
GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test \
bash scripts/run-e2e.sh'
  fi
else
  # Tier 1 sharded path. Unit shards need no database; E2E shards each own
  # postgres-N and preserve sequential execution inside run-e2e.sh.
  if [ "$DIFF" = "1" ]; then
    DIFF_E2E_PREP='SELECTED=$(bun run scripts/select-e2e.ts)
if [ -z "$SELECTED" ]; then
  echo "" > /tmp/e2e-selected.txt
else
  echo "$SELECTED" | tr " " "\n" | grep -v "^$" > /tmp/e2e-selected.txt
fi'
  else
    # Empty file -> run-e2e.sh uses default glob (all 36 E2E files).
    DIFF_E2E_PREP='> /tmp/e2e-selected.txt'
  fi
  RUN_PHASES_CMD="echo \"[runner] guards + typecheck (run once before sharding)\"
bash scripts/check-jsonb-pattern.sh
bash scripts/check-progress-to-stdout.sh
bash scripts/check-trailing-newline.sh
bash scripts/check-wasm-embedded.sh
bun run typecheck
echo \"[runner] Tier 3: building a snapshot for the current schema inputs\"
bun run build:pglite-snapshot
export GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar
export GBRAIN_PGLITE_SNAPSHOT_DIR=test/fixtures/pglite-snapshot-dir
export GBRAIN_PGLITE_SNAPSHOT_CATALOG=test/fixtures/pglite-snapshot-catalog
# schema-drift.test.ts may reset only a test-shaped database. Its second
# safety gate requires this explicit opt-in when Docker service names replace
# localhost; run-e2e.sh preserves this one harness-owned GBRAIN_* variable.
export GBRAIN_TEST_DB=1
export GBRAIN_TEST_QUIET_MIGRATIONS=1
echo \"[runner] resolving E2E file selection (--diff aware)\"
${DIFF_E2E_PREP}
mkdir -p /tmp/heavy-unit-shard-logs /tmp/light-unit-shard-logs /tmp/e2e-shard-logs
echo \"[runner] Tier 1: adaptive ${INITIAL_WORKER_COUNT}-worker schedule across ${HEAVY_UNIT_SHARD_COUNT} heavy-unit, ${LIGHT_UNIT_SHARD_COUNT} light-unit, and ${SHARD_COUNT} E2E shards\"
set +e
run_heavy_unit_shard() (
  unit_shard=\$1
  unit_home=\$(mktemp -d /tmp/gbrain-ci-heavy-unit-\${unit_shard}.XXXXXX)
  trap 'rm -rf \"\$unit_home\"' EXIT
  export HOME=\$unit_home
  unset GBRAIN_HOME
  mkdir -p \$unit_home/.gbrain
  log=/tmp/heavy-unit-shard-logs/unit-\${unit_shard}.log
  echo \"[heavy unit \${unit_shard}] start (SHARD=\${unit_shard}/${HEAVY_UNIT_SHARD_COUNT})\" > \$log
  env -u DATABASE_URL SHARD=\${unit_shard}/${HEAVY_UNIT_SHARD_COUNT} bash scripts/run-unit-shard.sh ${HEAVY_UNIT_ARGS} >> \$log 2>&1
  unit_exit=\$?
  if [ \$unit_exit -ne 0 ]; then
    echo \"[heavy unit \${unit_shard}] FAILED (exit=\$unit_exit)\" >> \$log
    exit \$unit_exit
  fi
  echo \"[heavy unit \${unit_shard}] DONE\" >> \$log
)

run_light_unit_shard() (
  unit_shard=\$1
  unit_home=\$(mktemp -d /tmp/gbrain-ci-light-unit-\${unit_shard}.XXXXXX)
  trap 'rm -rf \"\$unit_home\"' EXIT
  export HOME=\$unit_home
  unset GBRAIN_HOME
  mkdir -p \$unit_home/.gbrain
  log=/tmp/light-unit-shard-logs/unit-\${unit_shard}.log
  echo \"[light unit \${unit_shard}] start (SHARD=\${unit_shard}/${LIGHT_UNIT_SHARD_COUNT})\" > \$log
  env -u DATABASE_URL SHARD=\${unit_shard}/${LIGHT_UNIT_SHARD_COUNT} bash scripts/run-unit-shard.sh ${LIGHT_UNIT_ARGS} >> \$log 2>&1
  unit_exit=\$?
  if [ \$unit_exit -ne 0 ]; then
    echo \"[light unit \${unit_shard}] FAILED (exit=\$unit_exit)\" >> \$log
    exit \$unit_exit
  fi
  echo \"[light unit \${unit_shard}] DONE\" >> \$log
)

run_e2e_shard() (
  e2e_shard=\$1
  e2e_home=\$(mktemp -d /tmp/gbrain-ci-e2e-\${e2e_shard}.XXXXXX)
  trap 'rm -rf \"\$e2e_home\"' EXIT
  export HOME=\$e2e_home
  unset GBRAIN_HOME
  mkdir -p \$e2e_home/.gbrain
  log=/tmp/e2e-shard-logs/e2e-\${e2e_shard}.log
  echo \"[e2e \${e2e_shard}] start (SHARD=\${e2e_shard}/${SHARD_COUNT}, DATABASE_URL=postgres-\${e2e_shard})\" > \$log
  if [ -s /tmp/e2e-selected.txt ]; then
    SHARD=\${e2e_shard}/${SHARD_COUNT} \\
    DATABASE_URL=postgresql://postgres:postgres@postgres-\${e2e_shard}:5432/gbrain_test \\
    GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@pgbouncer:5432/gbrain_pgbouncer \\
    GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test \\
    xargs -a /tmp/e2e-selected.txt bash scripts/run-e2e.sh >> \$log 2>&1
  else
    SHARD=\${e2e_shard}/${SHARD_COUNT} \\
    DATABASE_URL=postgresql://postgres:postgres@postgres-\${e2e_shard}:5432/gbrain_test \\
    GBRAIN_PGBOUNCER_URL=postgresql://postgres:postgres@pgbouncer:5432/gbrain_pgbouncer \\
    GBRAIN_PGBOUNCER_DIRECT_URL=postgresql://postgres:postgres@postgres-1:5432/gbrain_test \\
    bash scripts/run-e2e.sh >> \$log 2>&1
  fi
  e2e_exit=\$?
  if [ \$e2e_exit -ne 0 ]; then
    echo \"[e2e \${e2e_shard}] FAILED (exit=\$e2e_exit)\" >> \$log
    exit \$e2e_exit
  fi
  echo \"[e2e \${e2e_shard}] DONE\" >> \$log
)

active_pids=()
declare -A pid_kinds
initial_heavy=${INITIAL_HEAVY_UNIT_SHARDS}
if [ ${HEAVY_UNIT_SHARD_COUNT} -lt \$initial_heavy ]; then initial_heavy=${HEAVY_UNIT_SHARD_COUNT}; fi
if [ \$initial_heavy -gt 0 ]; then
  for s in \$(seq 1 \$initial_heavy); do
    run_heavy_unit_shard \$s &
    child_pid=\$!
    active_pids+=(\$child_pid)
    pid_kinds[\$child_pid]=unit
  done
fi
for s in \$(seq 1 ${SHARD_COUNT}); do
  run_e2e_shard \$s &
  child_pid=\$!
  active_pids+=(\$child_pid)
  pid_kinds[\$child_pid]=e2e
done

deferred_profiles=()
deferred_shards=()
if [ \$initial_heavy -lt ${HEAVY_UNIT_SHARD_COUNT} ]; then
  for s in \$(seq \$((initial_heavy + 1)) ${HEAVY_UNIT_SHARD_COUNT}); do
    deferred_profiles+=(heavy)
    deferred_shards+=(\$s)
  done
fi
for s in \$(seq 1 ${LIGHT_UNIT_SHARD_COUNT}); do
  deferred_profiles+=(light)
  deferred_shards+=(\$s)
done

e2e_exit=0
unit_exit=0
deferred_index=0
while [ \${#active_pids[@]} -gt 0 ]; do
  completed_pid=
  wait -n -p completed_pid \"\${active_pids[@]}\"
  completed_exit=\$?
  completed_kind=\${pid_kinds[\$completed_pid]}
  if [ \$completed_exit -ne 0 ]; then
    if [ \"\$completed_kind\" = e2e ]; then e2e_exit=1; else unit_exit=1; fi
  fi
  next_remaining=()
  for candidate_pid in \"\${active_pids[@]}\"; do
    if [ \"\$candidate_pid\" != \"\$completed_pid\" ]; then next_remaining+=(\"\$candidate_pid\"); fi
  done
  active_pids=(\"\${next_remaining[@]}\")
  unset 'pid_kinds[\$completed_pid]'
  if [ \$deferred_index -lt \${#deferred_profiles[@]} ]; then
    next_profile=\${deferred_profiles[\$deferred_index]}
    next_shard=\${deferred_shards[\$deferred_index]}
    echo \"[runner] \$completed_kind slot freed; starting \$next_profile-unit shard \$next_shard\"
    if [ \"\$next_profile\" = heavy ]; then
      run_heavy_unit_shard \$next_shard &
    else
      run_light_unit_shard \$next_shard &
    fi
    child_pid=\$!
    active_pids+=(\$child_pid)
    pid_kinds[\$child_pid]=unit
    deferred_index=\$((deferred_index + 1))
  fi
done
set -e
echo \"\"
echo \"=== HEAVY UNIT SHARD LOGS (last 12 lines each) ===\"
for s in \$(seq 1 ${HEAVY_UNIT_SHARD_COUNT}); do
  echo \"\"
  echo \"--- heavy unit \$s ---\"
  if [ -f /tmp/heavy-unit-shard-logs/unit-\$s.log ]; then
    grep -E '^\\[heavy unit ' /tmp/heavy-unit-shard-logs/unit-\$s.log || true
    tail -12 /tmp/heavy-unit-shard-logs/unit-\$s.log
  else
    echo \"(no heavy unit log file written)\"
  fi
done
echo \"\"
echo \"=== LIGHT UNIT SHARD LOGS (last 12 lines each) ===\"
for s in \$(seq 1 ${LIGHT_UNIT_SHARD_COUNT}); do
  echo \"\"
  echo \"--- light unit \$s ---\"
  if [ -f /tmp/light-unit-shard-logs/unit-\$s.log ]; then
    grep -E '^\\[light unit ' /tmp/light-unit-shard-logs/unit-\$s.log || true
    tail -12 /tmp/light-unit-shard-logs/unit-\$s.log
  else
    echo \"(no light unit log file written)\"
  fi
done
echo \"\"
echo \"=== E2E SHARD LOGS (summaries + last 20 lines each) ===\"
for s in \$(seq 1 ${SHARD_COUNT}); do
  echo \"\"
  echo \"--- e2e \$s ---\"
  if [ -f /tmp/e2e-shard-logs/e2e-\$s.log ]; then
    grep -E '^\\[e2e |^Files: |^Tests: ' /tmp/e2e-shard-logs/e2e-\$s.log || true
    tail -20 /tmp/e2e-shard-logs/e2e-\$s.log
  else
    echo \"(no E2E log file written)\"
  fi
done
echo \"\"
if [ \$unit_exit -ne 0 ] || [ \$e2e_exit -ne 0 ]; then
  echo \"[runner] One or more parallel phases failed (unit=\$unit_exit e2e=\$e2e_exit).\"
  exit 1
fi
echo \"[runner] All ${HEAVY_UNIT_SHARD_COUNT} heavy-unit, ${LIGHT_UNIT_SHARD_COUNT} light-unit, and ${SHARD_COUNT} E2E shards passed.\""
fi

INNER_CMD=$(cat <<'EOF'
set -euo pipefail
echo "[runner] bun version: $(bun --version)"
# oven/bun:1 omits git; many unit tests use mkdtemp + git init for fixtures.
if ! command -v git >/dev/null 2>&1; then
  echo "[runner] Installing git (debian apt)..."
  apt-get update -qq >/dev/null
  apt-get install -y -qq git ca-certificates >/dev/null
fi
# Container runs as root (uid 0) against a host-uid bind-mount; mark repo +
# any worktree gitdir as safe so `git status` etc. don't refuse.
git config --global --add safe.directory '*' || true
if [ ! -d /app/node_modules ] || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  echo "[runner] First run (or --clean): bun install --frozen-lockfile"
  bun install --frozen-lockfile
fi
__RUN_PHASES__
EOF
)
# Do not use Bash's pattern-substitution form here. With `patsub_replacement`
# enabled (the default on current Bash), every `&` in RUN_PHASES_CMD is
# expanded to the matched placeholder. That silently turns redirections such
# as `2>&1` into files named `__RUN_PHASES__1` and corrupts the runner script.
INNER_PREFIX=${INNER_CMD%%__RUN_PHASES__*}
INNER_SUFFIX=${INNER_CMD#*__RUN_PHASES__}
INNER_CMD="${INNER_PREFIX}${RUN_PHASES_CMD}${INNER_SUFFIX}"

# Conductor / git-worktree support: when `.git` is a file (not a directory),
# it points at a host gitdir outside the bind-mount. Without remounting that
# path, scripts/check-trailing-newline.sh and any other in-container `git`
# call exits 128 ("not a git repository"). Resolve the host gitdir + the
# shared common gitdir and bind-mount them at the same absolute paths.
EXTRA_MOUNTS=()
if [ -f .git ]; then
  WORKTREE_GITDIR=$(awk '{print $2}' .git)
  if [ -d "$WORKTREE_GITDIR" ]; then
    COMMONDIR_FILE="$WORKTREE_GITDIR/commondir"
    if [ -f "$COMMONDIR_FILE" ]; then
      COMMON_REL=$(cat "$COMMONDIR_FILE")
      COMMON_GITDIR=$(cd "$WORKTREE_GITDIR" && cd "$COMMON_REL" && pwd)
    else
      COMMON_GITDIR="$WORKTREE_GITDIR"
    fi
    # Mount the higher-level common gitdir; covers worktrees/<name> automatically.
    EXTRA_MOUNTS+=( -v "${COMMON_GITDIR}:${COMMON_GITDIR}:ro" )
    echo "[ci-local] Worktree detected; mounting shared gitdir: $COMMON_GITDIR"
  fi
fi

echo "[ci-local] Running checks inside runner container..."
docker compose -f "$COMPOSE_FILE" run --rm "${EXTRA_MOUNTS[@]}" runner bash -c "$INNER_CMD"

echo ""
echo "[ci-local] All checks passed."
