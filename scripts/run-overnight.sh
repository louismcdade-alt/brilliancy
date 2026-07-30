#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
echo "=== resume main harvest (27 accounts @120) ==="
USABLE=$(node scripts/usable-accounts.mjs --min-moves 4)
node scripts/harvest-multi.mjs $USABLE --negatives 120 --max-stars 30
echo
echo "=== top-up originals to 300 ==="
node scripts/harvest-multi.mjs alun_elderbrownesq apesquared askindale bluecane louismcdade --negatives 300 --max-stars 60
echo
echo "=== final scores ==="
node scripts/score-multi.mjs > scripts/score-final.txt 2>&1
node scripts/loo.mjs > scripts/loo-final.txt 2>&1
echo "chain complete"
