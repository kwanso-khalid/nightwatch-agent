#!/bin/bash
# Phase A0: Verify AWS environment before deploying anything.
# Run: bash scripts/aws/00-check-env.sh

set -e

echo "=== AWS ENVIRONMENT CHECK ==="
echo ""

# 1. Credentials
echo "1. AWS Credentials:"
IDENTITY=$(aws sts get-caller-identity --region us-east-1 --output json 2>&1) || {
  echo "   FAIL: AWS credentials not configured or expired."
  echo "   Fix: aws configure, or export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"
  exit 1
}
ACCOUNT=$(echo "$IDENTITY" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")
echo "   Account: $ACCOUNT"
echo "   OK"

# 2. Region
echo ""
echo "2. Region:"
REGION=$(aws configure get region 2>/dev/null || echo "${AWS_DEFAULT_REGION:-${AWS_REGION:-unset}}")
echo "   Configured region: $REGION"
if [ "$REGION" != "us-east-1" ]; then
  echo "   WARNING: Region is not us-east-1. Setting for this session."
  export AWS_DEFAULT_REGION=us-east-1
fi
echo "   Using: us-east-1"
echo "   OK"

# 3. Bedrock model access
echo ""
echo "3. Bedrock Model Access (Claude Sonnet):"
MODELS=$(aws bedrock list-foundation-models --region us-east-1 \
  --query "modelSummaries[?contains(modelId,'claude') && contains(modelId,'sonnet')].modelId" \
  --output text 2>&1) || {
  echo "   FAIL: Cannot list Bedrock models. Check IAM permissions."
  echo "   Needed: bedrock:ListFoundationModels"
  exit 1
}
if [ -z "$MODELS" ]; then
  echo "   FAIL: No Claude Sonnet models found."
  echo "   Go to: AWS Console > Bedrock > Model access > Request access to Claude models"
  exit 1
fi
echo "   Available: $MODELS"

# Check for inference profiles (cross-region)
echo ""
echo "   Checking inference profiles:"
PROFILES=$(aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'sonnet')].inferenceProfileId" \
  --output text 2>/dev/null) || echo "   (no inference profiles API or none found)"
if [ -n "$PROFILES" ]; then
  echo "   Profiles: $PROFILES"
fi
echo "   OK"

# 4. SAM CLI
echo ""
echo "5. SAM CLI:"
SAM_VERSION=$(sam --version 2>&1) || {
  echo "   FAIL: SAM CLI not installed."
  echo "   Install: pip install aws-sam-cli"
  exit 1
}
echo "   $SAM_VERSION"
echo "   OK"

echo ""
echo "=== ENVIRONMENT REPORT ==="
echo "  Account:      $ACCOUNT"
echo "  Region:       us-east-1"
echo "  Claude:       $MODELS"
echo "  SAM CLI:      $SAM_VERSION"
echo ""
echo "All checks passed. Ready for deployment."
