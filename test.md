Scene 1: The board (10 seconds)

Open a new agent chat and type:

show my board

What to show: The interactive dashboard renders inline. Pause to let the viewer see the sections — Needs attention at the top, then In Review, In Progress, Todo. Point out the colored left borders (grey = fresh, amber = aging, coral = stale) and the stats bar at the bottom.

Scene 2: Click to expand (10 seconds)

Click on any PR card in the In Review section.

What to show: The card expands to reveal PR description, diff stats (+120 -30), changed files, and CI check details with durations (lint 12s · test 2m). This data was lazy-fetched from GitHub — it wasn't loaded upfront.

Click again to collapse.

Scene 3: Conversational drill-down (10 seconds)

In the same chat, type:

tell me about PR #4525

(Use a real PR number that's on your board.)

What to show: The agent returns structured details — description, reviewers, CI status, files changed. The point is you didn't leave the editor to get this.

Scene 4: Standup (10 seconds)

Type:

write my standup

What to show: The agent generates a standup update from your real data — what you worked on, what's in review, what's blocked. Copy-paste ready for Slack.

Scene 5: Start a task (15 seconds)

Type:

what should I work on next?

The agent ranks your Todo issues. Then type:

start ENG-XXXX

(Use a real issue ID from the suggestion.)

What to show: The agent assigns the issue to you in Linear and moves it to In Progress. You can quickly flip to Linear to show it actually moved (optional but impressive).

Scene 6: Context continuity — the headline moment (15 seconds)

Close the chat entirely. Open a brand new agent chat. Type:

catch me up

What to show: The agent knows what you were just working on — the task you started, the PR that's open, who's reviewing it. No re-explaining. This is the moment that sells it.

Scene 7: Auto-refresh (optional, 10 seconds)

If you want to show the live refresh, leave the board open for 90 seconds. When it refreshes, changed cards pulse briefly with a blue highlight. You could speed this up in post-production or just mention it.

Total runtime: ~60-90 seconds of actual interaction.

Talking points to weave in:

"This is real data from my Linear and GitHub — not a mock"
"Everything happens inside the editor — I never opened a browser tab"
"The agent has tools, not scripts — it understands natural language questions about my workflow"
"Context continuity means I never lose my place across chat sessions"
Do you want me to adjust anything — different order, different emphasis, or skip certain scenes?

