"use strict";

const yaml = require("js-yaml");

const CONFIG_PATH = ".github/checklist_config.yaml";
const BOT_LOGIN = "github-actions[bot]";
const COMMENT_MARKER = "<!-- checklist-bot -->";

// The checklist's sections, in render order. Each pairs an internal id with the markdown header
// used both to render the section and to detect it when parsing an existing comment.
const SECTIONS = [
  { id: "attestation", header: "## Verification Attestation" },
  { id: "author", header: "## Author checklist" },
  { id: "reviewer", header: "## Reviewer checklist" },
];

// Matches a rendered checklist line. Group 1: the checkbox character (" ", "x", or "X").
// Group 2: the item text.
const LINE_RE = /^- \[([ xX])\] (.+?)\s*$/;

/**
 * @typedef {{ section: "attestation"|"author"|"reviewer", text: string }} ExpectedItem
 * @typedef {ExpectedItem & { checked: boolean }} RenderItem
 * @typedef {{ id: string, text: string, roles?: Array<string> }} ConfigItem
 * @typedef {{ id: string, items?: Array<ConfigItem>, when?: { paths: Array<string> } }} ConfigArea
 * @typedef {{
 *   reviewer_note?: string,
 *   attestation: { items: Array<{ id: string, text: string }> },
 *   areas?: Array<ConfigArea>,
 * }} ChecklistConfig
 */

/**
 * Main entry point. Renders the checklist comment body for the current PR, preserving any boxes
 * already checked in the existing bot comment, and emits it as the `comment-body` step output.
 *
 * The checklist is informational only — nothing here gates the PR. Checked state survives
 * re-renders because the visible checkboxes in the existing comment are the sole source of truth.
 *
 * @param {{ github: object, context: object, core: object }} param0
 */
module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;

  const config = await fetchChecklistConfig(github, owner, repo, pr.base.ref);
  const activeAreas = await resolveActiveAreas(
    github,
    owner,
    repo,
    pr.number,
    config,
  );
  const expected = buildExpectedItems(config, activeAreas);

  const priorBody = await getChecklistBody(github, owner, repo, pr.number);
  const checked = parseExistingCheckboxes(priorBody);

  // AI-ASSISTANT-TEMP: diagnostics for checkbox-preservation issue — remove once resolved.
  {
    const all = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
    });
    core.info(`[checklist-debug] event=${context.eventName} total comments=${all.length}`);
    for (const c of all) {
      core.info(
        `[checklist-debug] comment id=${c.id} author=${c.user.login} isBot=${c.user.login === BOT_LOGIN} startsWithMarker=${c.body.startsWith(COMMENT_MARKER)} includesMarker=${c.body.includes(COMMENT_MARKER)} len=${c.body.length}`,
      );
    }
    core.info(`[checklist-debug] matched priorBody len=${priorBody.length}`);
    core.info(`[checklist-debug] priorBody(JSON)=${JSON.stringify(priorBody)}`);
    core.info(`[checklist-debug] checkedKeys=${JSON.stringify([...checked])}`);
    core.info(`[checklist-debug] expectedKeys=${JSON.stringify(expected.map(itemKey))}`);
  }

  core.setOutput("comment-body", renderComment(config, expected, checked));
};

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
    items.push({ section: "attestation", text: item.text });
  }

  for (const area of activeAreas) {
    for (const item of area.items || []) {
      for (const role of item.roles || []) {
        items.push({ section: role, text: item.text });
      }
    }
  }

  return items;
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
 * Scans an existing comment body and returns the set of item keys whose checkbox is checked.
 * Section headers set the current section, which is part of an item's key — so an item's checked
 * state is scoped to the section it appears in (the same attestation text can carry a different
 * state than an area item that happens to share text).
 *
 * @param {string} body - Existing comment body, or "" on first render
 * @returns {Set<string>} Keys (see itemKey) of checked items
 */
function parseExistingCheckboxes(body) {
  const headerToSection = new Map(SECTIONS.map((s) => [s.header, s.id]));

  const checked = new Set();
  let section = null;

  for (const line of body.split(/\r?\n/)) {
    if (headerToSection.has(line)) {
      section = headerToSection.get(line);
      continue;
    }
    if (section === null) continue;

    const parsed = parseCheckboxLine(line);
    if (parsed?.checked) checked.add(itemKey({ section, text: parsed.text }));
  }

  return checked;
}

/**
 * Parses a single markdown checkbox line. Returns null when the line is not a checkbox.
 *
 * @param {string} line - One line from the comment body
 * @returns {{ checked: boolean, text: string } | null}
 */
function parseCheckboxLine(line) {
  const match = line.match(LINE_RE);
  if (!match) return null;

  return { checked: match[1].toLowerCase() === "x", text: match[2].trim() };
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
 * state (looked up by itemKey) so a re-render preserves boxes already ticked.
 *
 * @param {ChecklistConfig} config - Parsed checklist_config.yaml
 * @param {Array<ExpectedItem>} expected - Flattened items to render, in section/render order
 * @param {Set<string>} checked - Keys (see itemKey) of items whose box should be rendered checked
 * @returns {string}
 */
function renderComment(config, expected, checked) {
  // For each expected item, track whether it should be checked
  const items = expected.map((item) => ({
    ...item,
    checked: checked.has(itemKey(item)),
  }));

  // Start the new comment body with COMMENT_MARKER
  const lines = [COMMENT_MARKER];

  // For each section, print its header than it's corresponding items
  SECTIONS.forEach(({ id, header }, index) => {
    if (index > 0) lines.push(""); // Blank line separating sections

    const rendered = items.filter((i) => i.section === id).map(renderLine);

    lines.push(header, ...rendered);
  });

  // End the comment body with the reviewer note
  if (config.reviewer_note) lines.push("", config.reviewer_note);

  return lines.join("\n");
}

/**
 * Renders a single item as a markdown task-list line, e.g. `- [x] Tests added for the change`.
 *
 * @param {RenderItem} item - A single item with its section, text, and checked flag
 * @returns {string}
 */
function renderLine(item) {
  return `- [${item.checked ? "x" : " "}] ${item.text}`;
}
