"use strict";

// Identifiers for the checklist comment and its jump-link, shared between index.js (which renders and
// re-parses the comment) and the pr_checklist workflow's jump-link step (which finds the comment and
// links to it from the PR body). Kept in one dependency-free module so the two never drift.

// The jump-link appended to the PR description is wrapped in matching open/close sentinels; both
// derive from this one tag so they can't drift apart.
const NUDGE_TAG = "checklist-nudge";

module.exports = {
  // Author of the bot comment.
  BOT_LOGIN: "github-actions[bot]",
  // Sentinel at the top of the checklist comment body, used to identify it.
  COMMENT_MARKER: "<!-- checklist-bot -->",
  // Open/close sentinels wrapping the jump-link block; presence of the opener means it's already
  // inserted, so it's added exactly once.
  NUDGE_MARKER: `<!-- ${NUDGE_TAG} -->`,
  NUDGE_MARKER_END: `<!-- /${NUDGE_TAG} -->`,
};
