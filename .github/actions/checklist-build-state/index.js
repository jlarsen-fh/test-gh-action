"use strict";

const yaml = require("js-yaml");

const { BOT_LOGIN, COMMENT_MARKER } = require("./constants");

const CONFIG_PATH = ".github/checklist_config.yaml";

// PR merge-title types (Conventional Commit) that are exempt from the checklist entirely: trivial or
// non-code changes with nothing to verify. The whole comment is skipped for these.
const EXEMPT_TYPES = new Set(["revert", "docs", "ci", "chore", "test"]);

// Placeholder attributor for a checked item we stamp outside a comment edit, i.e. one that was
// already checked before we could record who did it (not a real person this run).
const UNKNOWN_ACTOR = "unknown";

// The checklist's sections, in render order. Each pairs an internal id with the markdown header
// used both to render the section and to detect it when parsing an existing comment.
const SECTIONS = [
  { id: "attestation", header: "## Verification Attestation" },
  { id: "author", header: "## Author checklist" },
  { id: "reviewer", header: "## Reviewer checklist" },
];

// Matches a rendered checklist line. A single status marker leads the text and changes with state:
// bold "**(BLOCKING)**" while a required item is unchecked, "(actor, M/D/YY)" once it is checked.
// Captures:
//   group 1: checkbox character (" ", "x", or "X")
//   group 2: stamp actor (only for the checked "(actor, date)" form)
//   group 3: stamp date  (only for the checked "(actor, date)" form)
//   group 4: item text (without the leading marker)
// Because the marker leads the text, parens later in the text (e.g. the markdown-link "PR title
// matches ..." item) are never at risk of being mistaken for it.
const LINE_RE =
  /^- \[([ xX])\] (?:(?:\*\*\(BLOCKING\)\*\*|\(([^(),]+), (\d{1,2}\/\d{1,2}\/\d{2})\)) )?(.+?)\s*$/;

/**
 * @typedef {{ section: "attestation"|"author"|"reviewer", text: string, blocking: boolean }} ExpectedItem
 * @typedef {{ actor: string, date: string }} Stamp
 * @typedef {ExpectedItem & { checked: boolean, stamp: Stamp|null }} RenderItem
 * @typedef {{ id: string, text: string, roles?: Array<string>, blocking?: boolean }} ConfigItem
 * @typedef {{ id: string, items?: Array<ConfigItem>, when?: { paths: Array<string> } }} ConfigArea
 * @typedef {{
 *   reviewer_note?: string,
 *   attestation: { items: Array<{ id: string, text: string, blocking?: boolean }> },
 *   areas?: Array<ConfigArea>,
 * }} ChecklistConfig
 * @typedef {{
 *   prNumber: number, headSha: string, baseRef: string, title: string, isDraft: boolean,
 *   isCommentEvent: boolean, isChecklistEdit: boolean, isBotSelfEdit: boolean,
 *   actor: string, today: string,
 * }} DerivedContext
 */

/**
 * Main entry point. Computes checklist state for the current PR and emits the step outputs the
 * workflow uses to post the sticky comment, the jump-link, and the "PR Checklist" commit status:
 *   - head-sha                the PR head commit the status must be posted against
 *   - is-draft                'true' while the PR is a draft (the gate passes)
 *   - exempt                  'true' for exempt PR types (revert/docs/ci/chore/test); no checklist
 *   - required-items-checked  'true' when every blocking item is checked
 *   - skip-render             'true' if the comment should not be re-rendered this run
 *   - comment-body            the rendered comment (set only when skip-render is 'false')
 *
 * Runs on both pull_request and issue_comment(edited) events: ticking a checkbox edits the bot's
 * comment, which re-runs this to re-evaluate the gate. Our own edits (isBotSelfEdit) are skipped to
 * avoid a render loop. Checked state is read live from the comment, so it is the sole source of truth.
 *
 * @param {{ github: object, context: object, core: object }} param0
 */
