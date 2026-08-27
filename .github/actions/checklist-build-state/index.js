'use strict';

const yaml = require("js-yaml");

const CONFIG_PATH = ".github/checklist_config.yaml";
const OVERRIDE_LABEL = "Override: Skip Verification Attestation";
const BOT_LOGIN = "github-actions[bot]";
const COMMENT_MARKER = "<!-- checklist-bot -->";

const SECTION_ATTESTATION = "## Verification Attestation";
const SECTION_AUTHOR      = "### Author checklist";
const SECTION_REVIEWER    = "### Reviewer checklist";

// Matches the hidden JSON state block embedded at the bottom of the bot's comment.
// Capture group 1: the raw JSON string between the delimiters.
const SCHEMA_VERSION = 1;
const STATE_BLOCK_RE = new RegExp(`<!-- checklist-state:v${SCHEMA_VERSION}\n([\\s\\S]*?)\n-->`);

// Matches a single rendered checklist line. Capture groups:
//   1: checkbox character — " " (unchecked) or "x"/"X" (checked)
//   2: full item text, which may include a "— N/A: reason" suffix added by the user
const LINE_RE = /^- \[([ xX])\] (.+?)\s*$/;

// Extracts item text and N/A reason from a line that has been opted out.
// Capture groups: 1: base item text, 2: reason after "— N/A:" or "-- N/A:"
const NA_RE = /^(.*?)\s*(?:—|--)\s*N\/A:\s*(.+)$/;

const ATTESTATIONS = [
  {
    id: "vi-executed",
    role: "author",
    text: "Author: I executed the VI and manually tested this change",
  },
  {
    id: "vi-executed",
    role: "reviewer",
    text: "Reviewer: I executed the VI and manually tested this change",
  },
];

/**
 * @typedef {{
 *   schema_version: number,
 *   config_sha: string,
 *   pr_number: number,
 *   pr_author: string,
 *   override_applied: boolean,
 *   checklist_first_posted_at: string,
 *   generated_at: string,
 *   items: Array<ReconciledItem>,
 * }} HiddenState
 *
 * @typedef {{
 *   id: string,
 *   role: string,
 *   text: string,
 *   area: string,
 *   blocking: boolean,
 *   status: string,
 *   reason?: string,
 *   conflict: boolean,
 *   actor: string,
 *   first_seen_at: string,
 *   updated_at: string,
 * }} ReconciledItem
 *
 */

const HIDDEN_STATE_FIELDS = { config_sha: "string", pr_number: "number", pr_author: "string", override_applied: "boolean", checklist_first_posted_at: "string", generated_at: "string" };
const RECONCILED_ITEM_FIELDS = { text: "string", area: "string", blocking: "boolean", status: "string", conflict: "boolean", actor: "string", first_seen_at: "string", updated_at: "string" };

/**
 * @typedef {{ id: string, role: string, text: string, area: string, blocking: boolean }} ExpectedItem
 *
 * @typedef {{ status: "pending"|"verified"|"not_applicable", reason: string|null, conflict: boolean }} CheckboxState
 *
 * @typedef {{
 *   owner: string,
 *   repo: string,
 *   now: string,
 *   senderLogin: string,
 *   pullNumber: number,
 *   isDraft: boolean,
 *   isBotSelfEdit: boolean,
 *   isCommentEvent: boolean,
 *   isChecklistEdit: boolean,
 *   overrideApplied: boolean,
 *   prAuthor: string,
 *   prHeadSha: string,
 *   baseBranch: string,
 * }} DerivedContext
 *
 * @typedef {{ id: string, text: string, roles: Array<string> }} ConfigItem
 *
 * @typedef {{ id: string, items: Array<ConfigItem>, when?: { paths: Array<string> } }} ConfigArea
 *
 * @typedef {{
 *   legend: string,
 *   reviewer_note: string,
 *   areas: Array<ConfigArea>,
 *   sha: string,
 *   expectedItems: Array<ExpectedItem>,
 * }} ChecklistConfig
 */

/**
 * Main entry point. Computes checklist state and emits GitHub Actions step outputs:
 * - skip: "true" if the comment should not be re-rendered this run
 * - is-draft: "true" if the PR is still a draft
 * - attestation-resolved: "true" if both attestation items are Verified or Not Applicable
 * - comment-body: the rendered comment (only set when skip is "false")
 *
 * @param {{ github: object, context: object, core: object }} param0
 */
