# INC-2089: Payment Provider Timeout

**Date:** 2026-06-28
**Service:** checkout-service
**Duration:** 45 minutes
**MTTR:** 2 minutes (agent investigation)

## Summary
The internal payment processing service (`payments-api.internal`) became unresponsive. Checkout service calls to POST /v1/charges timed out after 4-6 seconds with 3 retries. Circuit breaker eventually opened.

## Root Cause
Upstream dependency failure. `payments-api.internal` experienced a database migration that locked critical tables for ~45 minutes. Not caused by checkout-service code or configuration.

## Evidence
- Error signature: `upstream timeout: payments-api.internal POST /v1/charges timed out after 4298ms retries=3/3`
- All errors pointed to `payments-api.internal`, not internal services
- CPU 1.2%, memory 5.3% — checkout-service resources normal
- Last deploy was 12 hours ago — not a deploy regression

## Resolution
Escalated to payments-api team. They completed the migration and service recovered. No action needed from checkout-service side.

## Action Items
- Add circuit breaker metrics to monitoring dashboard
- Establish SLA agreement with payments-api team for maintenance windows
