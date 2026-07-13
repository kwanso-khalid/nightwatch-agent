#!/bin/bash
# Automated teardown of all Nightwatch AWS resources.
# Usage: bash scripts/aws/teardown.sh
#
# Deletes:
#   - Bedrock Agent (alias + agent)
#   - Bedrock Guardrail
#   - IAM role (inline policy + role)
#   - Knowledge Base S3 bucket
#   - CDK stack (VPC, ECS, Lambda, DynamoDB, SNS, CloudWatch)
#   - Local cleanup (.env.demo, cdk-outputs.json)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env.demo"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env.demo found at $ENV_FILE"
  echo "Nothing to tear down."
  exit 0
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
REGION="${AWS_REGION:-us-east-1}"

echo "=========================================="
echo "  NIGHTWATCH — TEARDOWN"
echo "=========================================="
echo ""

# 1. Delete Bedrock Agent
if [ -n "$BEDROCK_AGENT_ID" ]; then
  echo "1. Deleting Bedrock Agent ($BEDROCK_AGENT_ID)..."

  if [ -n "$BEDROCK_AGENT_ALIAS_ID" ]; then
    aws bedrock-agent delete-agent-alias \
      --agent-id "$BEDROCK_AGENT_ID" \
      --agent-alias-id "$BEDROCK_AGENT_ALIAS_ID" \
      --region "$REGION" 2>/dev/null && echo "   Alias deleted." || echo "   Alias already deleted."
  fi

  aws bedrock-agent delete-agent \
    --agent-id "$BEDROCK_AGENT_ID" \
    --skip-resource-in-use-check \
    --region "$REGION" 2>/dev/null && echo "   Agent deleted." || echo "   Agent already deleted."
else
  echo "1. No BEDROCK_AGENT_ID found — skipping."
fi
echo ""

# 2. Delete Bedrock Guardrail
if [ -n "$BEDROCK_GUARDRAIL_ID" ]; then
  echo "2. Deleting Bedrock Guardrail ($BEDROCK_GUARDRAIL_ID)..."
  aws bedrock delete-guardrail \
    --guardrail-identifier "$BEDROCK_GUARDRAIL_ID" \
    --region "$REGION" 2>/dev/null && echo "   Guardrail deleted." || echo "   Guardrail already deleted."
else
  echo "2. No BEDROCK_GUARDRAIL_ID found — skipping."
fi
echo ""

# 3. Delete IAM Role
ROLE_NAME="AmazonBedrockExecutionRoleForAgents_nightwatch"
echo "3. Deleting IAM role: $ROLE_NAME..."
aws iam delete-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "NightwatchBedrockAgentPolicy" \
  2>/dev/null && echo "   Inline policy deleted." || echo "   Policy already deleted."

aws iam delete-role \
  --role-name "$ROLE_NAME" \
  2>/dev/null && echo "   Role deleted." || echo "   Role already deleted."
echo ""

# 4. Empty and delete KB S3 bucket
KB_S3_BUCKET="${KB_S3_BUCKET:-}"
if [ -n "$KB_S3_BUCKET" ]; then
  echo "4. Emptying KB bucket: $KB_S3_BUCKET..."
  aws s3 rm "s3://$KB_S3_BUCKET" --recursive \
    --region "$REGION" 2>/dev/null && echo "   Bucket emptied." || echo "   Bucket already empty or not found."
  aws s3 rb "s3://$KB_S3_BUCKET" \
    --region "$REGION" 2>/dev/null && echo "   Bucket deleted." || echo "   Bucket already deleted."
else
  echo "4. No KB_S3_BUCKET found — skipping."
fi
echo ""

# 5. Delete CDK stack (VPC, ECS, Lambda, DynamoDB, SNS, CloudWatch)
echo "5. Deleting CDK stack: NightwatchRealStack..."
cd "$ROOT/infra"
npx cdk destroy NightwatchRealStack --force 2>/dev/null && echo "   Stack deleted." || echo "   Stack already deleted."
cd "$ROOT"
echo ""

# 6. Clean up local files
echo "6. Cleaning up local files..."
rm -f "$ENV_FILE"
echo "   Removed .env.demo"
rm -f "$ROOT/cdk-outputs.json"
echo "   Removed cdk-outputs.json"
echo ""

echo "=========================================="
echo "  TEARDOWN COMPLETE"
echo "=========================================="
echo ""
echo "All AWS resources deleted. No ongoing costs."