module.exports = async ({ github, context, core }) => {
  const derivedContext = await deriveAdditionalContext(github, context);

  if (derivedContext.isDraft) {
    core.info("PR is still a draft - not rendering yet.");
    setOutputs(core, true, true, false, derivedContext);
    return;
  }

  const config = await fetchChecklistConfig(github, derivedContext);

  const { checkboxes, hiddenState } = await loadCommentState(github, context, core, derivedContext, config);
  const items = reconcile(core, config, checkboxes, hiddenState, derivedContext);
  const attestationResolved = computeAttestationResolved(items);

  let render = true;
  if (derivedContext.isBotSelfEdit) {
    core.info("Bot is the event sender — skipping render to prevent re-render loop.");
    render = false;
  } else if (derivedContext.isCommentEvent && !derivedContext.isChecklistEdit) {
    core.info("Edited comment is not the checklist — skipping render.");
    render = false;
  }

  setOutputs(
    core,
    !render,
    false,
    attestationResolved,
    derivedContext,
    render ? renderComment(config, items, hiddenState, derivedContext) : undefined,
  );
};

/**
 * Derives additional event-level context needed for the main logic. For issue_comment
 * events the PR draft flag is not in the payload, so the PR is fetched to retrieve it.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {object} context - actions/github-script context
 * @returns {Promise<DerivedContext>}
 */
async function deriveAdditionalContext(github, context) {
  if (context.eventName !== "issue_comment" && context.eventName !== "pull_request") {
    throw new Error(`Unsupported event type: ${context.eventName}`);
  }

  const isCommentEvent = context.eventName === "issue_comment";
  const isChecklistEdit = isCommentEvent &&
    context.payload.comment.user.login === BOT_LOGIN &&
    context.payload.comment.body.startsWith(COMMENT_MARKER);

  const { owner, repo } = context.repo;
  const pull_request = isCommentEvent
    ? (await github.rest.pulls.get({ owner, repo, pull_number: context.payload.issue.number })).data
    : context.payload.pull_request;

  return {
    owner,
    repo,
    now: new Date().toISOString(),
    senderLogin: context.payload.sender.login,
    pullNumber: pull_request.number,
    isDraft: pull_request.draft,
    prAuthor: pull_request.user.login,
    isBotSelfEdit: context.payload.sender.login === BOT_LOGIN,
    isCommentEvent,
    isChecklistEdit,
    overrideApplied: pull_request.labels.some((l) => l.name === OVERRIDE_LABEL),
    prHeadSha: pull_request.head.sha,
    baseBranch: pull_request.base.ref,
  };
}

/**
 * Sets all GitHub Actions step outputs for this action in one call.
 * Centralises the hyphenated output key strings to a single location.
 *
 * @param {object} core - @actions/core from actions/github-script
 * @param {boolean} skip - True if the comment should not be re-rendered this run
 * @param {boolean} isDraft - True if the PR is still a draft
 * @param {boolean} attestationResolved - True if both attestation items are resolved
 * @param {DerivedContext} derivedContext
 * @param {string} [commentBody] - Rendered comment body; required when skip is false, must be absent otherwise
 */
function setOutputs(core, skip, isDraft, attestationResolved, derivedContext, commentBody) {
  if (!skip && commentBody === undefined) {
    throw new Error("commentBody is required when skip is false");
  }
  if (skip && commentBody !== undefined) {
    throw new Error("commentBody must not be set when skip is true");
  }

  core.setOutput("skip", String(skip));
  core.setOutput("is-draft", String(isDraft));
  core.setOutput("attestation-resolved", String(attestationResolved));
  core.setOutput("head-sha", derivedContext.prHeadSha);
  core.setOutput("override-applied", String(derivedContext.overrideApplied));
  if (!skip) core.setOutput("comment-body", commentBody);
}

/**
 * Fetches checklist_config.yaml from the base branch, parses it, scans the PR's changed files
 * to determine which conditional areas are active, and populates config.expectedItems.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {DerivedContext} derivedContext
 * @returns {Promise<ChecklistConfig>}
 */
async function fetchChecklistConfig(github, derivedContext) {
  const { owner, repo, baseBranch } = derivedContext;
  const { data: configFile } = await github.rest.repos.getContent({
    owner,
    repo,
    path: CONFIG_PATH,
    ref: baseBranch,
  });

  const config = yaml.load(Buffer.from(configFile.content, "base64").toString("utf8"));

  config.sha = configFile.sha;
  config.expectedItems = await buildExpectedItems(github, derivedContext, config);

  return config;
}

