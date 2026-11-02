#!/usr/bin/env bash
# Claude Code status line: model, context usage, token spend, plan limits, session cost.
# Reads the status line JSON from stdin (see `statusLine` in Claude Code docs).
# Requires: jq. Every field is optional — missing ones are simply not rendered.

set -u

input=$(cat)

# One jq pass → tab-separated fields (cheap: status line re-runs often).
IFS=$'\t' read -r model ctx_pct ctx_used ctx_size in_tok out_tok cache_r \
  five_pct five_reset week_pct week_reset cost <<<"$(
  jq -r '
    def n: if . == null then "" else tostring end;
    [
      (.model.display_name // .model.id // "?"),
      (.context_window.used_percentage | n),
      (.context_window.total_input_tokens | n),
      (.context_window.context_window_size | n),
      (.context_window.current_usage | if . == null then null else (.input_tokens // 0) + (.cache_creation_input_tokens // 0) end | n),
      (.context_window.current_usage.output_tokens | n),
      (.context_window.current_usage.cache_read_input_tokens | n),
      (.rate_limits.five_hour.used_percentage | n),
      (.rate_limits.five_hour.resets_at | n),
      (.rate_limits.seven_day.used_percentage | n),
      (.rate_limits.seven_day.resets_at | n),
      (.cost.total_cost_usd | n)
    ] | map(if . == "" then "-" else . end) | @tsv
  ' <<<"$input" 2>/dev/null
)"

RST=$'\033[0m'; DIM=$'\033[2m'; BOLD=$'\033[1m'
GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'; MAG=$'\033[35m'

has() { [[ -n "${1:-}" && "$1" != "-" ]]; }

# Color by "used" percentage: <60 green, <85 yellow, else red.
color_for() {
  local p=${1%.*}
  if (( p < 60 )); then printf '%s' "$GRN"; elif (( p < 85 )); then printf '%s' "$YEL"; else printf '%s' "$RED"; fi
}

# 10-cell bar for a 0-100 percentage.
bar() {
  local p=${1%.*} width=10 filled i out=""
  (( p < 0 )) && p=0; (( p > 100 )) && p=100
  filled=$(( (p * width + 50) / 100 ))
  for (( i = 0; i < width; i++ )); do
    if (( i < filled )); then out+="█"; else out+="░"; fi
  done
  printf '%s' "$out"
}

# 12345 → 12.3k, 1234567 → 1.2M
human() {
  local v=${1%.*}
  if (( v >= 1000000 )); then awk -v v="$v" 'BEGIN{s=sprintf("%.1f", v/1e6); sub(/\.0$/, "", s); printf "%sM", s}'
  elif (( v >= 1000 )); then awk -v v="$v" 'BEGIN{s=sprintf("%.1f", v/1e3); sub(/\.0$/, "", s); printf "%sk", s}'
  else printf '%d' "$v"; fi
}

# Seconds until epoch → "2h14m" / "3d5h" / "45m"
until_reset() {
  local s=$(( ${1%.*} - $(date +%s) ))
  (( s <= 0 )) && { printf 'now'; return; }
  local d=$(( s / 86400 )) h=$(( s % 86400 / 3600 )) m=$(( s % 3600 / 60 ))
  if (( d > 0 )); then printf '%dd%dh' "$d" "$h"
  elif (( h > 0 )); then printf '%dh%02dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}

limit_seg() { # label used_pct resets_at
  local label=$1 p=$2 r=$3 c left
  c=$(color_for "$p")
  left=$(( 100 - ${p%.*} )); (( left < 0 )) && left=0
  printf '%s%s%s %s%s %s%% left%s' "$DIM" "$label" "$RST" "$c" "$(bar "$p")" "$left" "$RST"
  has "$r" && printf ' %s↻%s%s' "$DIM" "$(until_reset "$r")" "$RST"
}

SEP=" ${DIM}│${RST} "
parts=()

parts+=("${BOLD}${MAG}${model:-Claude}${RST}")

if has "$ctx_pct"; then
  c=$(color_for "$ctx_pct")
  seg="${DIM}ctx${RST} ${c}$(bar "$ctx_pct") ${ctx_pct%.*}%${RST}"
  has "$ctx_used" && has "$ctx_size" && seg+=" ${DIM}$(human "$ctx_used")/$(human "$ctx_size")${RST}"
  parts+=("$seg")
fi

if has "$in_tok" || has "$out_tok"; then
  seg="${DIM}last${RST} ${CYN}↑$(human "${in_tok/-/0}") ↓$(human "${out_tok/-/0}")${RST}"
  has "$cache_r" && (( ${cache_r%.*} > 0 )) && seg+=" ${DIM}cache $(human "$cache_r")${RST}"
  parts+=("$seg")
fi

has "$five_pct" && parts+=("$(limit_seg 5h "$five_pct" "$five_reset")")
has "$week_pct" && parts+=("$(limit_seg 7d "$week_pct" "$week_reset")")

if has "$cost"; then
  parts+=("${DIM}\$$(awk -v v="$cost" 'BEGIN{printf "%.2f", v}')${RST}")
fi

out=""
for p in "${parts[@]}"; do
  [[ -n "$out" ]] && out+="$SEP"
  out+="$p"
done
printf '%s\n' "$out"
