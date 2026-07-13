# Database Connection Issues

## Symptoms
- `SQLTimeoutException` in logs
- Connection pool exhaustion: `active=N, max=N, queued=M`
- Increasing request latency without CPU/memory pressure

## Common Causes
1. **Pool size too small** — `DB_POOL_MAX` reduced below load requirements
2. **Slow queries** — long-running queries hold connections, starving new requests
3. **Connection leak** — connections not returned to pool after use

## Investigation Steps
1. Check `get_error_logs` for `SQLTimeoutException` patterns — note `active`, `max`, `queued` values
2. Check `get_recent_deploys` for config changes to `DB_POOL_MAX` or database settings
3. Check `get_metrics` for CPU/memory — normal values rule out resource pressure

## Resolution
- If pool size was recently changed: rollback the deployment
- If slow queries: escalate to database team for query analysis
- If connection leak: restart service as immediate mitigation, then deploy fix