/**
 * Builds the full expected item list: two attestation entries (one per role, both blocking)
 * followed by area items expanded into one entry per (item, role) pair, all non-blocking.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {DerivedContext} derivedContext
 * @param {ChecklistConfig} config
 * @returns {Array<ExpectedItem>}
 */
async function buildExpectedItems(github, derivedContext, config) {
  const items = [];

  for (const item of ATTESTATIONS) {
    items.push({
      id: item.id,
      role: item.role,
      text: item.text,
      area: "attestation",
      blocking: true,
    });
  }

  const activeAreaIds = await scanActiveAreas(github, derivedContext, config);

  for (const area of (config.areas || []).filter((a) => !a.when || activeAreaIds.has(a.id))) {
    for (const item of area.items || []) {
      for (const role of item.roles || []) {
        items.push({
          id: item.id,
          role,
          text: item.text,
          area: area.id,
          blocking: false,
        });
      }
    }
  }

  return items;
}

/**
 * Fetches the PR's changed files and returns the set of area IDs whose when.paths patterns
 * match at least one changed file. Areas with no when clause are never in this set — they
 * are always included regardless.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {DerivedContext} derivedContext
 * @param {ChecklistConfig} config
 * @returns {Promise<Set<string>>} Set of matched area IDs
 */
async function scanActiveAreas(github, derivedContext, config) {
  const { owner, repo, pullNumber } = derivedContext;
  const conditionalAreas = (config.areas || []).filter((a) => a.when?.paths);
  if (conditionalAreas.length === 0) return new Set();

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
  });

  // Precompile one regex per area, OR-ing all its path patterns together.
  const areaRegexes = conditionalAreas.map((area) => {
    const sources = area.when.paths.map(globToRegex);
    return new RegExp(`^(?:${sources.join('|')})$`);
  });

  const activeIds = new Set();
  // pending holds the indices of areas not yet matched so that later files skip
  // re-testing areas that already fired — including when areas overlap.
  const pending = new Set(conditionalAreas.keys());

  for (const file of files) {
    if (pending.size === 0) break;
    for (const i of pending) {
      if (areaRegexes[i].test(file.filename)) {
        activeIds.add(conditionalAreas[i].id);
        pending.delete(i);
      }
    }
  }
  return activeIds;
}

/**
 * Compiles a glob pattern into a RegExp.
 * Supported wildcards:
 *   *  — any characters except a path separator
 *   ** — any characters including path separators (a following / is consumed)
 *   ?  — exactly one character except a path separator
 *
 * @param {string} glob
 * @returns {string} Unanchored regex source, ready to embed in a larger pattern.
 */
function globToRegex(glob) {
  let re = '';

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === '*' && glob[i + 1] === '*') {
      // ** matches across directory separators
      re += '.*';
      i++; // consume the second *
      if (glob[i + 1] === '/') i++; // consume the optional trailing slash
    } else if (c === '*') {
      // single * matches within one path segment only
      re += '[^/]*';
    } else if (c === '?') {
      // ? matches exactly one character within one path segment
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      // escape regex metacharacters that appear literally in glob patterns
      re += '\\' + c;
    } else {
      re += c;
    }
  }

  return re;
}

/**
 * Fetches the bot's checklist comment body and parses both the visible checkbox state and the
 * hidden JSON state block in a single pass, returning everything reconcile() needs.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {object} context - actions/github-script context
 * @param {object} core - @actions/core from actions/github-script
 * @param {DerivedContext} derivedContext
 * @param {ChecklistConfig} config
 * @returns {Promise<{
 *   checkboxes: Map<string, CheckboxState>,
 *   hiddenState: HiddenState|null,
 * }>}
 */
async function loadCommentState(github, context, core, derivedContext, config) {
  const body = await getChecklistBody(github, context, derivedContext);
  const checkboxes = parseVisibleCheckboxes(body, config.expectedItems);
  const hiddenState = parseHiddenState(body, core);
  return { checkboxes, hiddenState };
}

/**
 * Returns the current body of the bot's checklist comment. Uses the event payload directly
 * when the edited comment is confirmed to be the checklist (avoiding a paginated API call);
 * otherwise searches PR comments for the bot's comment by BOT_LOGIN and COMMENT_MARKER.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {object} context - actions/github-script context
 * @param {DerivedContext} derivedContext
 * @returns {Promise<string>} The checklist comment body, or "" if none exists yet
 */
