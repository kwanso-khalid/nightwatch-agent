# Nightwatch — How It Works

## What Is Nightwatch?

Nightwatch is an AI agent that sits in production and automatically investigates incidents. When something breaks, a CloudWatch Alarm fires, SNS delivers the notification, and a Lambda function invokes the Bedrock Agent. The agent reads real metrics, logs, and deployment history, correlates the signals, and sends a structured investigation report to Slack. The on-call engineer wakes up to an answer, not a mystery.

**It does NOT fix anything.** It investigates and reports. The engineer makes the decision.

---

## The Flow

```
CloudWatch Alarm → SNS Topic → Trigger Lambda → Bedrock Agent (Claude Sonnet 4.6)
                                                       ↓
                                                 Tool Lambda (reads CloudWatch, ECS)
                                                       ↓
                                                 Slack Notification (investigation report)
```

---

## Step by Step

### Step 1: Your App Runs on AWS

A checkout service runs on ECS Fargate. It processes orders, handles payments, and logs everything to CloudWatch. Normal operation — ~30 requests/minute, all successful.

**AWS service:** ECS Fargate (container)

### Step 2: Something Goes Wrong

The app starts failing. Depending on the issue:
- Database connections exhaust → `SQLTimeoutException`
- Upstream payment service goes down → `UpstreamTimeout`

Errors flood CloudWatch Logs as structured JSON.

**AWS service:** CloudWatch Logs

### Step 3: CloudWatch Detects the Problem (AUTOMATIC)

A CloudWatch Alarm monitors error count per minute. When errors exceed the threshold, the alarm transitions from OK → ALARM and publishes a notification to an SNS Topic.

This is automatic — no human involved.

**AWS services:** CloudWatch Alarm + SNS Topic

### Step 4: Nightwatch Agent Wakes Up (AUTOMATIC)

SNS delivers the alarm notification to the Trigger Lambda. This Lambda:
1. Parses the alarm details (which alarm, when, why)
2. Records the investigation start in DynamoDB
3. Invokes the Bedrock Agent with the alarm context

**AWS services:** SNS + Trigger Lambda + DynamoDB

### Step 5: AI Investigates Using Real Data

The Bedrock Agent (powered by Claude Sonnet 4.6) decides what to check. It tool-calls the Tool Lambda — each tool reads real AWS data:

| Tool | What it reads | AWS API |
|------|--------------|---------|
| `get_service_health` | Is the service running? Are alarms firing? | ECS DescribeServices + CloudWatch DescribeAlarms |
| `get_error_logs` | What errors? How many? When did they start? | CloudWatch Logs Insights |
| `get_metrics` | CPU, memory, error count trends | CloudWatch GetMetricData |
| `get_recent_deploys` | Did a deployment cause this? | ECS task definition history |

The agent calls each tool as needed. Total data sent to the model: ~1,400 tokens (pre-aggregated summaries, not raw log dumps).

**AWS services:** Bedrock Agent + Tool Lambda — READ-ONLY

### Step 6: Agent Connects the Dots

The AI correlates signals across all data sources. For example:
- "All 303 errors are UpstreamTimeout pointing to payments-api.internal"
- "CPU at 1.2%, memory at 5.3% — resource pressure ruled out"
- "Last deploy was 12 hours ago — deploy ruled out as cause"
- "Conclusion: upstream dependency failure, not our code"

### Step 7: Report Delivered to Slack

The Trigger Lambda collects the agent's findings and sends a structured report to Slack:

```
Incident Detected
Service: checkout-service
Alarm: nightwatch-checkout-error-rate
Time: 07:08 UTC

Investigation Complete
Root Cause: payments-api.internal timing out on POST /v1/charges

Confidence: 95%

Errors: 303 UpstreamTimeout from 06:45 to ongoing
Sample: upstream timeout: payments-api.internal POST /v1/charges
        timed out after 4298ms retries=3/3

Evidence:
 All 303 errors are UpstreamTimeout — not our code
 CPU 1.2%, memory 5.3% — resource pressure ruled out
 Last deploy 12 hours ago — bad deploy ruled out

Recommended Action: Escalate to payments-api team
to investigate /v1/charges endpoint latency.

Investigation time: 60s
```

