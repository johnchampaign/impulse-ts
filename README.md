# impulse-ts

An unofficial browser version of Carl Chudyk's *Impulse* (2013), with
asynchronous online multiplayer and AI opponents.

**▶ Play: https://impulse-ts.pages.dev** — no install, no account, no cost.

TypeScript, built on the [digital-boardgame-framework]. The rules are ported
from this project's earlier C# engine ([impulse-csharp]), which was itself
derived from the rulebook.

## What works

- **Async online play** — create a game, send each player their link, take
  turns whenever. Moves arrive instantly when both players are present
  (realtime push), and the game waits for you when they aren't.
- **Solo vs AI** — five opponents with different agendas (quick points,
  aggression, Sector Core control, anti-leader, mine-and-refine).
- **2–6 players**, the full 108-card deck, every card action implemented:
  Command with battles and exploration, Build, Plan, Research, Mine, Refine,
  Trade, Sabotage, Draw, Execute, plus all six race techs.
- In-game chat, full game log, problem reporting, and optional Glicko-2
  ratings on a shared leaderboard.

## Card art

This repo ships **no game artwork** — it isn't ours to distribute, and the
deployed build contains none either. The game is fully playable with text
cards that show each card's rules text.

To see the real cards, point the app at **your own copy** of the official
[VASSAL module](https://vassalengine.org/library/projects/Impulse): the images
are unpacked in your browser, cached locally, and never uploaded. Hover any
card to enlarge it.

## Known gaps

- The board is display-only: you act from a list of legal moves rather than by
  clicking the map.
- No initiative marker, no team mode.
- Where the rulebook is ambiguous, the engine picks an interpretation. Those
  choices are written down (see the C# repo's `docs/engine.md`, "Documented
  rule interpretations") rather than hidden — corrections welcome.

## Developing

```bash
npm install
npm run typecheck    # generates the card catalog, then tsc
npm test             # engine + AI unit tests
npm run smoke        # 30 random games through the adapter, with invariants
npm run soak         # 300 games, 2–6 players
npm run tournament   # AI self-play: policy win rates
npm run dev          # local UI against the deployed API
```

`PORT-PLAN.md` is the running status and design log; `DEPLOY.md` covers the
Cloudflare Pages + Supabase setup.

## Feedback & contributions

The most useful thing you can send is an **in-game problem report** — the
report button inside the game. Filed while you're playing, it captures the
game state and context that make an issue reproducible, which helps far more
than a code change.

**Pull requests generally won't be merged.** This is a solo-maintained
project, and reviewing and integrating outside code costs more than it
saves. If you open a PR, it'll be read as a well-specified bug report or
feature request and implemented here rather than merged — so it's a fine
way to *describe* a change you'd like, just please don't expect it to land
as-is.

**The whole codebase is MIT-licensed** — fork it and do whatever you want:
change the rules, reskin it, build and ship your own version. No permission
needed; that's the point of the license.

## Credits

*Impulse* is designed by **Carl Chudyk** and published by **Asmadi Games**.
This is an unofficial fan project — if you enjoy it, buy the physical game.
Not affiliated with or endorsed by the designer or publisher; happy to take it
down on request.

[digital-boardgame-framework]: https://github.com/johnchampaign/digital-boardgame-framework
[impulse-csharp]: https://github.com/johnchampaign/impulse-csharp