async function getChecklistBody(github, context, derivedContext) {
  if (derivedContext.isChecklistEdit) {
    return context.payload.comment.body;
  }

  const { owner, repo, pullNumber } = derivedContext;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
  });
  return comments.find(
    (c) => c.user.login === BOT_LOGIN && c.body.startsWith(COMMENT_MARKER)
  )?.body ?? "";
}

// Returns the canonical string key for an item by its id and role.
function itemKey(item) { return `${item.id}:${item.role}`; }

/**
 * Parses the visible checkbox lines in a comment body to extract current item status.
 * Checkboxes are the authoritative source of truth for current status — the hidden JSON block
 * only supplements with metadata (timestamps, attribution) that checkbox state cannot carry.
 *
 * Items are resolved by looking up display text against expectedItems. Section headers set the
 * current role, which disambiguates items whose text appears in both the author and reviewer
 * sections. Lines with no matching expected item are ignored.
 *
 * @param {string} body - Full comment body text
 * @param {Array<ExpectedItem>} expectedItems
 * @returns {Map<string, CheckboxState>} Keyed by itemKey(exp) — i.e. "id:role"
 */
function parseVisibleCheckboxes(body, expectedItems) {
  const textToItem = new Map();
  for (const exp of expectedItems) {
    textToItem.set(`${exp.text}:${exp.role}`, exp);
  }

  const parsed = new Map();
  let currentSection = null;

  for (const line of body.split("\n")) {
    if (line === SECTION_ATTESTATION) { currentSection = "attestation"; continue; }
    if (line === SECTION_AUTHOR)      { currentSection = "author"; continue; }
    if (line === SECTION_REVIEWER)    { currentSection = "reviewer"; continue; }
    if (currentSection === null) continue;

    const parsedLine = parseCheckboxLine(line);
    if (!parsedLine) continue;

    const { itemText, status, reason, conflict } = parsedLine;

    const currentRole = currentSection === "attestation"
      ? ATTESTATIONS.filter(item => item.text === itemText).at(0)?.role
      : currentSection;

    const exp = textToItem.get(`${itemText}:${currentRole}`);
    if (!exp) continue;

    parsed.set(itemKey(exp), { status, reason, conflict });
  }

  return parsed;
}

/**
 * Parses a single markdown checkbox line into its component parts.
 * Returns null when the line does not match the expected checkbox format.
 *
 * The status rules are:
 * - N/A suffix present → "not_applicable" with the trailing reason; checkbox state is irrelevant
 * - Checked, no N/A suffix → "verified"
 * - Unchecked, no N/A suffix → "pending"
 * - Both checked and N/A suffix → "not_applicable", conflict: true
 *
 * @param {string} line
 * @returns {{ itemText: string } & CheckboxState | null}
 */
function parseCheckboxLine(line) {
  const match = line.match(LINE_RE);
  if (!match) return null;

  const [, checked, fullText] = match;
  const isChecked = checked.toLowerCase() === "x";
  const naMatch = fullText.match(NA_RE);

  if (naMatch) {
    return {
      itemText: naMatch[1].trim(),
      reason: naMatch[2].trim(),
      status: "not_applicable",
      conflict: isChecked,
    };
  }

  return {
    itemText: fullText.trim(),
    reason: undefined,
    status: isChecked ? "verified" : "pending",
    conflict: false,
  };
}

/**
 * Parses the hidden JSON state block from a comment body. Used only for supplementary
 * metadata (timestamps, attribution) that checkbox state cannot carry. Parse failures are
 * non-fatal — metadata is re-derived from visible checkboxes on the next render.
 *
 * Returns the parsed snapshot when successful, or null when the block is absent, unparseable,
 * or contained no items.
 *
 * @param {string} body - Full comment body text
 * @param {object} core - @actions/core from actions/github-script
 * @returns {HiddenState|null}
 */
function parseHiddenState(body, core) {
  const match = body.match(STATE_BLOCK_RE);
  if (!match) return null;

  let hiddenState;
  try {
    hiddenState = JSON.parse(match[1]);
  } catch (e) {
    stateBlockFail(core, "State block", `JSON parse error (${e.message})`);
    return null;
  }

  if (typeof hiddenState !== "object" || hiddenState === null) {
    stateBlockFail(core, "State block", "not an object");
    return null;
  }

  if (hiddenState.schema_version !== SCHEMA_VERSION) {
    stateBlockWarn(core, "State block", `schema_version ${hiddenState.schema_version}, expected ${SCHEMA_VERSION}`);
  }

  validateProperties(core, hiddenState, HIDDEN_STATE_FIELDS, "State block", stateBlockWarn);

  if (!validateItemArray(core, hiddenState.items, "Reconciled Items", RECONCILED_ITEM_FIELDS, stateBlockFail)) {
    return null;
  }

  return hiddenState;
}

