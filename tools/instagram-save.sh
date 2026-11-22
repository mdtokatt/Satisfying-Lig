#!/bin/sh
# Instagram görevi: günün sonundaki lig durumunu (data/instagram/state.json) ve günün özetini instagram-data dalına kaydeder.
# Ertesi günün görevi oradan devam eder (tools/instagram-gorev.md, 1. adım). main dalına ve çalışma kopyasına dokunmaz.
# Kullanım: sh tools/instagram-save.sh <tarih YYYY-MM-DD>
set -e
cd "$(dirname "$0")/.."
DAY="${1:?tarih gerekli (YYYY-MM-DD)}"
STATE=data/instagram/state.json
SUM="out/instagram/$DAY/summary.json"
[ -f "$STATE" ] || { echo "❌ $STATE yok: önce node tools/instagram.js çalışmalı"; exit 1; }
TMP=$(mktemp -d)
cp "$STATE" "$TMP/state.json"
[ -f "$SUM" ] && cp "$SUM" "$TMP/summary.json"
W="$TMP/wt"
if git fetch -q origin instagram-data 2>/dev/null; then
  git worktree add -q --detach "$W" FETCH_HEAD
  git -C "$W" checkout -q -B instagram-data
else
  # first time: a branch with only the Instagram data (no history of main)
  git worktree add -q --detach "$W"
  git -C "$W" checkout -q --orphan instagram-data
  git -C "$W" rm -rq --cached . >/dev/null
  find "$W" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  printf '# instagram-data\n\nInstagram görevinin (tools/instagram-gorev.md, main dalı) lig durumu ve günlük özetleri. Elle değiştirmeyin.\n' > "$W/README.md"
  git -C "$W" add README.md
fi
mkdir -p "$W/data/instagram/days"
cp "$TMP/state.json" "$W/data/instagram/state.json"
[ -f "$TMP/summary.json" ] && cp "$TMP/summary.json" "$W/data/instagram/days/$DAY.json"
git -C "$W" add data/instagram
if git -C "$W" diff --cached --quiet; then echo "Değişiklik yok"; else git -C "$W" commit -q -m "Instagram: $DAY sonu lig durumu ve günün seçimleri"; fi
ok=0
for i in 1 2 3 4; do
  if git -C "$W" push -q origin instagram-data; then ok=1; break; fi
  sleep $((i * 4))
done
git worktree remove --force "$W"
rm -rf "$TMP"
[ "$ok" = 1 ] && echo "✅ instagram-data dalına kaydedildi ($DAY)" || { echo "❌ instagram-data dalına gönderilemedi"; exit 1; }
