<p align="center"><img src="images/logo.svg" alt="" width="96"></p>
<h1 align="center">Sumi</h1>
<h3 align="center">The idea comes before the brush.</h3>
<p align="center">
  A herdr layout on rice paper, with an ink painting beside the terminal that advances while your agent works.
  <br />
  <a href="#install">Install</a>
  ·
  <a href="docs/reference.md">Reference</a>
  ·
  <a href="RECIPE.md">Recipe</a>
</p>

<p align="center"><img src="preview.png" alt="The Sumi window: spaces and agents in ink on the left, a Claude Code session on rice paper, and a finished bamboo painting with a red seal on the right." width="888"></p>

## About

Give your agent a prompt and a painting begins. On a tall sheet of paper beside the terminal, a
sumi-e picture grows one stroke at a time for as long as the agent works: a stalk of bamboo,
mountains in mist, or a plum branch climbing to the top of the page. A few minutes of work
leaves you with a finished painting, stamped with a red seal.

The rest is herdr's own window, set in ink on warm paper, with nothing taken away: spaces and
agents in the sidebar, tabs, split panes, the Files and Changes panel, the status bar.

The painting follows the agent in the tab you are looking at, and each agent has its own sheet.
When the agent needs you, the brush lifts and an empty red square waits in the corner. When a
prompt ends, the painting rests and carries on with the next one. When its last stroke lands, a
red seal is stamped, and fresh paper follows: 20 seconds later if the agent is still working,
with its next prompt if it has stopped. A sheet takes a few minutes of agent work, so how full
it is tells you at a glance how long the agent has been at it.

The sidebar is drawn in the same ink. Each space is a small stamp with its first letter, filled
for the space you are in. Each agent carries a mark: a breathing ink dot while it works, an empty
red square and "needs you" when it waits on you, a filled red square when it finished while you
were away, a pale ring when idle.

The agent does not paint the picture. The mod draws the next stroke of a randomly seeded painting
every few seconds while herdr reports the agent as working, so no two sheets are the same and
none of them costs the agent anything.

## Install

In herdr, ask your agent:

> Add herdr.dev/layouts/rquellh/sumi

Or by hand, from a clone of this repo:

```sh
H=~/.config/herdr-app
cp layouts/sumi.json layouts/sumi.svg "$H/layouts/"
mkdir "$H/.incoming" && cp -R mods/* "$H/.incoming/" && mv "$H/.incoming"/* "$H/mods/" && rmdir "$H/.incoming"
herdr-app do layout.switch '{"name":"sumi"}'
```

Your own layout stays as it was, and `ctrl-shift-l` switches back. The painting starts with the
next prompt you give an agent. Opening Files or Changes folds the painting away until you close
the panel.

Sumi is on light paper, so set Claude Code to a light theme with `/theme`: its dark theme draws
dark prompt bars and pale links on the paper.

The [reference](docs/reference.md) covers what each piece is, the install step by step, the two
restyled lists, what Sumi runs and writes, tuning the pace and the panel, and how to remove it.

## Requirements

herdr on macOS (the interface font, Hiragino Mincho ProN, comes with macOS) and git. node, for
the tests.

## License

[Apache-2.0](LICENSE). [NOTICE](NOTICE) says what comes from herdr.
