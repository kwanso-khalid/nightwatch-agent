# Deploy Rollback Procedure

## When to Use
- A deployment introduces errors (error rate > 5/min within 10 minutes of deploy)
- Service health degrades immediately after a deploy
- Config change causes resource exhaustion (connection pool, memory)

## Steps
1. Identify the last known good task definition revision
2. Update the ECS service to use the previous task definition
3. Monitor error rate and latency for 5 minutes post-rollback
4. Confirm recovery: error rate returns to baseline, no new error patterns

## Verification
- `get_service_health` shows HEALTHY status
- `get_metrics` shows error_count returning to baseline
- `get_error_logs` shows no new errors after rollback timestamp
