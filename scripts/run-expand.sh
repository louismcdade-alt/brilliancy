#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
ACCOUNTS="1kevt 33_ad 3zylryb 64squarepawncocktail 876543z1 8lunder8oss 99syzygy99 aa11play aanda_amarimcm actuaryesquire adhvik_arun11 adlrrulz agoat67chess ajedrezgavalar albump alexberry16 aliveandfree alvin-jiang andrewsc21 angelsenvy88 anpu3 arango82 artfularcher_75 artmarkham atbinusprime atikinwarhammer atterberry aussieaoe australianson badgal_leelee bigdurm bishopraider blackmancer blambozor blaserf3 blessedcat blundermanagement17 bobslo1611 braindeadcz btownsfinest bubbawise-2024 budgie_empire cathal64 cdjw danaskew dare-dare daveborn deeteeyem duglet eagle116 ejarov fmlyhm hex jay_781 john_t_ormerod judeahardy kingkoala_012 lorookie mastermatthew52 mgraber1"
echo "=== scraping lists ==="
node scripts/brilliant-list.mjs $ACCOUNTS --max-scrolls 120
echo
echo "=== usable accounts ==="
USABLE=$(node scripts/usable-accounts.mjs --min-moves 4)
echo "$USABLE"
echo
echo "=== harvesting ==="
node scripts/harvest-multi.mjs $USABLE --negatives 120 --max-stars 30