**AWS services:** Slack (webhook)

### Step 8: Engineer Makes the Decision

The on-call engineer reads the report — root cause, evidence, recommendation — and decides what to do. Rollback, restart, escalate, or monitor. The agent gave them a 60-second head start on a 45-minute investigation.

---

## Test Scenarios

### Scenario 1: Database Connection Pool Exhaustion

**What happens:** The app's database connection pool is limited to 5 connections. Under normal load, all 5 connections get consumed. New requests queue up, eventually timing out.

**Error signature:** `SQLTimeoutException: timeout after 5000ms waiting for connection from pool [pool=checkout-db-primary, active=5, max=5, queued=164]`

**What the agent finds:**
- All errors are SQLTimeoutException from checkout-db-primary
- Connection pool fully saturated: active=5, max=5
- CPU and memory normal — not a resource issue
- No recent deploy — not a code regression

**Agent recommendation:** "Inspect checkout-db-primary for slow queries or lock contention. Consider increasing pool size above 5."

**Trigger:** `curl -X POST "http://<IP>:3000/chaos/enable?mode=db-pool" -H "Authorization: Bearer chaos-secret"`

### Scenario 2: Upstream Payment Service Timeout

**What happens:** The internal payment processing service (`payments-api.internal`) becomes unresponsive. The checkout service tries to call POST /v1/charges but the request times out after 4-6 seconds, even after 3 retries.

**Error signature:** `upstream timeout: payments-api.internal POST /v1/charges timed out after 4298ms retries=3/3`

**What the agent finds:**
- All errors are UpstreamTimeout pointing to payments-api.internal
- Specific endpoint: POST /v1/charges
- CPU and memory normal — checkout-service itself is fine
- No recent deploy — not caused by our code

**Agent recommendation:** "Escalate to payments-api team to investigate /v1/charges endpoint. Restarting checkout-service will NOT fix an upstream issue."

**Trigger:** `curl -X POST "http://<IP>:3000/chaos/enable?mode=upstream-timeout" -H "Authorization: Bearer chaos-secret"`

### Disable both:
```bash
curl -X POST "http://<IP>:3000/chaos/disable" -H "Authorization: Bearer chaos-secret"
```

---

## Security

The agent can only **READ**. It has explicit DENY policies blocking all write operations:

| Blocked | Why |
|---------|-----|
| ecs:UpdateService, StopTask, RunTask | Cannot restart or modify services |
| ec2:*, rds:*, iam:* | Cannot touch infrastructure |
| s3:PutObject, DeleteObject | Cannot modify storage |
| dynamodb:PutItem (on other tables) | Cannot write to other data |
| lambda:InvokeFunction, UpdateFunctionCode | Cannot modify other functions |

The only write the Trigger Lambda makes is to the `nightwatch-investigations` DynamoDB table — recording that an investigation happened.

---

## What's Real vs What's Simulated

| Component | Real or Simulated? |
|-----------|-------------------|
| Application (checkout-service) | **Real** — running on ECS Fargate |
| Error logs | **Real** — actual application errors in CloudWatch |
| CloudWatch Alarm | **Real** — fires on actual error threshold |
| SNS notification | **Real** — delivers alarm to Trigger Lambda |
| AI reasoning (Claude Sonnet 4.6) | **Real** — genuine AI analysis |
| Tool calls (metrics, logs, deploys) | **Real** — reads actual CloudWatch/ECS APIs |
| Slack notifications | **Real** — actual webhook messages |
| The "chaos" (failure injection) | **Simulated** — triggered via endpoint to create real errors |
| The failure itself (DB pool, upstream timeout) | **Simulated** — app generates realistic error patterns |
