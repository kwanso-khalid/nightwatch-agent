#!/bin/bash
# First-time setup — install all dependencies.
# Usage: bash scripts/setup.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=========================================="
echo "  NIGHTWATCH — First Time Setup"
echo "=========================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found. Install it:"
  echo "  macOS:  brew install node"
  echo "  Linux:  sudo apt install nodejs npm"
  exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required. You have $(node -v)"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Install dependencies
echo ""
echo "Installing dependencies..."

echo "  → root"
cd "$ROOT" && npm install --silent 2>/dev/null

echo "  → checkout-service"
cd "$ROOT/checkout-service" && npm install --silent 2>/dev/null

echo "  → infra"
cd "$ROOT/infra" && npm install --silent 2>/dev/null

echo ""
echo "=========================================="
echo "  ✅ Setup complete!"
echo "=========================================="
echo ""
echo "To deploy to AWS:"
echo "  bash scripts/aws/deploy-all.sh"
echo ""
