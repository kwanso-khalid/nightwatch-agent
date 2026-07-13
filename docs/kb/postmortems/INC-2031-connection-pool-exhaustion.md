# INC-2031: Connection Pool Exhaustion

**Date:** 2026-06-15
**Service:** checkout-service
**Duration:** 12 minutes
**MTTR:** 3 minutes (agent investigation) + 9 minutes (rollback + recovery)

## Summary
A config deployment reduced `DB_POOL_MAX` from 50 to 5. Under normal load (~30 req/min), all 5 connections were consumed within 2 minutes. New requests queued and timed out after 5 seconds.

## Root Cause
Deploy `v483` changed `DB_POOL_MAX: 50 → 5` as part of a cost-optimization config change. The engineer intended to reduce idle connections but set the value too low for production load.

## Evidence
- Error signature: `SQLTimeoutException: timeout after 5000ms waiting for connection from pool [pool=checkout-db-primary, active=5, max=5, queued=164]`
- Deploy diff showed `DB_POOL_MAX` change from 50 to 5
- Error onset aligned exactly with deploy timestamp
- CPU and memory were normal — ruled out resource pressure

## Resolution
Rolled back to `v482` (previous task definition). Error rate returned to zero within 90 seconds of rollback.

## Action Items
- Add deploy-time validation: reject `DB_POOL_MAX < 20` in CI pipeline
- Add CloudWatch alarm for connection pool saturation metric