module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const derived = await deriveContext(github, context);

  core.setOutput("head-sha", derived.headSha);
  core.setOutput("is-draft", String(derived.isDraft));

  // Exempt PR types get no checklist; the gate auto-passes (the workflow reads exempt + head-sha).
  if (EXEMPT_TYPES.has(prType(derived.title))) {
    core.setOutput("exempt", "true");
    core.setOutput("skip-render", "true");
    core.setOutput("required-items-checked", "false");
    return;
  }
  core.setOutput("exempt", "false");

  const config = await fetchChecklistConfig(github, owner, repo, derived.baseRef);
  const activeAreas = await resolveActiveAreas(
    github,
    owner,
    repo,
    derived.prNumber,
    config,
  );
  const expected = buildExpectedItems(config, activeAreas);

  const priorBody = await getChecklistBody(github, owner, repo, derived.prNumber);
  const checked = parseExistingCheckboxes(priorBody);

  core.setOutput(
    "required-items-checked",
    String(allRequiredItemsChecked(expected, checked)),
  );

  // Re-render unless this run is our own edit (loop guard) or an edit to some other comment.
  const render =
    !derived.isBotSelfEdit &&
    !(derived.isCommentEvent && !derived.isChecklistEdit);

  core.setOutput("skip-render", String(!render));
  if (render) {
    core.setOutput("comment-body", renderComment(config, expected, checked, derived));
  }
};

/**
 * Extracts the Conventional-Commit type from a PR/merge title, e.g. "feat(scope)!: ..." -> "feat".
 * Returns "" when the title does not start with a recognizable type.
 *
 * @param {string} title - The PR title
 * @returns {string} The lowercased type, or ""
 */
function prType(title) {
  const match = /^(\w+)(?:\([^)]*\))?!?:/.exec(title || "");
  return match ? match[1].toLowerCase() : "";
}

/**
 * Resolves the facts the rest of the run needs from either event type. For issue_comment events the
 * PR is not in the payload, so it is fetched; `isChecklistEdit` distinguishes an edit to the bot's
 * checklist comment (worth re-rendering) from any other comment, and `isBotSelfEdit` flags our own
 * edit so we can skip and avoid a render loop.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {object} context - actions/github-script context
 * @returns {Promise<DerivedContext>}
 */
async function deriveContext(github, context) {
  const { owner, repo } = context.repo;
  const isCommentEvent = context.eventName === "issue_comment";

  const pr = isCommentEvent
    ? (
        await github.rest.pulls.get({
          owner,
          repo,
          pull_number: context.payload.issue.number,
        })
      ).data
    : context.payload.pull_request;

  const isChecklistEdit =
    isCommentEvent &&
    context.payload.comment.user.login === BOT_LOGIN &&
    context.payload.comment.body.startsWith(COMMENT_MARKER);

  // Who to attribute a newly-checked item to. A box is only ticked via a comment edit, so on any
  // other event nobody ticked anything this run; an unstamped checked item seen then is pre-existing,
  // so attribute it to UNKNOWN_ACTOR rather than mislabel the pusher.
  const actor = isCommentEvent
    ? context.payload.sender?.login ?? UNKNOWN_ACTOR
    : UNKNOWN_ACTOR;

  return {
    prNumber: pr.number,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    title: pr.title,
    isDraft: pr.draft,
    isCommentEvent,
    isChecklistEdit,
    isBotSelfEdit: context.payload.sender?.login === BOT_LOGIN,
    actor,
    today: todayCentral(),
  };
}

/**
 * Today's date as M/D/YY in US Central time (Findhelp's standard timezone), used to stamp when an
 * item was checked. The short en-US numeric format keeps the inline stamp compact, and the IANA zone
 * handles DST.
 *
 * @returns {string}
 */
function todayCentral() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  }).format(new Date());
}

