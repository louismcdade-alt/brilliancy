#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
echo "=== pass 1: 27 accounts @120 random / 30 stars ==="
node scripts/harvest-multi.mjs $(node scripts/usable-accounts.mjs --min-moves 4) --negatives 120 --max-stars 30 --workers 6
echo
echo "=== pass 2: top-up the five deep accounts @300 / 60 ==="
node scripts/harvest-multi.mjs alun_elderbrownesq apesquared askindale bluecane louismcdade --negatives 300 --max-stars 60 --workers 6
echo "HARVEST COMPLETE"
