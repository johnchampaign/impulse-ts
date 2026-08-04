# impulse-ts

TypeScript port of Carl Chudyk's *Impulse* (2013), built on the
[digital-boardgame-framework] for browser play and async multiplayer.
Ported from the C# `Impulse.Core` engine (rulebook-derived, no VB6 source).

Status: engine vertical slice — see [PORT-PLAN.md](PORT-PLAN.md).

```bash
npm install
npm run typecheck   # generates the card catalog, then tsc
npm run smoke       # 30 random games headlessly through the adapter
```

## Feedback & contributions

The most useful thing you can send is an **in-game problem report** — the
report button inside the game (once the UI ships). Filed while you're
playing, it captures the game state and context that make an issue
reproducible, which helps far more than a code change.

**Pull requests generally won't be merged.** This is a solo-maintained
project, and reviewing and integrating outside code costs more than it
saves. If you open a PR, it'll be read as a well-specified bug report or
feature request and implemented here rather than merged — so it's a fine
way to *describe* a change you'd like, just please don't expect it to land
as-is.

**The whole codebase is MIT-licensed** — fork it and do whatever you want:
change the rules, reskin it, build and ship your own version. No permission
needed; that's the point of the license.

[digital-boardgame-framework]: https://github.com/johnchampaign/digital-boardgame-framework
