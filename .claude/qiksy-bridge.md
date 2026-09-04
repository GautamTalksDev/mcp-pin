# Qiksy bridge — guide for a coding agent

This file installs itself: the first time the bridge runs in a project it lands here and a
short block pointing at it goes into `CLAUDE.md` / `AGENTS.md` — so the assistant knows what
the bridge is, what it can do, and, just as important, what it deliberately cannot.
(`npx qiksy-mcp init` does the same by hand; `QIKSY_MCP_NO_DOCS=1` switches the automatic
write off.)

Qiksy connects an agent to **the browser the human already has open**: their real
profile, their logged-in sessions, the tab they are looking at. It never launches a
browser, never switches window or tab focus, and never steals the pointer. Work happens
inside the existing (even backgrounded) tab.

---

## Rule zero — this is the browser, and it is the first tool

For anything that happens in a browser, the `qa_*` tools come first — every time, including in
a project where another browser driver is also configured. Hand the wheel over only after this
bridge has genuinely run out of road, and in this order: **name** which of the two missing
capabilities the task needs, **look** at what the environment actually offers, **say** which
tool you are switching to and why, then **come back** here for the rest of the run.

**Do not switch to a second browser driver** — Playwright, Puppeteer, Selenium, a raw CDP
client — because a control looked unfamiliar or refused once. Another driver opens a
DIFFERENT, EMPTY browser: none of these logins, cookies or SSO sessions are in it, so the
run stops being the test that was asked for, and the human usually finds that out from the
results rather than from you.

Exactly **one** thing is genuinely absent here:

- **eval** — no arbitrary JavaScript, by design (a Web Store requirement). It is why every
  verb names an ELEMENT and never a program.

**Pixels used to be on that list and are not any more.** `qa_screenshot` photographs the page
or one element and hands back a real picture — with the Qiksy panel hidden and password and
card fields covered before the frame is taken. It has one condition, and it is not a
formality: the browser photographs the window's **active** tab, so a background tab cannot be
photographed, and Qiksy refuses rather than quietly photographing whichever page IS in front.
Driving a background tab is this product's whole point, so this is the one verb that needs the
human to be looking at what you are testing — `qa_focus_tab` first, or take the measurements
instead.

