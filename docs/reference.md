# Sumi reference

The details behind the [README](../README.md): what each piece is, the install step by step, the
two restyled lists, the painting's rules, what Sumi runs and writes, tuning, and how to remove it.
The [recipe](../RECIPE.md) is the brief for building Sumi from an empty folder.

## What's in it

| Path | What it is |
|---|---|
| `layouts/sumi.json`, `sumi.svg` | the window, and its picture in herdr's settings: herdr's `main` layout with the ink block beside the terminals, the paper theme, a Mincho interface font, and no frame around a tab's only pane |
| `themes/ink-paper.json` | the light palette the layout uses: `#efe7d6` paper, `#1c1917` ink, `#b3301f` seal red |
| `themes/ink-night.json` | the night version: `#151413` ground, `#ddd7cb` ink, `#c8402f` seal red |
| `mods/ink-painting` | the painting: a sheet per agent, its strokes, the seal and the empty square, the fold and the left fade |
| `mods/sumi-spaces` | herdr's spaces list, redrawn: letter stamps, ink git counts and warnings |
| `mods/sumi-agents` | herdr's agents list, redrawn: ink and seal-red status marks, ink headings |

The rest of the window (the brand row and footer, the tabs, pane headers, Files, Changes and the
status bar) is herdr's shipped mods, used from your install.

## Install, step by step

1. Copy the themes: `themes/ink-paper.json` and `themes/ink-night.json` into
   `~/.config/herdr-app/themes/`. herdr's gallery installer copies only `layouts/` and `mods/`,
   so an agent installing Sumi has to be told to take the themes folder too.
2. Copy `layouts/sumi.json` and `layouts/sumi.svg` into `~/.config/herdr-app/layouts/`.
3. Move the three mod folders into `~/.config/herdr-app/mods/` with one `mv` (the README's
   `.incoming` step): herdr docks a folder it sees before its `mod.json` exists.
4. Check each mod: `herdr-app check mods/ink-painting`, `mods/sumi-spaces`, `mods/sumi-agents`.
5. Switch: `herdr-app do layout.switch '{"name":"sumi"}'`. `herdr-app status` should show
   `"errors": []`.

If one of these names is taken, rename the new file or folder and every place that names it: the
`mod` names in `layouts/sumi.json`, the `"ink-painting"` the fold looks for in
`ink-painting/main.js`, and the sort menu's `mod: "sumi-agents"` in `sumi-agents/main.js`.

## The painting's rules

- **Which sheet shows:** the agent in the tab you are looking at; with no agent in view, the
  most recently active agent's sheet, or bare paper.
- **Working:** a stroke lands every 2.5 to 4 seconds; once the subject is done, finishing touches
  every 3 to 5 seconds, up to a cap. Sheets of agents you are not looking at advance too: a
  sheet's stroke count is a function of the time its agent has worked.
- **Needs you:** the brush lifts; an empty red square waits in a lower corner.
- **A prompt ends:** the brush rests. The same sheet carries on with the agent's next prompt.
- **The last stroke:** a red seal is stamped. If the agent is still working, the sealed sheet is
  shown for 20 seconds and then fresh paper begins; if it has stopped, the sheet stays until the
  agent next starts working.
- **Random:** a new sheet picks a subject (never the one that agent's last sheet had) and a seed.
  Every stroke comes from the seeded generator, so a sheet is fully described by its subject,
  seed and stroke count and can be redrawn identically.
- **Length:** about 2 minutes of agent work for mountains, 3 to 6 for bamboo and plum.
- **Only while shown:** the mod runs while the Sumi layout is on screen. Work done while another
  layout is shown is not painted.

## The two restyled lists

`sumi-spaces` and `sumi-agents` are copies of herdr's own `spaces` and `agents` lists (version
0.1.15) in which only the drawing differs; every click, menu, sort and drag is herdr's. Being
copies, they do not receive herdr's later updates to those lists. To pick up an update, clone
herdr's list again and redo the changes [NOTICE](../NOTICE) lists.

They keep what herdr's lists keep, in the same places: their own `localStorage` (folded machines,
a reconnect in progress, each agent's last change time, pins waiting for their terminal) and
herdr's shared state (such as `agents.sort`, `space.colors` and `sidebar.width`), so the agents'
sort is one setting in Sumi and in herdr's own layouts.

## What Sumi runs and writes

- `ink-painting` runs no programs and makes no network requests. It reads and writes only `ink/`
  in the app home.
- `sumi-spaces` does what herdr's spaces list does: read-only `git` (`rev-parse`, `symbolic-ref`,
  `rev-list`) in each space's folder, on that space's machine, for its branch and ahead/behind; a
  watch on each local repository's git folder; `hc machine ls`, and `hc machine rm` and `add`
  when you click Connect for a rebuilt machine.
- `sumi-agents` runs no programs.

The painting's data is in `~/.config/herdr-app/ink/`, never inside a mod folder:

- `state.json`: one record per agent, by terminal address: the sheet's subject and seed, its
  strokes so far, the time worked on it, whether it is sealed.
- `sheets.json`: the last 50 sealed sheets, each with its subject, seed, stroke count, when it was
  sealed, and the agent's address, space name and title.
- `strokes/s11-<subject>-<seed>/`: one small SVG per step of a sheet in use, deleted once no
  agent's sheet needs it.
- `marks/`: the six seals, the empty square and the paper's fibers.

## Tuning

- **Pace**, in `mods/ink-painting/sheet.mjs`: `FAST_MS` (`[2500, 4000]`, the ms between the main
  subject's strokes), `SLOW_MS` (`[3000, 5000]`, between the finishing touches) and `HOLD_MS`
  (`20000`, how long a sheet sealed while the agent keeps working stays before fresh paper).
- **The `ink` block** in `layouts/sumi.json`: `size.px` (580, from 240 to 860; or drag its left
  edge), `fold_for` (the node whose showing hides the painting, `"panel"`; leave it out to keep
  the painting with the panel open), `fade_left` (how many px at the painting's left edge thin
  out to bare paper, 230; 0 for a hard edge).
- **Dark paper:** `themes/ink-night.json` is the night version. Pick it in herdr's theme picker,
  or follow the system with `"theme": { "light": "ink-paper", "dark": "ink-night" }` at the root
  of `layouts/sumi.json`.
- **The drawing**, in `paint.mjs`: when you change how anything is drawn, change `STYLE` in
  `main.js` too. herdr caches drawn files by path, so the old strokes would keep showing.

## Optional, and not part of the layout

- Draw the Claude icon in the theme's ink: add `"tint": true` to the `claude` entry in
  `~/.config/herdr-app/programs.json` (`{ "programs": { "claude": { "tint": true } } }`, merged
  into what is there). This applies to every layout.
- In Claude Code, pick a light theme with `/theme`. Its dark theme draws dark prompt bars and
  pale links on the paper.

## Tests

`npm test` runs `node --test "mods/**/*.test.mjs"`: the seeded drawing and a sheet's life
(statuses, sealing, timing, the files), 18 tests, no herdr needed. The two lists have none.

## Removing it

Switch to another layout, then delete `layouts/sumi.json`, `layouts/sumi.svg`,
`themes/ink-paper.json`, `themes/ink-night.json`, `mods/ink-painting/`, `mods/sumi-spaces/`,
`mods/sumi-agents/` and `ink/`.