/**
 * Fetches and parses checklist_config.yaml from the PR's base (target) branch. Reading from the
 * target rather than the PR's own branch means every open PR is evaluated against one canonical
 * checklist, and a config change reaches all in-flight PRs as soon as it merges — no rebase needed.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {string} owner - Repository owner (org or user login)
 * @param {string} repo - Repository name
 * @param {string} baseBranch - The PR's base ref (context.payload.pull_request.base.ref)
 * @returns {Promise<ChecklistConfig>}
 */
async function fetchChecklistConfig(github, owner, repo, baseBranch) {
  const { data: configFile } = await github.rest.repos.getContent({
    owner,
    repo,
    path: CONFIG_PATH,
    ref: baseBranch,
  });

  return yaml.load(
    Buffer.from(configFile.content, "base64").toString("utf8"),
  );
}

/**
 * Returns the areas that apply to this PR: every unconditional area, plus each conditional area
 * (`when.paths`) whose glob patterns match at least one changed file. When no area is conditional,
 * all areas are returned without an API call.
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {string} owner - Repository owner (org or user login)
 * @param {string} repo - Repository name
 * @param {number} pullNumber - The pull request number
 * @param {ChecklistConfig} config - Parsed checklist_config.yaml
 * @returns {Promise<Array<ConfigArea>>}
 */
async function resolveActiveAreas(github, owner, repo, pullNumber, config) {
  const areas = config.areas || [];
  const conditional = areas.filter((a) => a.when?.paths);
  if (conditional.length === 0) return areas;

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const filenames = files.map((f) => f.filename);

  const matchedIds = new Set();
  for (const area of conditional) {
    const regex = new RegExp(
      `^(?:${area.when.paths.map(globToRegex).join("|")})$`,
    );
    if (filenames.some((name) => regex.test(name))) matchedIds.add(area.id);
  }

  return areas.filter((a) => !a.when || matchedIds.has(a.id));
}

/**
 * Compiles a glob pattern into an unanchored regex source, ready to embed in a larger pattern.
 * Supported wildcards:
 *   *  — any characters except a path separator
 *   ** — any characters including path separators (a following / is consumed)
 *   ?  — exactly one character except a path separator
 *
 * @param {string} glob - A single glob pattern from an area's when.paths
 * @returns {string}
 */
function globToRegex(glob) {
  let re = "";

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === "*" && glob[i + 1] === "*") {
      // ** matches across directory separators
      re += ".*";
      i++; // consume the second *
      if (glob[i + 1] === "/") i++; // consume the optional trailing slash
    } else if (c === "*") {
      // single * matches within one path segment only
      re += "[^/]*";
    } else if (c === "?") {
      // ? matches exactly one character within one path segment
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      // escape regex metacharacters that appear literally in glob patterns
      re += "\\" + c;
    } else {
      re += c;
    }
  }

  return re;
}

/**
 * Flattens the config into the ordered list of checklist items to render: the attestation items
 * first (their own section), then active-area items expanded into one entry per (item, role).
 *
 * @param {ChecklistConfig} config - Parsed checklist_config.yaml
 * @param {Array<ConfigArea>} activeAreas - Areas resolved as applicable to this PR, from resolveActiveAreas
 * @returns {Array<ExpectedItem>}
 */
function buildExpectedItems(config, activeAreas) {
  const items = [];

  for (const item of config.attestation?.items || []) {
    items.push({ section: "attestation", text: item.text, blocking: Boolean(item.blocking) });
  }

  for (const area of activeAreas) {
    for (const item of area.items || []) {
      for (const role of item.roles || []) {
        items.push({ section: role, text: item.text, blocking: Boolean(item.blocking) });
      }
    }
  }

  return items;
}

/**
 * The gate is satisfied when every blocking item is checked; non-blocking items don't affect it.
 * With no blocking items this is vacuously true (nothing to gate).
 *
 * @param {Array<ExpectedItem>} expected - Flattened expected items (carry the blocking flag)
 * @param {Map<string, Stamp|null>} checked - Keyed (see itemKey) by checked item; value is its stamp
 * @returns {boolean}
 */
