#!/usr/bin/env bash
# Runs a task Marianne asked for, by leaving data/tasks/<task>.request: the server's own script,
# ~/scripts/<task>/<task>.sh. How it went goes to data/tasks/<task>.status (for the page) and what
# it printed to data/tasks/<task>.log. Started by marianne-task@<task>.service.
set -uo pipefail

task=$1
folder="$(cd "$(dirname "$0")/.." && pwd)/data/tasks"
script="$HOME/scripts/$task/$task.sh"

status() {
  printf '{"state": "%s", "at": "%s"}\n' "$1" "$(date -Iseconds)" > "$folder/$task.status.tmp"
  mv "$folder/$task.status.tmp" "$folder/$task.status"
}

# Running before the request goes, so the page never sees the task as not asked for in between.
status running
rm -f "$folder/$task.request"
if "$script" > "$folder/$task.log" 2>&1; then
  status ok
else
  status error
fi
