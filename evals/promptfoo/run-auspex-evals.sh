#!/bin/bash
# Run all Auspex agent behavior evals
# Usage: cd evals/promptfoo && bash run-auspex-evals.sh

set -e
source ~/my2brain/.env
export ANTHROPIC_API_KEY

echo "=== Content-Chief ==="
promptfoo eval -c promptfooconfig-content-chief.yaml --no-cache

echo ""
echo "=== Ops-Chief ==="
promptfoo eval -c promptfooconfig-ops-chief.yaml --no-cache

echo ""
echo "=== Secretary ==="
promptfoo eval -c promptfooconfig-secretary.yaml --no-cache

echo ""
echo "=== Done! Run 'promptfoo view' to see results ==="