function allRequiredItemsChecked(expected, checked) {
  return expected
    .filter((item) => item.blocking)
    .every((item) => checked.has(itemKey(item)));
}

/**
 * Returns the current body of the bot's checklist comment, or "" if none exists yet. The comment
 * is identified by author (BOT_LOGIN) and the leading COMMENT_MARKER sentinel.
 *
 * The comment is read live here rather than from the triggering event payload, which is what lets a
 * run that has been superseded by a newer commit be cancelled without losing checkbox state (see the
 * concurrency group in pr_checklist.yaml).
 *
 * @param {object} github - Octokit instance from actions/github-script
 * @param {string} owner - Repository owner (org or user login)
 * @param {string} repo - Repository name
 * @param {number} pullNumber - The pull request number
 * @returns {Promise<string>}
 */
async function getChecklistBody(github, owner, repo, pullNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
  });

  return (
    comments.find(
      (c) => c.user.login === BOT_LOGIN && c.body.startsWith(COMMENT_MARKER),
    )?.body ?? ""
  );
}

/**
 * Scans an existing comment body and returns a map of checked item keys to their stamp (the
 * attribution carried inline, or null if the box was checked but not yet stamped). Section headers
 * set the current section, which is part of an item's key — so an item's state is scoped to the
 * section it appears in (the same attestation text can carry a different state than an area item
 * that happens to share text). This is the sole source of truth for checked state; there is no
 * hidden state block.
 *
 * @param {string} body - Existing comment body, or "" on first render
 * @returns {Map<string, Stamp|null>} Keyed (see itemKey) by checked item; value is its parsed stamp
 */
function parseExistingCheckboxes(body) {
  const headerToSection = new Map(SECTIONS.map((s) => [s.header, s.id]));

  const checked = new Map();
  let section = null;

  for (const line of body.split(/\r?\n/)) {
    if (headerToSection.has(line)) {
      section = headerToSection.get(line);
      continue;
    }
    if (section === null) continue;

    const parsed = parseCheckboxLine(line);
    if (parsed?.checked) {
      checked.set(itemKey({ section, text: parsed.text }), parsed.stamp);
    }
  }

  return checked;
}

/**
 * Parses a single markdown checkbox line. LINE_RE splits the base text from any trailing stamp in one
 * pass, so the text matches the config and the stamp (if the "(actor, date)" form) comes back too.
 * Returns null when the line is not a checkbox.
 *
 * @param {string} line - One line from the comment body
 * @returns {{ checked: boolean, text: string, stamp: Stamp|null } | null}
 */
function parseCheckboxLine(line) {
  const match = line.match(LINE_RE);
  if (!match) return null;

  const [, box, actor, date, text] = match;
  return {
    checked: box.toLowerCase() === "x",
    text: text.trim(),
    stamp: actor ? { actor, date } : null,
  };
}

/**
 * Canonical key for an item: its section plus display text. Checked state is carried across renders
 * by this key, so it must be derivable identically from both config items and parsed comment lines —
 * section disambiguates items that share the same text across sections.
 *
 * @param {{ section: string, text: string }} item - Any item carrying a section and display text
 * @returns {string} Key of the form `${section}:${text}`
 */
function itemKey(item) {
  return `${item.section}:${item.text}`;
}