// Hard failure — signals that the hidden state block is unrecoverable; caller re-derives from visible checkboxes.
function stateBlockFail(core, component, failure) {
  core.info(`${component} invalid: (${failure}) - re-deriving from visible checkboxes`);
}

// Soft failure — logs a warning but allows the caller to continue with a fallback value.
function stateBlockWarn(core, component, warning) {
  core.info(`${component}: ${warning} — continuing anyway`);
}

// Checks each property in fields against obj; calls onInvalid for every mismatch (does not short-circuit).
function validateProperties(core, obj, fields, component, onInvalid) {
  let anyInvalid = false;

  for (const [prop, type] of Object.entries(fields)) {
    if (typeof obj[prop] !== type) {
      onInvalid(core, component, `missing or invalid ${prop}`);
      anyInvalid = true;
    }
  }

  return !anyInvalid;
}

/**
 * Validates each item in an array against a `{ prop: type }` fields map.
 * Calls `onInvalid` on the first failure and returns false; returns true when all items pass.
 *
 * @param {object} core - @actions/core from actions/github-script
 * @param {unknown} array - Value to validate as an array
 * @param {string} arrayName - Label used in log messages (e.g. "Reconciled Items")
 * @param {Record<string, string>} fields - Map of property name → expected typeof string
 * @param {function} onInvalid - Called as onInvalid(core, component, message) on failure
 * @returns {boolean}
 */
function validateItemArray(core, array, arrayName, fields, onInvalid) {
  if (!Array.isArray(array)) {
    onInvalid(core, arrayName, "not an array");
    return false;
  }

  for (const item of array) {
    if (typeof item.id !== "string" || typeof item.role !== "string") {
      onInvalid(core, arrayName, "item missing id or role");
      return false;
    }

    const ref = `${arrayName}[${itemKey(item)}]`;

    if (!validateProperties(core, item, fields, ref, onInvalid)) {
      return false;
    }
  }

  return true;
}

/**
 * Reconciles the expected item set with parsed checkbox state and prior JSON state,
 * producing the canonical item list for this render cycle.
 *
 * For each expected item:
 * - If found in parsed checkboxes (matched by display text): carries forward status and reason.
 *   Actor and timestamp are preserved from prior state when status and reason are unchanged,
 *   or updated to senderLogin and now when they differ.
 * - If not found: renders as Pending (covers both brand-new items and items not yet visible
 *   in the comment — both are treated identically as "needs attention").
 *
 * Items no longer in the expected set are logged via core.info and not persisted to the snapshot.
 *
 * @param {object} core - @actions/core from actions/github-script
 * @param {ChecklistConfig} config
 * @param {Map<string, CheckboxState>} checkboxes - Current checkbox state keyed by itemKey
 * @param {HiddenState|null} hiddenState - Parsed prior snapshot, or null on first render / unusable state
 * @param {DerivedContext} derivedContext
 * @returns {Array<ReconciledItem>}
 */
function reconcile(core, config, checkboxes, hiddenState, derivedContext) {
  const { senderLogin, now } = derivedContext;

  // If hiddenState is null, validation of the hidden state block failed, and we should
  // start over without any prior data
  const prior = new Map();
  for (const item of hiddenState?.items ?? []) {
    prior.set(itemKey(item), item);
  }

  const seenKeys = new Set();

  const items = config.expectedItems.map((exp) => {
    const key = itemKey(exp);
    seenKeys.add(key);
    return reconcileItem(exp, checkboxes.get(key), prior.get(key), senderLogin, now);
  });

  for (const [key, prev] of prior.entries()) {
    if (!seenKeys.has(key)) {
      core.info(`Item removed from expected set: ${key} (was ${prev.status})`);
    }
  }

  return items;
}

