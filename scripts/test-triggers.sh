#!/bin/bash
# test-triggers.sh - Verify Rain's output trigger system
#
# Exercises all three default trigger patterns and the
# throttle / dedup logic in src/lib/triggers.ts.
#
# BEFORE RUNNING:
#   1. Open Rain Settings (Cmd+,)
#   2. Go to Terminal > Output Triggers
#   3. Enable all three default triggers:
#        - "Error detected"
#        - "Build completed"
#        - "Test failure"
#   4. Run this script inside a Rain terminal:
#        chmod +x scripts/test-triggers.sh
#        ./scripts/test-triggers.sh
#
# WHAT TO LOOK FOR:
#   - A macOS notification should appear for each [EXPECT NOTIFY] line
#   - Lines marked [EXPECT SUPPRESSED] should NOT produce a notification
#   - The script pauses between groups so you can confirm visually

set -e

echo "============================================"
echo "  Rain Output Triggers Test"
echo "============================================"
echo ""
echo "Make sure all three default triggers are ENABLED"
echo "in Settings > Terminal > Output Triggers."
echo ""
sleep 2

# ---- Group 1: Error detection ----
echo "--- Group 1: Error detection trigger ---"
echo "[EXPECT NOTIFY] This line contains an error message"
sleep 4
echo "[EXPECT NOTIFY] CRITICAL ERROR: something went wrong"
sleep 4
echo "[EXPECT NOTIFY] Error: file not found"
sleep 2
echo ""

# ---- Group 2: Build completed ----
echo "--- Group 2: Build completed trigger ---"
echo "[EXPECT NOTIFY] webpack compiled successfully in 1.2s"
sleep 4
echo "[EXPECT NOTIFY] Project built successfully"
sleep 4
echo "[EXPECT NOTIFY] Application bundled successfully"
sleep 2
echo ""

# ---- Group 3: Test failure ----
echo "--- Group 3: Test failure trigger ---"
echo "[EXPECT NOTIFY] FAIL src/utils.test.ts"
sleep 4
echo "[EXPECT NOTIFY] 3 tests FAILED out of 12"
sleep 4
echo "[EXPECT NOTIFY] Test suite failing: auth module"
sleep 2
echo ""

# ---- Group 4: Throttle test (3s window) ----
echo "--- Group 4: Throttle test (rapid-fire, 3s window) ---"
echo "Firing 5 identical error lines in quick succession."
echo "Only the FIRST should produce a notification."
echo ""
echo "[EXPECT NOTIFY]    error: rapid fire line 1"
echo "[EXPECT SUPPRESSED] error: rapid fire line 2"
echo "[EXPECT SUPPRESSED] error: rapid fire line 3"
echo "[EXPECT SUPPRESSED] error: rapid fire line 4"
echo "[EXPECT SUPPRESSED] error: rapid fire line 5"
sleep 2
echo ""

# ---- Group 5: Dedup test (20s window) ----
echo "--- Group 5: Dedup test (same content within 20s) ---"
echo "Waiting 4 seconds then repeating the same error line."
echo "Should still be suppressed (dedup window is 20s)."
echo ""
sleep 4
echo "[EXPECT SUPPRESSED] error: rapid fire line 1"
sleep 2
echo ""

# ---- Group 6: Fresh trigger after throttle clears ----
echo "--- Group 6: Different content should still fire ---"
echo "[EXPECT NOTIFY] A completely new Error appeared here"
sleep 2
echo ""

echo "============================================"
echo "  Test complete"
echo "============================================"
echo ""
echo "Summary:"
echo "  - Groups 1-3: each line should have triggered a notification"
echo "  - Group 4: only the first line should have triggered"
echo "  - Group 5: the repeated line should have been suppressed"
echo "  - Group 6: the new error should have triggered"
