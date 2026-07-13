# Nightwatch — Autonomous Incident Response Agent

An AI agent built on **Amazon Bedrock** that sits in production and autonomously investigates incidents. When a CloudWatch Alarm fires, it sends an SNS notification that triggers a Lambda, which invokes the Bedrock Agent. The agent investigates by tool-calling against real AWS data (metrics, logs, deploys), forms an evidence-based hypothesis, and sends the investigation report to Slack.

---

## Quick Start

```bash
bash scripts/setup.sh            # Install dependencies (first time)
bash scripts/aws/deploy-all.sh   # Deploy to AWS
```

---

## How It Works

```
CloudWatch Alarm → SNS Topic → Trigger Lambda → Bedrock Agent (Claude Sonnet 4.6)
                                                       ↓
                                                 Tool Lambda (reads CloudWatch, ECS)
                                                       ↓
                                                 Slack Notification (investigation report)
```

1. **Alarm fires** — CloudWatch detects anomaly (error rate, latency, etc.)
2. **SNS delivers** — Alarm publishes to an SNS topic
3. **Trigger Lambda** — Parses alarm details, records investigation in DynamoDB, invokes Bedrock Agent
4. **Agent investigates** — Claude Sonnet 4.6 tool-calls to read metrics, logs, deploys, service health
5. **Report to Slack** — Investigation findings, root cause, confidence level, and recommended action sent to Slack

---

## What the Agent Does

| Step                   | What Happens                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------- |
| CloudWatch Alarm fires | SNS triggers the Trigger Lambda                                                    |
| Agent investigates     | Tool-calls to pull metrics, logs, deploys — all read-only                          |
| Root cause found       | Forms hypothesis with confidence level, evidence chain, and ruled-out alternatives |
| Report delivered       | Sends structured investigation report to Slack                                     |

---

## Bedrock Features Used

- **Bedrock Agents** — orchestrates the investigation loop, decides which tools to call
- **Action Groups** — tools connected to Tool Lambda (health, metrics, logs, deploys)
- **Claude Sonnet 4.6** — real AI reasoning via inference profile

---

## Commands

```bash
bash scripts/setup.sh              # Install all dependencies
bash scripts/aws/deploy-all.sh     # Deploy Bedrock Agent + Knowledge Base
bash scripts/aws/teardown.sh       # Delete all AWS resources
```

---

## Key Design Decisions

- **Read-only agent.** The agent can only read CloudWatch, ECS, and logs. It has explicit DENY policies blocking all write operations. It investigates and reports — it does not fix.
- **Knowledge flywheel.** Every postmortem → S3 → loaded into KB on next cold start → future investigations find it.
- **One agent for all services.** Tools take `serviceName` as parameter. Cross-service correlation detects cascading failures.

---

## Project Structure

```
checkout-service/           # Production service (Node + Docker)
  server.mjs               # Express server with chaos injection for testing

tool-lambda/                # Bedrock Action Group Lambda (read-only tools)
trigger-lambda/             # SNS → Bedrock Agent invocation

bedrock/                    # Bedrock Agent action group schema
  action-group-functions.json

infra/                      # CDK infrastructure
  lib/infra-stack.ts        # Full stack definition (VPC, ECS, Lambda, DynamoDB, SNS)

scripts/                    # Automation
  setup.sh                  # First-time dependency install
  aws/                      # AWS deployment + teardown scripts

docs/                       # Architecture diagrams and documentation
  kb/                       # Knowledge base docs (uploaded to S3 for Bedrock KB)
    runbooks/               # Operational runbooks
    postmortems/            # Past incident reports
```

---

## Documentation

- [Agent Description](AGENT_DESCRIPTION.md) — full technical description
- [How It Works](docs/HOW-IT-WORKS.md) — step-by-step walkthrough

---

## License

[MIT](LICENSE)