/**
 * Renders the full comment body: the marker sentinel, the attestation section, the Author and
 * Reviewer checklists, and an optional reviewer note. Merges each expected item with its checked
 * state and inline stamp (looked up by itemKey) so a re-render preserves ticked boxes and their
 * attribution. A newly-checked item (checked with no prior stamp) is stamped with derived.actor and
 * derived.today; an existing stamp is preserved so it does not drift. Pre-existing checks seen outside
 * a comment edit are attributed to UNKNOWN_ACTOR (see deriveContext), never a real person.
 *
 * @param {ChecklistConfig} config - Parsed checklist_config.yaml
 * @param {Array<ExpectedItem>} expected - Flattened items to render, in section/render order
 * @param {Map<string, Stamp|null>} checked - Keyed (see itemKey) by checked item; value is its stamp
 * @param {DerivedContext} derived - Supplies actor + today for stamping newly-checked items
 * @returns {string}
 */
function renderComment(config, expected, checked, derived) {
  // Merge each expected item with its checked state and stamp (preserve an existing stamp; stamp a
  // newly-checked item with the run's actor and date).
  const items = expected.map((item) => {
    const key = itemKey(item);
    const isChecked = checked.has(key);
    return {
      ...item,
      checked: isChecked,
      stamp: isChecked
        ? checked.get(key) || { actor: derived.actor, date: derived.today }
        : null,
    };
  });

  // Start the new comment body with COMMENT_MARKER.
  const lines = [COMMENT_MARKER];

  // For each section, print its header then its corresponding items.
  SECTIONS.forEach(({ id, header }, index) => {
    if (index > 0) lines.push(""); // Blank line separating sections.

    const rendered = items.filter((i) => i.section === id).map(renderLine);

    lines.push(header, ...rendered);
  });

  // End the comment body with the reviewer note.
  if (config.reviewer_note) lines.push("", config.reviewer_note);

  return lines.join("\n");
}

/**
 * Renders a single item as a markdown task-list line. A single status marker leads the text and
 * changes with state: bold `**(BLOCKING)**` while a required item is unchecked, then the plain
 * attribution stamp `(actor, M/D/YY)` once it is checked. LINE_RE strips whichever is present on
 * re-parse.
 *
 * @param {RenderItem} item - A single item with its section, text, checked flag, and stamp
 * @returns {string}
 */
function renderLine(item) {
  const box = item.checked ? "x" : " ";

  // The leading marker is one slot that changes with state: a checked item shows its stamp (set in
  // renderComment); an unchecked required item shows (BLOCKING). The two never co-occur.
  if (item.checked) {
    return `- [${box}] (${item.stamp.actor}, ${item.stamp.date}) ${item.text}`;
  }
  if (item.blocking) {
    return `- [${box}] **(BLOCKING)** ${item.text}`;
  }
  return `- [${box}] ${item.text}`;
}

/**
 * One-time sweep, invoked via workflow_dispatch, that posts the "PR Checklist" status on every open PR.
 * GitHub treats a required check that has never reported as failing, so before the status is added to
 * branch protection every open PR needs at least one report. Reuses the same gate computation as a
 * normal run and does not touch comments (open PRs already have one, or get one on their next event).
 *
 * @param {{ github: object, context: object, core: object }} param0
 */
module.exports.backfill = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const prs = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
  });

  for (const pr of prs) {
    const exempt = EXEMPT_TYPES.has(prType(pr.title));

    let requiredItemsChecked = false;
    if (!exempt && !pr.draft) {
      const config = await fetchChecklistConfig(github, owner, repo, pr.base.ref);
      const activeAreas = await resolveActiveAreas(github, owner, repo, pr.number, config);
      const expected = buildExpectedItems(config, activeAreas);
      const checked = parseExistingCheckboxes(
        await getChecklistBody(github, owner, repo, pr.number),
      );
      requiredItemsChecked = allRequiredItemsChecked(expected, checked);
    }

    const pass = pr.draft || exempt || requiredItemsChecked;
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state: pass ? "success" : "failure",
      description: pass
        ? "Backfilled."
        : "Required checklist items still unchecked.",
      context: "PR Checklist",
    });
    core.info(`PR #${pr.number}: ${pass ? "success" : "failure"}`);
  }

  core.info(`Backfilled ${prs.length} open PR(s).`);
};