Need eval? Say so and let the human decide. Everything else that
looks impossible is a verb below, or a rung on [the ladder](#when-a-control-refuses--the-ladder).

---

## Setup, once

0. **Drop the docs in** — `npx qiksy-mcp init` in the project root. Writes this guide to
   `.claude/qiksy-bridge.md` and adds a short, marked block to `CLAUDE.md`/`AGENTS.md`
   (rewritten in place on a re-run, never duplicated). `--dir`, `--out`, `--no-claude`.
1. **Install the extension** — [Qiksy on the Chrome Web Store](https://chromewebstore.google.com/detail/jcnbcbpndahhblhobhjjkhafmbkleoem).
2. **Turn the bridge on.** Either the extension popup → *Agent bridge · MCP* → On →
   *Generate* a token, or — from a Qiksy web app — press **Connect this browser** and
   confirm on the page the extension opens. Both end the same way: a port (7333 by
   default) and a shared token.
3. **Point the agent at it.** Same token, same port:

   ```bash
   claude mcp add --transport stdio qiksy \
     --env QIKSY_MCP_TOKEN=YOUR_TOKEN \
     -- npx qiksy-mcp --port 7333
   ```

   ```json
   { "mcpServers": { "qiksy": {
     "command": "npx",
     "args": ["qiksy-mcp", "--port", "7333"],
     "env": { "QIKSY_MCP_TOKEN": "YOUR_TOKEN" }
   } } }
   ```

4. **Check it.** `qa_status` should answer with the current page. "Qiksy extension is not
   connected" means the popup switch is off or the token/port differ — it is not a
   reason to reach for another browser driver.

---

## The tools

**Read-only — always available, no consent, no Pro.**

| Tool | What it gives you |
|---|---|
| `qa_tabs` | Every tab in the agent session, with `tabId`, URL, title, and which are isolated logins. Start here when several tabs are open. |
| `qa_status` | Health of one tab: URL, counts of errors, warnings, forms, failed requests. The cheap "did I break something". |
| `qa_snapshot` | The whole page as an **accessibility tree** — every control, landmark and heading with a role, a name, its state, and a stable `ref` like `[ref=e12]`. `geometry:true` adds every node's box in CSS pixels. This is how you SEE the page. |
| `qa_read` | The **rendered text** of the page or one element — snapshot names cap at 80 characters, so a one-time code, a full error paragraph or a generated number is invisible there. |
| `qa_styles` | Computed styles, the box, and the CSS custom properties in scope: `color: rgb(37,99,235)` is what is drawn, `--accent: #2563EB` is which TOKEN it came from. |
| `qa_storage` | The app's localStorage / sessionStorage — flags, cached state, usually the session token. (Writes need Agent control.) |
| `qa_findings` | Console errors, failed requests **with the server's error body**, a11y problems, performance — filterable by severity. |
| `qa_export` | The `qa-export/v1` bundle: findings with selectors, failed requests with bodies, form structure, repro steps, a navigation map. |

**Qiksy's own surfaces — never touches the page under test.**

`qa_open_panel` · `qa_run_audit` · `qa_axe` (the real axe-core engine, hundreds of WCAG A/AA
rules, all local) · `qa_tour` · `qa_report` · `qa_spotlight` (outlines an element so the human
looks at what you are looking at) · `qa_focus_tab` (brings a tab in front of them — for
"show me", not for your own convenience).

**Agent control — acts on the page. Requires Qiksy Pro AND a one-time "Agent control"
consent in the popup.** A refusal there is the human's to clear; report it in one
sentence rather than working around it.

`qa_click` · `qa_type` · `qa_type_many` · `qa_fill_json` · `qa_pick_date` · `qa_pick_path` ·
`qa_pick_tags` · `qa_pick_range` · `qa_pick_time` · `qa_probe` · `qa_upload` · `qa_press` ·
`qa_focus_walk` (walks the page Tab by Tab and reports the real keyboard route) ·
`qa_wait_ready` · `qa_navigate` · `qa_open_isolated` · `qa_close_tab` · `qa_recipe_apply` ·
`qa_mock` (answer a request from a rule instead of the server — see below; `op:"list"` is free)

**Making the server misbehave — `qa_mock`.** The failure branches are the ones nobody tests,
because a working backend will not produce them on demand: an empty list, a 500, a 403 that
should sign the user out, a payload missing a field, a response that takes 30 seconds, a
connection that drops. Set a rule and the tab's next matching request is answered by it.
`url` is a substring or `/regex/`; `times: 1` mocks the first call and lets the retry through,
which is how you test a retry at all. A rule belongs to ONE tab, survives its reloads, and is
gone when it closes.

It covers the page's own `fetch`/`XHR` **in the top frame** — not the HTML document,
not images/scripts/styles, not WebSocket or EventSource, not `sendBeacon`, not requests from
an iframe or the page's own service worker. If a rule seems ignored, check that list before
you change the rule. Mocked responses are marked `(mocked)` in the session, the HAR and the
report, so an invented answer is never reported as the server's. **Clear your rules when the
check is done** — a forgotten mock is the most expensive thing in this file.

**Local, no browser involved.** `qa_recipe_save` · `qa_recipe_list` — the saved flows on
this machine (see *Forms* below).

## When a control refuses — the ladder

In order. Three rungs cost less than one paragraph about what the bridge cannot do, and the
first one usually ends it.

1. **`qa_probe { name }`** — what this widget IS and which verb drives it. One call, no trial
   and error, and the only route into a control hand-rolled from `<div>`s.
2. **`raw: true`** — write the value straight into the control's own text input (dates, times,
   range ends, tags, creatable selects). Measured: a date 0.30s against 26 through its calendar.
3. **the shape's own verb** — `qa_pick_date` · `qa_pick_time` · `qa_pick_range` · `qa_pick_path`
   (cascader or tree) · `qa_pick_tags`.
4. **a CSS selector** — every verb accepts one, and a portalled popup with no roles (Ant) is
   MEANT to be driven that way; the reply's `widget: "portalled-invisible"` is saying so.
5. **`qa_click { name }`**, then read the `widget` verdict in the reply and act on THAT.
6. **background tab?** Native fields fill there; custom popovers only render in the foreground.
   `qa_focus_tab`, then retry.

Two refusals in a row on the same control mean rung 1 was skipped.

## Signing in, and which tabs you may touch

The agent session is a **set of tabs the human opts into** — the popup's "Agent drives this
tab", or right-click → *Qiksy — test this tab*. Attached tabs stay in the set while the human
looks elsewhere, so work continues in a background tab, and **a tab opened BY an attached tab
joins automatically**.

That last rule is what makes a real **identity-provider sign-in** work: Microsoft/Entra,
Google, Okta. It is the human's own browser, so they are usually signed in already; when they
are not, the provider's redirect stays inside the session and you drive it like any other
form. A 2FA prompt or a captcha is theirs — stop and say so.

`qa_open_isolated` gives a login its own cookie jar in the SAME browser, so several accounts
run side by side; `qa_tabs` hands you a `tabId` for each. A tool answering `out-of-scope` means
the tab was never attached — ask for it, don't reach around it.

---

## Filling a form — one call per step, not one per field

This is where the most time gets lost here, so it is worth stating plainly.

`qa_type` is **not** a keystroke emulator. It is the extension's own fill engine, so one
call handles a text input, a native `<select>`, a checkbox, a slider, rich text — **and**
the controls that look like they need clicking: Radix/shadcn, MUI, Ant and react-select
dropdowns, typeahead comboboxes, popup date and time pickers. It opens the popover, waits
for the options, picks the one matching your value and verifies the trigger changed.
`qa_type_many` takes an array of exactly those; a batch where half the entries are
dropdowns and dates is the normal use, not an edge case.

So one step of a wizard is about three calls:

```
qa_snapshot { fields_only: true }                       → the step's controls, not the app
qa_type_many { fields: [ …every field of the step… ] }  → widgets and all, in order
qa_click { name: "Next" }                               → its `changed` says it advanced
```

Opening a dropdown, snapshotting its options and clicking one costs three round trips and
two settle windows **per field**. Keep it for an entry the batch reported `ok: false`.
Uploads are the one exception to "one call": `qa_upload` takes `files[]` for the whole step.

**Five widget shapes need their own verb, because one value takes several interactions.**
`qa_pick_date { name, date: "14/03/1987" }` sets an exact date whatever library owns the calendar —
it types first and steers the picker only if that fails (MUI X year view, Ant's header year,
react-datepicker's dropdowns, bare arrows). `qa_pick_path { name, path: ["Ukraine","Kyiv oblast","Kyiv"] }`
walks a cascader or a drill-down level by level. `qa_pick_tags { name, tags: [...] }` adds chips to
a control that CREATES its values (Ant `mode="tags"`): it types, **verifies the text is still in the
field**, then presses Enter — because a commit clears the component's own search input, and Enter on
a wiped field re-submits the previous text, which toggles that tag back OFF. `qa_pick_range { name,
from, to }` sets both ends of a range that lives in one control, walking start → end panel without
re-opening. `qa_pick_time { name, time: "14:30" }` drives a column picker whose cells have no role at
all. All five are ONE call and all five re-snapshot between steps, which is what makes them work
where a batch cannot.

**If you already hold the data, skip the mapping.** `qa_fill_json { fields: { "Initiative
name": "Test run", "Country": "Ukraine", "I agree": true }, advance: "Next" }` — labels instead
of refs, one call, and it snapshots and resolves for you. With `advance` it also presses the
step's button, but **only if every entry landed**, and it judges that press by the click's DIFF
rather than its `ok` — a Next that stays disabled until the step validates accepts a click and
does nothing. The next step's field names ride back in `next.fields`, so the step after this one
needs no snapshot either. That is the same JSON shape the panel's `{ }`
editor and its ⚡Fill button use, so a dataset you build reads the way a human would edit it.
Keys that matched nothing come back with the page's real field names, so the next call fixes
itself. Use `qa_snapshot` + `qa_type_many` instead when you must pick one specific control
among duplicates.

Custom widgets are still filled strictly one at a time — two open popovers break each
other — so a step with several dropdowns takes a few seconds of genuine waiting. That part
is the widgets, not the bridge.

## The fast route: put the value straight in

`qa_type { raw: true }` writes the string VERBATIM into the control's own text input — through the
native value setter, which is what React's tracked `value` property requires — and commits it with a
key. Measured on a live stand: a date **0.30s this way against 26s** driven through its calendar, a
time 0.30 against 14, a range 0.60 against 35.

It is for controls that **parse** text: dates, times, range ends, tags, a creatable or async select.
Pass the value in the format the control DISPLAYS (`06/11/2024`, `14:30`, the option text), not ISO.

- `commit` — the key that commits, default `Enter`. Pass `""` for a plain input, where Enter submits
  the form.
- `blur: true` — a tags field keeps its value only once focus LEAVES.
- `pick: true` — write the text to filter, then CLICK the option that matches. For a select the text
  alone never chooses; this is the other half.
- `open: true` — click the control first. A select filters only while its list is open.

A select that must **choose a row from its own list** is not a raw case: leave the flag off and let
the fill engine do it (it opens the list, waits, picks the match, checks the trigger changed). Ant
Design in particular commits its selection its own way and ignores an option click from outside the
page's own context.

`qa_type_many` and `qa_fill_json` take these per entry and set them for you: raw for what parses,
the engine for what chooses. Raw entries go in ONE pass — they open nothing, so they cannot collide.

**And when the widget is what you are testing, do not use this.** Driving the popup the way a user
does is the honest thing then; the visual side belongs to a real browser driver that can see pixels.

## You are told what a widget IS — don't work it out by trial and error

Every session before this one re-derived the same facts by failing at them. They are in the
replies now, in three places, all free:

- **`qa_snapshot`** → `componentLibraries` + `hints` (which UI library draws this page, and what
  that means: an Ant day is a role-less `<td title="2026-06-28">`, a MUI date field cannot be
  written to at all, a react-select value must be the option TEXT) and **`widgets`** — the notable
  kinds on the page, each with the verb that drives it and the fields it applies to.
- **`qa_click` / `qa_press`** → `widget`, the verdict on what your click just opened, read off the
  diff: `calendar-popup` → `qa_pick_date` · `option-list` → it is a select, so pass a value instead
  of clicking · `tree-popup` → click the CHECKBOX via `qa_pick_path` · `modal` → snapshot `within`
  the dialog · `navigated` → the step swapped, every ref you hold is void ·
  **`portalled-invisible`** → it opened and the tree gained NOTHING, so the popup is role-less
  markup in a portal: address its parts by CSS selector, which every verb accepts.
- **`qa_probe { name }`** → for the ONE control that refused a value, and the only route into a
  widget hand-rolled from `<div>`s (role `generic`, no name, no state). Shape first — a sectioned
  date field, a file input, a switch and a slider are settled with **no click at all** — then one
  click, read the diff, Escape. Do not probe every field: the snapshot already classified the page.

**Then save what you learned.** A long flow discovered once should not be discovered twice:

```
qa_recipe_save { name: "New initiative" }        → ~/.qiksy/recipes/new-initiative.json
qa_recipe_list                                    → what is already saved for this host
qa_recipe_apply { name: "New initiative", step: 1, dry_run: true }   → does it still fit?
qa_recipe_apply { name: "New initiative", all: true, values: {...} } → replay it
```

The recipe stores field NAMES, not refs (a ref lives for one snapshot; a name survives a
re-render and a new session), and the replay re-matches them against the page as it is now.
`values` swaps the data, so one saved flow becomes many runs. `dry_run` reads only. With
`all` it clicks each advance control — including a final Submit, so keep it stepwise on
anything irreversible. Tell the human where the file is: it is theirs to edit or delete.

## How to drive it well

- **Target by `ref` from a fresh snapshot.** A `ref` is unique where a CSS selector is
  ambiguous. After anything that navigates or re-renders, call `qa_wait_ready` and take
  a **new** snapshot — old refs go stale.
- **A ref belongs to ONE snapshot.** Taking another renumbers them: `e12` may now be a
  different control, and clicking it will *succeed* — on the wrong thing. Discard the old
  refs, or target by `name` (`qa_click { name: "Next" }`, `qa_fill_json`), which survives
  both a re-render and a renumbering. This pressed **Back instead of Next** the first time
  it ran against a real wizard.
- **Narrow the snapshot on a big app.** `fields_only`, `roles`, `match`, `within` (the
  selector of a container node, for one dialog or step), `format: "tree"`. Pulling the whole
  tree on every step of a form is the other half of a slow run. Filtering never invalidates
  a ref.
- **Address a specific tab** with `tabId` from `qa_tabs`; omit it to act on the active
  one. Tabs from `qa_open_isolated` are separate logins on the same site — that is how
  you drive several accounts at once.
- **After a submit**, `qa_wait_ready` before the next call: the old document (and Qiksy
  inside it) is gone, and the next call would land on a page still being replaced.
- **Autocomplete: give `qa_type` the option text first.** It waits for the suggestion list
  itself (they arrive asynchronously, ~0.4s on travel sites) and picks the match. Only when
  it answers `ok: false` do you fall back to type → wait → snapshot → click the option, and
  even then check the trigger's text before assuming the choice committed.

## What it cannot do — say so, don't substitute

- **No screenshots.** `qa_snapshot` is a tree, not pixels. A judgement that genuinely needs
  to SEE the rendering — is this the right shade, does that shadow look right — cannot be
  made from here.
- **No arbitrary JavaScript.** No `evaluate`, by design (a Web Store requirement). Every verb
  is a closed vocabulary: you name an element, never a program.
- **Styles, geometry and web storage ARE available** — `qa_styles` (computed styles, the box,
  and the CSS custom properties in scope), `qa_snapshot({geometry:true})` (every node's box in
  CSS pixels), `qa_storage` (localStorage / sessionStorage, read free, write behind Agent
  control). This guide used to list all three as impossible. That was a wrong inference from
  the no-eval rule, and it cost real capability: an agent told a thing cannot be done does not
  try it. And there ARE pixels now (`qa_screenshot`) — but reach for the numbers first: "this
  button renders #3B82F6 at 15px with 22px padding, and its box overlaps the one next to it"
  needs no picture at all, costs no context, and works in a background tab, which a photograph
  does not.
- **No `<iframe>` contents.** Payment forms (Stripe, 3-D Secure) live in frames the
  content script does not enter. Fill up to them, not inside them.
- **No captcha.** Stop and hand it back.
- **Background tabs are throttled by Chrome.** Native inputs fill fine in the
  background; custom popovers (Radix/MUI selects, date pickers) only render in the
  foreground tab.
- **Navigation stays on the site under test.** `qa_navigate` refuses a different site
  (`out-of-scope`) — the human opens that tab, then the agent works in it.

When a task genuinely needs pixels, eval or a different site, name the missing
capability out loud instead of quietly switching to another tool.

## Several agent windows, one browser

Each MCP client starts its own copy of the server, but only one can own the loopback
port: whoever binds it is the hub and holds the extension socket, the rest relay
through it automatically. You do not need to know which one you are. If the owning
window closes, the others take the port over within a second or two — a call that fails
that way is worth one retry.

If the port is held by something that cannot share it (an older bridge, an unrelated
process), the tools say so; the fix is that process or a different `--port`, not the
popup.