/**
 * Merges a single expected item with its current parsed state and prior JSON state.
 *
 * @param {ExpectedItem} exp - Expected item definition
 * @param {CheckboxState|undefined} parsed - Entry from checkboxes, or undefined if not present in comment
 * @param {ReconciledItem|undefined} prev - Entry from previousItems, or undefined if new
 * @param {string} senderLogin - GitHub login of the user who triggered this event
 * @param {string} now - ISO 8601 timestamp for this render cycle
 * @returns {ReconciledItem}
 */
function reconcileItem(exp, parsed, prev, senderLogin, now) {
  let status, reason, conflict, actor, firstSeenAt, updatedAt;

  if (parsed) {
    status = parsed.status;
    reason = parsed.reason;
    conflict = parsed.conflict;

    if (prev) {
      firstSeenAt = prev.first_seen_at;

      if (prev.status === status && prev.reason === reason) {
        // Preserve actor and timestamp when status+reason are unchanged — the event
        // sender didn't change this item, so they shouldn't be credited for it.
        actor = prev.actor;
        updatedAt = prev.updated_at;
      }
    }
  } else {
    // Start the check over at a pending status (unchecked)
    status = "pending";
    reason = undefined;
    conflict = false;
  }

  actor = actor ?? senderLogin;
  updatedAt = updatedAt ?? now;
  firstSeenAt = firstSeenAt ?? now;

  return {
    id: exp.id,
    role: exp.role,
    text: exp.text,
    area: exp.area,
    blocking: exp.blocking,
    status,
    reason,
    conflict,
    actor,
    first_seen_at: firstSeenAt,
    updated_at: updatedAt,
  };
}

/**
 * Determines whether all attestation items are resolved (Verified or Not Applicable).
 * Throws if no attestation items are found — a missing attestation is a misconfiguration,
 * not a case where the gate should silently pass (Array.every([]) === true).
 *
 * @param {Array<ReconciledItem>} items - Reconciled item list
 * @returns {boolean} True if all attestation items are Verified or Not Applicable
 * @throws {Error} If no attestation items are found in the item list
 */
function computeAttestationResolved(items) {
  const attestationItems = items.filter((i) => i.blocking);

  if (attestationItems.length === 0) {
    throw new Error(
      "No attestation items found — the hardcoded ATTESTATIONS constant may have been removed."
    );
  }

  return attestationItems.every(
    (i) => i.status === "verified" || i.status === "not_applicable"
  );
}

/**
 * Renders the full comment body: marker sentinel, legend, the "Verification Attestation"
 * section, the informational Author and Reviewer checklists, an optional reviewer note,
 * and a hidden JSON state block the bot re-reads on future renders.
 *
 * @param {ChecklistConfig} config
 * @param {Array<ReconciledItem>} items - Reconciled item list from reconcile()
 * @param {HiddenState|null} hiddenState - Prior snapshot; used to preserve the original first-posted timestamp
 * @param {DerivedContext} derivedContext
 * @returns {string} Full markdown comment body
 */
function renderComment(config, items, hiddenState, derivedContext) {
  const lines = [
    COMMENT_MARKER,
    config.legend,
    "",
    SECTION_ATTESTATION,
    ...items.filter((i) => i.blocking).map(renderLine),
    "",
    SECTION_AUTHOR,
    ...items.filter((i) => !i.blocking && i.role === "author").map(renderLine),
    "",
    SECTION_REVIEWER,
    ...items.filter((i) => !i.blocking && i.role === "reviewer").map(renderLine),
    "",
  ];

  if (config.reviewer_note) {
    lines.push(config.reviewer_note, "");
  }

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    config_sha: config.sha,
    pr_number: derivedContext.pullNumber,
    checklist_first_posted_at: hiddenState?.checklist_first_posted_at ?? derivedContext.now,
    pr_author: derivedContext.prAuthor,
    override_applied: derivedContext.overrideApplied,
    generated_at: derivedContext.now,
    items,
  };
  lines.push(`<!-- checklist-state:v${SCHEMA_VERSION}\n${JSON.stringify(snapshot, null, 2)}\n-->`);

  return lines.join("\n");
}

/**
 * Renders a single checklist item as a GitHub markdown task-list line.
 *
 * @param {{ text: string, status: string, reason: string|null }} item
 * @returns {string} A task-list line, e.g. `- [x] Tests added for the change`
 */
function renderLine(item) {
  let checked = " ";
  let text = item.text;

  if (item.status === "verified") {
    checked = "x";
  } else if (item.status === "not_applicable") {
    text = `${text} — N/A: ${item.reason ?? ""}`;
  }

  return `- [${checked}] ${text}`;
}
