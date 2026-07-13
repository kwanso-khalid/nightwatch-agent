# Nightwatch — Autonomous Incident Response Agent

## What It Is

Nightwatch is an AI agent built on Amazon Bedrock that sits in production and autonomously investigates incidents. When a CloudWatch Alarm fires, an SNS notification triggers a Lambda function, which invokes the Bedrock Agent. The agent reads real metrics, logs, and deployment history via tool-calling, correlates the signals, forms an evidence-based hypothesis, and sends the investigation report to Slack. It does not fix anything — it investigates and reports.

## How It Works

```
CloudWatch Alarm → SNS Topic → Trigger Lambda → Bedrock Agent (Claude Sonnet 4.6)
                                                       ↓
                                                 Tool Lambda (reads CloudWatch, ECS)
                                                       ↓
                                                 Slack Notification (investigation report)
```

1. CloudWatch Alarm detects anomaly and publishes to SNS
2. SNS triggers the Trigger Lambda
3. Trigger Lambda records the investigation in DynamoDB and invokes the Bedrock Agent
4. Bedrock Agent (Claude Sonnet 4.6) tool-calls to read metrics, logs, deploys, service health
5. Agent correlates signals, forms hypothesis with evidence
6. Trigger Lambda sends structured investigation report to Slack

## AWS Resources

| Resource | Purpose | Idle Cost |
| -------- | ------- | --------- |
| Trigger Lambda | SNS → Bedrock Agent invocation | $0 |
| Tool Lambda | Read-only tools (metrics, logs, deploys, health) | $0 |
| DynamoDB | Investigation state tracking | $0 |
| S3 | Postmortem storage (knowledge flywheel) | $0 |
| Bedrock Agent | Claude Sonnet 4.6 reasoning | $0 |
| SNS Topic | CloudWatch Alarm → Lambda delivery | $0 |
| IAM Role | Agent execution permissions | $0 |

**Total: $0/month idle. ~$0.03 per investigation.**

## Bedrock Features Used

- **Bedrock Agents** — orchestrates investigation loop, decides which tools to call
- **Action Groups** — tools connected to Tool Lambda (health, metrics, logs, deploys)
- **Claude Sonnet 4.6** — reasoning engine via inference profile

## Key Architecture

### Read-Only Agent
The agent can only READ. It has explicit DENY policies blocking all write operations (ECS updates, EC2, RDS, IAM, S3 writes, etc.). The only write is the Trigger Lambda recording the investigation in DynamoDB.

### Knowledge Flywheel
Every postmortem → saved to S3 → loaded into KB on next cold start → next investigation finds it.

### Tool-Calling Flow
The Bedrock Agent decides which tools to call based on the alarm context:

| Tool | What it reads | AWS API |
|------|--------------|---------|
| `get_service_health` | Service status, alarms, task count | ECS DescribeServices + CloudWatch DescribeAlarms |
| `get_error_logs` | Error counts, patterns, samples | CloudWatch Logs Insights |
| `get_metrics` | CPU, memory, error count trends | CloudWatch GetMetricData |
| `get_recent_deploys` | Deployment history, config changes | ECS task definition history |

## Integrations

- **Slack** — investigation report delivered via webhook
- **S3** — postmortem storage for knowledge flywheel

## Project Structure

```
checkout-service/           # Production service (Node + Docker)
tool-lambda/                # Bedrock Action Group Lambda (read-only tools)
trigger-lambda/             # SNS → Bedrock Agent invocation
infra/                      # CDK infrastructure
scripts/                    # Setup, deploy, teardown
docs/                       # Architecture diagrams and documentation
```

## Commands Reference

```bash
bash scripts/setup.sh              # Install dependencies
bash scripts/aws/deploy-all.sh     # Deploy to AWS
bash scripts/aws/teardown.sh       # Delete all AWS resources
```
