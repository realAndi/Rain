#!/bin/bash
# test-tmux.sh - Quick test script for Rain's tmux integration
#
# Exercises tmux sessions, splits, send-keys, and layout strings
# without needing Rain's UI. Runs entirely via the tmux CLI.
#
# Usage:
#   chmod +x scripts/test-tmux.sh
#   ./scripts/test-tmux.sh

set -e

SESSION="rain-test-$$"
TMUX_BIN=$(command -v tmux 2>/dev/null)

if [ -z "$TMUX_BIN" ]; then
    echo "error: tmux is not installed"
    exit 1
fi

echo "tmux binary: $TMUX_BIN"
echo "tmux version: $($TMUX_BIN -V)"
echo ""

# ---- Helper ----
cleanup() {
    echo ""
    echo "[cleanup] killing session $SESSION..."
    $TMUX_BIN kill-session -t "$SESSION" 2>/dev/null || true
    echo "[cleanup] done"
}
trap cleanup EXIT

# ---- 1. Create a detached session ----
echo "=== Step 1: Creating detached session '$SESSION' ==="
$TMUX_BIN new-session -d -s "$SESSION" -x 80 -y 24
echo "  session created"
echo ""

# ---- 2. List panes (should be 1) ----
echo "=== Step 2: Initial pane layout ==="
$TMUX_BIN list-panes -t "$SESSION" -F '  pane %#{pane_id}: #{pane_width}x#{pane_height} at (#{pane_left},#{pane_top})'
echo ""

# ---- 3. Split horizontally ----
echo "=== Step 3: Splitting horizontally ==="
$TMUX_BIN split-window -h -t "$SESSION"
sleep 0.3
$TMUX_BIN list-panes -t "$SESSION" -F '  pane %#{pane_id}: #{pane_width}x#{pane_height} at (#{pane_left},#{pane_top})'
echo ""

# ---- 4. Split vertically in the right pane ----
echo "=== Step 4: Splitting vertically (right pane) ==="
$TMUX_BIN split-window -v -t "$SESSION"
sleep 0.3
$TMUX_BIN list-panes -t "$SESSION" -F '  pane %#{pane_id}: #{pane_width}x#{pane_height} at (#{pane_left},#{pane_top})'
echo ""

# ---- 5. Send commands to each pane ----
echo "=== Step 5: Sending commands to each pane ==="
PANES=$($TMUX_BIN list-panes -t "$SESSION" -F '#{pane_id}')
PANE_NUM=0
for PANE in $PANES; do
    CMD="echo 'Hello from pane $PANE_NUM ($PANE)'"
    echo "  sending to $PANE: $CMD"
    $TMUX_BIN send-keys -t "$SESSION:0.$PANE" "$CMD" Enter
    PANE_NUM=$((PANE_NUM + 1))
done
sleep 1
echo ""

# ---- 6. Capture output from each pane ----
echo "=== Step 6: Capturing pane output ==="
for PANE in $PANES; do
    echo "  --- pane $PANE ---"
    $TMUX_BIN capture-pane -t "$SESSION:0.$PANE" -p | head -5
    echo ""
done

# ---- 7. Show the layout string (what Rain's parser handles) ----
echo "=== Step 7: Layout string ==="
LAYOUT=$($TMUX_BIN list-windows -t "$SESSION" -F '#{window_layout}')
echo "  $LAYOUT"
echo ""
echo "  This is the format Rain's layout parser (src-tauri/src/tmux/parser.rs)"
echo "  converts into split pane trees. Format:"
echo "    checksum,WxH,X,Y{child1,child2,...}  = horizontal split"
echo "    checksum,WxH,X,Y[child1,child2,...]  = vertical split"
echo ""

# ---- 8. Resize a pane ----
echo "=== Step 8: Resizing first pane ==="
FIRST_PANE=$(echo "$PANES" | head -1)
$TMUX_BIN resize-pane -t "$SESSION:0.$FIRST_PANE" -x 40 -y 12
sleep 0.3
$TMUX_BIN list-panes -t "$SESSION" -F '  pane %#{pane_id}: #{pane_width}x#{pane_height} at (#{pane_left},#{pane_top})'
echo ""

# ---- 9. Show updated layout string ----
echo "=== Step 9: Layout after resize ==="
LAYOUT=$($TMUX_BIN list-windows -t "$SESSION" -F '#{window_layout}')
echo "  $LAYOUT"
echo ""

# ---- 10. Create a second window ----
echo "=== Step 10: Creating second window ==="
$TMUX_BIN new-window -t "$SESSION"
sleep 0.3
$TMUX_BIN list-windows -t "$SESSION" -F '  window @#{window_id}: #{window_name} (#{window_panes} panes) layout=#{window_layout}'
echo ""

echo "=== All tests passed ==="
echo ""
echo "To test inside Rain:"
echo "  1. Type 'tmux' in Rain's terminal (hook intercepts it)"
echo "  2. Or press Cmd+Shift+T"
echo "  3. Check the status bar for the tmux badge"
