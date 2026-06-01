# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

**Commit and push to GitHub continuously as work progresses — do not wait until the end of a session.**

After completing any meaningful unit of work, immediately run:

```
git add <changed files>
git commit -m "short, imperative description of what changed"
git push
```

Rules:
- Commit after **every** logical change: feature added, bug fixed, file created, config updated.
- Push immediately after every commit — never let commits sit unpushed.
- Never batch unrelated changes into one commit.
- Use imperative present-tense messages: `"Add reset button"`, `"Fix win detection for draws"`, not `"Added"` or `"Fixed stuff"`.
- Never end a session without a clean, fully pushed state — no uncommitted edits, no unpushed commits.
- If git is not yet initialized, set it up before starting work so nothing is ever lost.

## Running the project

Open `tictactoe.html` directly in any browser — no server, build step, or dependencies required.

## Architecture

The entire project is `tictactoe.html`, a single self-contained file:

- **CSS** lives in a `<style>` block in `<head>`
- **JavaScript** lives in a `<script>` block at the end of `<body>`

### Key JS state

| Variable | Purpose |
|----------|---------|
| `board` | 9-element array (`''`, `'X'`, or `'O'`) representing the grid |
| `current` | Active player (`'X'` or `'O'`) |
| `gameOver` | Boolean; blocks further moves after win/draw |
| `scores` | `{ X, O, Draw }` object; survives calls to `init()` |

### Key JS functions

- `init()` — resets board, clears cell classes/text, preserves `scores`
- `checkWin(player)` — tests `player` against the `WINS` constant (8 lines); returns the winning line array or `null`

### Event handling

- Clicks are delegated to `#board` (single listener, targets `.cell` via `closest`)
- Reset button calls `init()` directly
