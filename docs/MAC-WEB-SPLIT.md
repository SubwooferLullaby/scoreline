# The Mac and web split

The owner's brief (2026-11-26): the Mac app is bloated and doesn't run cleanly, so take the heavy parts out of it and leave them to the web. The web app comes first (CLAUDE.md, Direction). This file is the plan and the decisions it needs. It also holds what reading the code found about the 1.0.33 crash.

Nothing here has been built or run on a Mac. It's planned from the sources at `c388dde`, from the 1.0.33 release binary and from the two crash reports on the `data` release.

## Summary

- **The crash is found.** It's a `Double` to `Int` conversion of NaN in the soccer timeline's VoiceOver label (`MatchTimeline.swift:472`). It's reached on every live soccer game page in the first moments after it opens, before the broadcast clock has started. It came in with `fdae434` (Nov 2), which shipped in both 1.0.32 and 1.0.33. The 1.0.33 diff (the new football) doesn't cause it. See [The 1.0.33 crash](#the-1033-crash).
- **The menu bar app becomes:** the live score in the menu bar, a compact panel of your teams' games and today's scores, alerts for your teams, and a click that opens any game in the web app in the default browser. It keeps the settings that drive those.
- **Everything else moves to the web.** That's game pages, theaters, the broadcast engine, odds, celebrations, schedules, results, standings, brackets, and team and player pages. The web has all of them at parity (`web/ARCHITECTURE.md`, Parity checklist).
- **About 108,000 lines go down to about 13,000** after phase 2, and about 10,000 after phase 3. Of 148 Swift files, about 32 stay.
- **Phase 1 is one small release:** game pages open in the browser. That removes the crash and the heavy runtime work without deleting anything.

## The 1.0.33 crash

### What the reports say

There are two reports on the `data` release (`Scoreline-2026-11-04-133633.ips` and `-133638.ips`), both from 1.0.33 (build 35, binary UUID `6d5486d9-6f3d-38c5-97ba-1385361b2f69`). Each crashed 5 to 6 s after launch, so a game was opened straight away. Both are identical:

- `EXC_BREAKPOINT` (`brk #1`) at image offset `0x2c3adc`, called from `0x2c0940`, called from `ViewBodyAccessor.updateBody`. The view is a `ForEach` child inside the page modules' `AnyLayout`, inside a `ScrollView`: a game-page module.
- `x8 = 0x7ff8000000000000` (the absolute bits of a quiet NaN), `x9 = 0x7fefffffffffffff` (`Double.greatestFiniteMagnitude`). `x16` last held `Date.timeIntervalSince(_:)`, and `x26` held Date's metadata.

### What the release binary says

The binary in the v1.0.33 release `Scoreline.zip` has the same UUID as the reports. Disassembled at those offsets:

- The trap at `0x2c3adc` is the first check of an `Int(_: Double)` conversion. An outlined helper does `fmov x8, d0; and x8, x8, #0x7fffffffffffffff; mov x9, #0x7fefffffffffffff; cmp x8, x9`, then `b.gt` to the trap. That's "Double value cannot be converted to Int because it is either infinite or NaN", and the registers say the value was NaN.
- The function (`0x2c3634`…`0x2c3ae8`) builds its string from the literals "key play", "turnover", " goals, ", " yellow cards, " and " red cards.". The only source with those words is `MatchTimeline.accessibilityText` (`MatchTimeline.swift:463-475`). The caller at `0x2c0940` is `MatchTimeline.body`, which passes it to `.accessibilityLabel`.
- The trapping conversion follows the call that builds a `SoccerClock` (with the `Optional<Date>` check for `history.start ?? domain.lowerBound`) and the call to `minute(at:)`. So it's line 472, `Int(clock.minute(at: now))`, not the `Int($0)` on line 469.

### How NaN gets there

1. Opening a live game creates a fresh `Broadcast` (`DetailView.swift:44`, `@State`). `begin` sets `active = true` (`Broadcast.swift:158-159`).
2. For soccer, the summary carries no broadcast plays (`BroadcastLanes.summaryPlays` returns nil for `.soccer`, `BroadcastLanes.swift:142-143`). So `BroadcastEngine.advance` returns early on an empty timeline (`BroadcastEngine.swift:62`), and the clock stays unstarted until the first core-plays look arrives over the network.
3. Meanwhile the page passes `broadcast.active ? broadcast.clock : nil` to the timeline (`DetailView.swift:1350`) and to Win Probability (`:1500`). An unstarted clock's `p(at:)` is `-.infinity` (`PresentationClock.swift:178`).
4. `MatchTimelineSection` turns that into `until = Date(timeIntervalSince1970: -inf)` (`MatchTimeline.swift:671`). Then:
   - `history.shown(until:)` keeps no events and no periods, so `start` is nil.
   - `domain` becomes `-inf...-inf`, because `min(first, now - 1)` is -inf (`MatchHistory.swift:100`).
   - `now` is -inf.
5. `accessibilityText` builds `SoccerClock(start: -inf, periods: [], now: -inf)`. `minute(at: -inf)` finds no period and returns `(-inf).timeIntervalSince(-inf) / 60`, which is NaN (`MatchTimeline.swift:78`). `Int(NaN)` traps.

The trigger is any live soccer game whose page shows the timeline and whose summary history has events, during the second or so before core plays arrive. Nov 4 at 13:36 Pacific is 21:36 UTC on a Wednesday, which is consistent with a European evening match. Other sports don't reach line 472: it's soccer only, and their summaries start the clock in the same call.

### Why 1.0.32 seemed fine

The trap line and the presentation-clock path both came in with `fdae434` ("One timeline for every sport…", Nov 2, 13:05). `git tag --contains fdae434` lists v1.0.32 and v1.0.33. 1.0.32 was the latest release for only 80 minutes (Nov 2, 20:52 to 22:12 Pacific), almost certainly without a live soccer game opened. The only Swift change from 1.0.32 to 1.0.33 is `FootballTheater.swift`, and it can't produce this frame (below).

### Candidates, ranked

| # | Where | Construct | Input that triggers it | Likelihood |
|---|---|---|---|---|
| 1 | `MatchTimeline.swift:472` | `Int(clock.minute(at: now))` | Live soccer page, clock not started, so `now` and `domain` are -inf and the minute is NaN | **Certain.** It matches the binary, the registers and the strings. |
| 2 | `MatchTimeline.swift:200-208` (`soccerLandmarks`) | `stride(...through: now...)` and `stride(...to: last...)` with a NaN end, then `Int(last)` | Same input, with the timeline zoomed to a half or set to "recent" | It would surface next if only line 472 were patched. A NaN stride end never terminates, so it's a hang that eats memory, then a trap. |
| 3 | `OddsChart.swift:1680-1682` (`OddsChartDescriptor`) | `0...minutes`, where `max(NaN, 1)` is NaN | Same input, with VoiceOver reading Win Probability's audio graph | It traps on a range precondition, but only for an accessibility client. |
| - | `FootballTheater.swift` (the whole 1.0.33 diff) | Only the constant ranges `1...6` and `-1...1`, `remainder`, `atan2`, `hypot`, `Path` math | none | **Ruled out.** No unwrap, subscript, data-built range or `Int(Double)`. It all runs in the `Canvas` renderer, not in `updateBody`. |

The fix below closes all three, because it stops -inf at its source.

### The fix (not applied)

It isn't applied to the Mac sources: it can't be verified here, and every Mac change ships as a release. Phase 1 makes this path unreachable anyway, because game pages leave the app. If a 1.0.34 should keep game pages for a while, this is the minimal patch. It treats an unstarted clock as "no broadcast yet", which is what `Broadcast.present` already does (`Broadcast.swift:533`).

```diff
--- a/Sources/Scoreline/PresentationClock.swift
+++ b/Sources/Scoreline/PresentationClock.swift
@@ -179,6 +179,14 @@ struct PresentationClock: Equatable, Sendable {
         return piece.p(at: t)
     }
 
+    /// The moment presented at `date`, as a date; nil while the clock has no
+    /// finite plan (unstarted, p is -inf), so the page shows as it would
+    /// without a broadcast.
+    func presentedDate(at date: Date) -> Date? {
+        let p = p(at: date.timeIntervalSince1970)
+        return p.isFinite ? Date(timeIntervalSince1970: p) : nil
+    }
+
     /// The clock's rate at `t` (1: real time, 0: holding).
     func rate(at t: PTime) -> Double { piece(at: t)?.v(at: t) ?? 0 }
--- a/Sources/Scoreline/MatchTimeline.swift
+++ b/Sources/Scoreline/MatchTimeline.swift
@@ -469,7 +469,8 @@ struct MatchTimeline: View {
         var to = current.map { " to \(Int($0)) minutes" } ?? ""
         if let wall, let now = wall.now, wall.history.sport == .soccer {
             let clock = SoccerClock(start: wall.history.start ?? wall.domain.lowerBound, periods: wall.history.periods, now: now)
-            to = " to \(Int(clock.minute(at: now))) minutes"
+            let minute = clock.minute(at: now)
+            if minute.isFinite { to = " to \(Int(minute)) minutes" }
         }
@@ -668,7 +669,7 @@ struct MatchTimelineSection: View {
         VStack(alignment: .leading, spacing: 0) {
             if let clock = presentation {
                 TimelineView(.explicit(OddsSection.schedule(feed: feed, clock: clock, now: Date()))) { context in
-                    content(until: Date(timeIntervalSince1970: clock.p(at: context.date.timeIntervalSince1970)))
+                    content(until: clock.presentedDate(at: context.date))
                 }
             } else {
                 content(until: nil)
--- a/Sources/Scoreline/OddsChart.swift
+++ b/Sources/Scoreline/OddsChart.swift
@@ -703,7 +703,7 @@ struct OddsSection: View {
         Group {
             if let clock = presentation {
                 TimelineView(.explicit(Self.schedule(feed: feed, clock: clock, now: Date()))) { context in
-                    section(until: Date(timeIntervalSince1970: clock.p(at: context.date.timeIntervalSince1970)))
+                    section(until: clock.presentedDate(at: context.date))
                 }
             } else {
                 section(until: nil)
```

Add a test to `MatchTimelineTests.swift` next to it:

- `PresentationClock().p(at: 0)` is -inf.
- `PresentationClock().presentedDate(at: .now)` is nil.
- A wall-scale `MatchTimeline` built from `MatchHistory.shown(until: Date(timeIntervalSince1970: -.infinity))` doesn't trap when its label is read.

### How to confirm it on the Mac

1. **Symbolicate the reports:**
   - Check out `8aeb0f2` in a worktree. Run `build.sh`'s `swiftc` line without `strip -x`, using the same SDK and toolchain.
   - Run `atos -arch arm64 -o <unstripped binary> -l 0x100000000 0x1002c3adc 0x1002c0940`. Expect `MatchTimeline.accessibilityText.getter` (MatchTimeline.swift:472) and `MatchTimeline.body.getter`.
   - If the toolchain has moved since Nov 2 and the offsets differ, compare the instructions at the offset, or find the function that references " yellow cards, ".
2. **Reproduce it:**
   - Build with `-Onone -g -D DEBUG`, using `build.sh`'s flags without `-Osize -wmo` and `strip`.
   - Open a live soccer game whose timeline module is on screen. It should stop at once with "Fatal error: Double value cannot be converted to Int because it is either infinite or NaN" at `MatchTimeline.swift:472`.
   - With the patch, the same page should open, and the timeline should switch to the presented history once core plays arrive.
3. **Without a live game:** the test above fails before the patch and passes after it.

## Inventory

Lines are from `wc -l` at `c388dde`. The Swift sources total 108,077 lines in 148 files, and `Tests/` has 72 files and 21,482 lines. "Web" is the parity checklist in `web/ARCHITECTURE.md`.

| Area | Files | Lines | Web | Runtime cost on the Mac |
|---|---|---|---|---|
| App shell, panel, menu bar, updates | `ScorelineApp`, `PanelController`, `PanelCommands`, `MenuBarLabel`, `RootView`, `Updater`, `Glass`, `Responsive`, `Components`, `SharedUI`, `ImageCache` | 4,724 | Equivalent (split view, back stack, commands, the tab's title as the menu bar item) | A display-link loop only while the panel moves or resizes. A 180 s teardown task after closing. |
| Scores data, settings, alerts | `ScoreStore`, `Providers`, `Models`, `Teams`, `Following`, `Notifier`, `TeamColors`, `ClimbingBroadcast`, `CoStream`, `LiveSnapshot` | 4,190 | Yes. Alerts only while a tab is open: push is `[ ]`. | One scoreboard poll per enabled league on ScoreStore's cadence, and `NWPathMonitor`. Climbing stream, CS2 co-stream and CS2 live checks. |
| Scores list | `ScoresView`, `EventRow`, `ListLayout`, `OutlineList`, `LandingView` | 2,469 | Yes | Live-clock `TimelineView` per live row |
| Tiles | `TileBoard`, `Tiles`, `TileStrips`, `TilesGallery` | 2,911 | Yes | Strip animations and `TimelineView`s on every live tile |
| Settings pages | `ManageView`, `LeagueSettingsView`, `SportsView` | 1,482 | Yes | On-demand fetches (team lists, hubs) |
| Game page shell and live views | `DetailView`, `GameDetail`, `LiveViews`, `Visualizations`, `VizKit`, `LiveFeeds`, `PageModules`, `ModuleDrag`, `PageGeometry`, `DockedScorebar`, `MatchColors`, `MatchTimeline`, `MatchHistory`, `ChartLinks`, `Broadcasters`, `Basketball`, `BasketballFeed`, `BasketballViews`, `Statcast`, `FotMob` | 21,075 | Yes, except "Show on {chart}" for screen readers (`[ ]`) | **Heavy.** A summary poll every 5 s (8 s soccer, 4 s climbing), plus the NBA clock lane every few seconds, MLB's Statcast feed and the soccer feeds. Docked bar and module-drag timers. The deepest view tree in the app. |
| Live odds | `Odds`, `OddsFeed`, `OddsChart` | 3,005 | Yes | One Polymarket WebSocket and polling while on screen. A redraw schedule up to 240 ticks plus a 15 s beat. |
| Broadcast engine | `Broadcast`, `BroadcastEngine`, `BroadcastLanes`, `BroadcastReplay`, `BehindLive`, `PresentationClock`, `PresentedGame`, `GameTimeline` | 4,551 | Yes (the `?demo` harness is `[~]`) | Wakes at each scheduled change and a 5 s heartbeat. Re-derives the page at each tell. |
| Theaters (isometric views) | 41 files: `Play*` (6), `Football*` (5), `Soccer*` (5), `Basketball*` other than above (6), `BaseballClips`, `Theater*` (16), `Replays`, `ReplayWell` | 36,422 | Yes (today's off-broadcast queues are `[ ]`) | **Heaviest.** Display-rate `TimelineView`/`Canvas` frames while anything moves, ambient motion between plays, a script build per play (up to 90 ms for soccer). A third of the code. |
| Celebrations and scoring slides | `Moments`, `Celebrations`, `LiveCelebrations`, `BasketballCelebrations`, `CelebrateMatch`, `ScoringSlide`, `ScoringSlideView` | 5,220 | Yes (the knock, fill sweep and summit flag are `[ ]`) | Animated `TimelineView`s while a moment plays |
| Schedules and results | `Schedule*` (8), `Result*` (6), `SeasonCard`, `SeasonResults`, `SeasonResultsViews`, `SeasonTimeline`, `EventResultsPage`, `TournamentsPage`, `ClimbingSeasonPage` | 13,217 | Yes | On-demand fetches with disk caches. `ScheduleStore` also fetches My Teams' next games for the list. |
| Standings, polls, brackets, competitions | `StandingsView`, `College`, `Brackets`, `CompetitionPage`, `SoccerCompetition` | 2,933 | Yes | On-demand fetches |
| Team and player pages | `TeamPage`, `TeamSections`, `PlayerPage`, `PlayerSections`, `Profile*` (6) | 5,878 | Yes | On-demand fetches, disk cache, dwell prefetch |

The cost that matters is the game page: polling, a WebSocket, the broadcast engine and a theater all run together in one SwiftUI tree, and that's where the crash is. The list and the menu bar are cheap. There's also a build-time cost: every `swiftc -wmo` peaks at about 2.3 GB on a 16 GB Mac, and the release binary is 13.8 MB.

## What the menu bar app becomes

- **The menu bar item** stays as it is (`MenuBarLabel`): icon at rest, a live count, and the pinned or followed game's score.
- **The panel** is the scores list: My Teams first, today's games by league, live first if set, a team's next game within 21 days when it has none today, and collapsed sections.
- **Alerts for followed teams** (`Notifier`): start, every score, final. Clicking one opens the game on the web.
- **One click to the web.** A row, a notification or the row's menu opens `/game/<id>?league=<league>` in the default browser. The row's menu keeps "Pin to Menu Bar" and "Follow". Its other items (schedule, standings, team) become web links.
- **Settings:** enabled leagues and their order, followed teams and tournaments, team filters, show finished games, live count, score in the menu bar, alerts, college Top 25 only, climbing disciplines, live first, and updates. One "Open Scoreline for the web" link.
- **Gone from the Mac:** game pages, theaters, odds, celebrations, scoring slides, tiles, schedules, results, standings, brackets, competitions, and team and player pages.

### Browser, not an embedded web view

Open games in the **default browser**. Don't use a `WKWebView` window.

- **Sign-in.** The web app is planned to require sign-in with a passkey or Google (LAUNCH.md).
  - The default browser already has the session, and the gate keeps the route through sign-in, so a click lands on the game.
  - A `WKWebView` has its own cookie store, so every user would sign in a second time inside the app.
- **Passkeys in a `WKWebView`** need the `com.apple.developer.associated-domains` entitlement, a `webcredentials:` entry in an `apple-app-site-association` file on the site, and a team ID. The app is ad-hoc signed (`codesign --sign -`), and Developer ID signing isn't done yet. A restricted entitlement can't be used until it is.
- **Google sign-in** refuses embedded web views (`disallowed_useragent`). It would need `ASWebAuthenticationSession` and a native OAuth flow.
- **Performance.** The theater runs smoothly in a browser tab at full width. A `WKWebView` adds a web content process to a menu bar app (a few hundred MB while a game page runs), and the panel is too narrow for a game page.
- **Less code.** Opening a URL is one call (`NSWorkspace.shared.open`). A web view window is a second window type, with its own sizing, navigation and error states.

The cost is a context switch to the browser. That's acceptable, because the browser is where the full app lives.

### Settings sync: not now, a one-way import later

- **Two-way sync isn't worth it yet.** The web syncs settings to D1 behind a Better Auth session cookie. To share them, the Mac would need its own credential. For example, the web could mint a scoped, revocable token and hand it over on a `scoreline://` URL, and the Mac would keep it in the Keychain and read and write `/api/settings`. That's new auth surface on the Worker, a URL scheme and conflict rules, all for a handful of keys.
- **Phase 3 can add a one-way import that's cheap and safe.**
  - The Mac's Settings gets a "Use these teams on the web" link. It opens `/settings/import#<base64url JSON>` with `enabledLeagues`, `followedTeams`, `followedEditions`, `teamFilters` and `filteredLeagues`.
  - The payload rides in the fragment, so it never reaches the Worker or its logs.
  - The web shows what it would add, merges it on a click, and the account's normal sync takes over.
  - The web already uses the Mac's keys and rules (ARCHITECTURE.md, Foundation), so the mapping is direct.

## Per-file plan

### Delete (phase 2)

118 files and about 93,000 lines, by group:

- **Game page shell and live views (21,075):** `DetailView`, `GameDetail` (move `JSON` out first), `LiveViews`, `Visualizations`, `VizKit` (move `Viz` and `SectionAccessory` out first if `SharedUI` keeps them; see Shared dependencies), `LiveFeeds`, `PageModules`, `ModuleDrag`, `PageGeometry`, `DockedScorebar`, `MatchColors`, `MatchTimeline`, `MatchHistory`, `ChartLinks`, `Broadcasters`, `Basketball`, `BasketballFeed`, `BasketballViews`, `Statcast`, `FotMob`
- **Live odds (3,005):** `Odds`, `OddsFeed`, `OddsChart`
- **Broadcast engine (4,551):** `Broadcast`, `BroadcastEngine`, `BroadcastLanes`, `BroadcastReplay`, `BehindLive`, `PresentationClock`, `PresentedGame`, `GameTimeline`
- **Theaters (36,422):**
  - `PlayTheater`, `PlayScene`, `PlayScript`, `PlayBeat`, `PlayBeatScript`, `PlayCamera`, `BaseballClips`
  - `FootballTheater`, `FootballScene`, `FootballScript`, `FootballIdle`, `FootballClips`
  - `SoccerTheater`, `SoccerScene`, `SoccerScript`, `SoccerIdle`, `SoccerClips`
  - `BasketballTheater`, `BasketballScene`, `BasketballScript`, `BasketballBeats`, `BasketballFlow`, `BasketballReplay`, `BasketballClips`
  - `TheaterAnchors`, `TheaterBridge`, `TheaterCamera`, `TheaterClips`, `TheaterDirector`, `TheaterEngine`, `TheaterFrameScratch`, `TheaterKit`, `TheaterMotion`, `TheaterNames`, `TheaterPlanChain`, `TheaterQuiet`, `TheaterRig`, `TheaterStatus`, `TheaterView`
  - `Replays`, `ReplayWell`
- **Celebrations (5,220):** `Moments`, `Celebrations`, `LiveCelebrations`, `BasketballCelebrations`, `CelebrateMatch`, `ScoringSlide`, `ScoringSlideView`
- **Schedule and results pages (10,617):** `ScheduleHub`, `ScheduleNavigators`, `SchedulePage`, `ScheduleRows`, `ResultProvider`, `ResultRows`, `ResultsContract`, `ResultsHub`, `ResultsPage`, `ResultsStore`, `SeasonCard`, `SeasonResults`, `SeasonResultsViews`, `SeasonTimeline`, `EventResultsPage`, `TournamentsPage` (move `TournamentLogo` out first), `ClimbingSeasonPage` (move `UpdatedLabel` out first)
- **Standings and brackets (2,933):** `StandingsView`, `College`, `Brackets`, `CompetitionPage`, `SoccerCompetition`
- **Profiles (5,878):** `TeamPage`, `TeamSections`, `PlayerPage`, `PlayerSections`, `ProfileCache`, `ProfileCharts`, `ProfileLinks`, `ProfileModels`, `ProfileProviders`, `ProfileStore`
- **Tiles and the landing switch (3,011):** `TileBoard`, `Tiles`, `TileStrips`, `TilesGallery`, `LandingView` (move `PanelMotion` out first)
- **Rows' extras (355):** `CoStream`, `LiveSnapshot`
- **Tests:** every suite that exercises the above, about 60 of 72 files, including `BroadcastBench`, the `TheaterBench*` files and their fixtures. Drop them from the runner in `ScorelineTests.swift`. Leave `Tests/Fixtures` as it is until a `--record` run prunes what's no longer requested.

### Keep, and what to cut inside them

| File | Lines | Action |
|---|---|---|
| `ScorelineApp` | 47 | Keep |
| `PanelController` | 1,603 | Keep. Drop sizing for detail pages. Phase 3: drop detach, minimize and the resize handles, for a fixed-width popover-like panel. |
| `PanelCommands` | 67 | Keep. `.event(id)` opens the web. |
| `MenuBarLabel` | 59 | Keep |
| `RootView` | 536 | Simplify: `Page` keeps `scores`, `manage`, `following`, `sports`, `sport`, `league`. Every other case becomes a web link. |
| `Updater` | 34 | Keep (Sparkle) |
| `Glass`, `Responsive`, `Components`, `SharedUI`, `ImageCache` | 2,378 | Keep. Drop what only game pages used (`PageGeometry` from `Components`, `Viz` from `SharedUI`). |
| `ScoreStore` | 1,267 | Simplify. Drop `modules`, `celebrationLevel`, `celebrationSounds`, `scoringSlides`, `showOdds`, `landingView`, the co-stream and CS2 live checks, `LaneScores`, `soccerFeed`, `standings(for:)` and `noteStreams`. |
| `Providers` | 876 | Simplify. Drop the situation lines that read `NBADetail`, `BroadcastLanes.stoppage` and `MatchMark`. Keep the scoreboard providers. |
| `Models`, `Teams` | 670 | Keep. Drop `Event.snapshot` and `Competitor.kit`. |
| `Following` | 394 | Keep (it migrates `followedEditions`). Its "Go to team" items become web links. |
| `Notifier` | 92 | Keep. Clicking opens the web. |
| `TeamColors` | 415 | Keep the crest colors for rows if the list uses them, otherwise delete. Drop `note(_ detail:)`. |
| `ClimbingBroadcast` | 121 | Keep. The stream's start time is the real one for the list's climbing rows. |
| `ScoresView`, `EventRow`, `ListLayout`, `OutlineList` | 2,369 | Keep. Drop the tiles branch and the view switcher. The row's menu links to the web. |
| `ManageView`, `LeagueSettingsView`, `SportsView` | 1,482 | Keep. Drop the league page's Upcoming and Results hubs and the tournament season widgets, and link to the web for them. |
| `ScheduleModels`, `ScheduleProvider`, `ScheduleCache`, `ScheduleStore` | 2,600 | Keep for My Teams' next games and the tournament directory in Sports. Cut `TeamSeasons` and `ResultDetail` uses. Phase 3: trim to the next-game fetch. |
| New: `WebApp.swift` | about 60 | The web's base URL, and URL builders for game, team, player, schedule, standings, rankings, bracket, competition and results |
| New: `JSON.swift` | about 55 | `struct JSON`, moved out of `GameDetail.swift` |

### Shared dependencies to cut so the deletion compiles

Kept files use these types, which are defined in deleted files. A rough scan found them (`deps` over top-level declarations). Each needs a move or a cut before the delete:

- **Move to a kept file:**
  - `JSON` (GameDetail): used by Providers, Teams and ScheduleProvider
  - `PanelMotion` (LandingView): used by RootView and ScoresView
  - `UpdatedLabel` (ClimbingSeasonPage): used by ScoresView
  - `TournamentLogo` (TournamentsPage): used by SportsView
  - `CoStreamIcon` (DetailView): used by EventRow; or drop the co-stream mark
  - `Viz` and `SectionAccessory` (VizKit): used by SharedUI; or inline the few tokens it uses
- **Cut the use:**
  - `GameDetail` in Providers, ScoreStore and TeamColors
  - `Broadcast`, `BroadcastLanes`, `Stoppage`, `NBADetail` and `MatchMark` in Providers
  - `CelebrationLevel` and `CelebrationSound` in ScoreStore, and `CelebrationLevelRow` in ManageView
  - `ModuleLayout` and `ModuleKeys` in ScoreStore
  - `LiveSnapshot` in Models and ScoreStore
  - `TeamKit` in Models and TeamColors
  - `Standings`, `StandingsRow` and `SoccerFeed` in ScoreStore
  - `PageGeometry` in Components
  - `LandingView`, `ViewSwitcher` and the `Tile*` types in ScoresView and ScoreStore
  - `EventContextMenu` (Tiles) in EventRow: rebuild the row's menu in EventRow
  - `TeamSeasons` and `ResultDetail` in ScheduleStore and ScheduleModels
- **Replace with web links:**
  - `DetailView`, `StandingsView`, `SchedulePage`, `EventResultsPage`, `CompetitionPage`, `TeamPage` and `PlayerPage` in RootView
  - `BracketSource`, `CompetitionRef`, `EventResultsRef`, `ScheduleMode` and `ScheduleScope` in RootView and LeagueSettingsView. Keep `ScheduleScope` if `ScheduleModels` stays.
  - `ProfileNavigator`, `Profile`, `GoToTeamItem` and `ProfileMoreButton` in EventRow, Following, LeagueSettingsView, RootView and SportsView
  - `LeagueUpcomingSection` and `LeagueResultsSection` in LeagueSettingsView
- **Extensions that live in deleted files:** `extension Event` in `MatchColors` and `Tiles`, `extension Motion` in `Celebrations` and `Moments`, and `extension OKLab` in `ScoringSlideView`. Check that kept code doesn't call their members.

The scan is name-based. The compiler is the real check: `swiftc -typecheck` the kept set after each step.

### Lines before and after

| | Swift files | Swift lines | Test files |
|---|---|---|---|
| Now (`c388dde`) | 148 | 108,077 | 72 |
| After phase 1 | 149 | about 108,150 | 72 |
| After phase 2 | about 32 | about 13,000 (12,400 kept and 2,600 schedule data, less about 2,000 trimmed, plus about 120 new) | about 10 |
| After phase 3 | about 32 | about 10,000 | about 10 |

Expect the binary to drop from 13.8 MB to a few MB, and a release compile to take a fraction of its time and memory.

## Release and migration

- **Updates.** Sparkle keeps working: same `SUFeedURL`, same EdDSA key, same appcast on the latest release. Each phase is a normal `./release.sh <version>` release.
- **Bundle ID.** It stays `io.github.lame-o.Scoreline`, so settings and updates carry over.
- **Settings.**
  - The slim app reads the same `UserDefaults` keys: `enabledLeagues`, `followedTeams`, `followedEditions`, `followingSchemaVersion`, `mutedFollowedTeams`, `teamFilters`, `filteredLeagues`, `collapsedSections`, `showFinished`, `showLiveCount`, `scoreInMenuBar`, `notifyFollowed`, `collegeTop25Only`, `climbingDisciplines`, `liveLeaguesFirst`, and the panel's size and pin.
  - Keys for removed features (modules, celebrations, scoring slides, odds, `landingView`, co-stream) are no longer read. Don't delete them: they're harmless, and a downgrade still finds them.
  - Users on tiles get the list.
- **First launch of the slim version.** One quiet line at the top of the panel, dismissed with a click and remembered (`webNoteSeen`): "Game pages now open in Scoreline for the web." It links to the web app's home. Say the same in the release notes.
- **Old builds.** Nothing changes for them. Builds before phase 1 keep their in-app game pages, and Sparkle moves them forward.
- **Reference.** Before phase 2, tag the last full build (for example `mac-full-1.0.34`). The theaters and the engine stay in git history and in `docs/engine/`, the web port's reference.
- **Notarization.** It's still to do before charging money. The browser choice doesn't need it; a `WKWebView` with passkeys would.

## Phases

### Phase 1: game pages open in the web (one release, 1.0.34)

The smallest safe cut, and the fix for both the crash and the slowness. Nothing is deleted. `DetailView` stays compiled but is never shown, so its polling, engine, odds and theaters never start.

**Files:**

- New `Sources/Scoreline/WebApp.swift`:
  - `static let base = URL(string: "https://scoreline.fyi")!`
  - `static func game(_ id: String, league: String?) -> URL`: mirrors `web/src/data/gameHref.ts` and adds `from=mac`.
  - `static func open(_ url: URL)`: calls `NSWorkspace.shared.open`.
- `RootView.swift`: in `show(_:)` (`open`, `follow`, `replace` and `go` all end there), turn `.detail(event)` into `WebApp.open(WebApp.game(event.id, league: store.leagueByEvent[event.id]))` and stay on the current page. That one choke point covers the list, tiles, schedules, standings, profiles and the smoke test.
- `PanelController.swift` (`openEvent`) and `Notifier.swift`: a clicked alert opens the web URL. Set `info["url"]` to the web game URL instead of ESPN's link.
- `ScoresView.swift`: the first-launch line (`webNoteSeen`).

**Verify on the Mac:**

1. Run `./test.sh`. It should pass unchanged: no logic under test changes.
2. Run `./build.sh` and install locally.
3. Click a live game of each kind: soccer, NFL, college football, MLB, NBA, WNBA, CS2 and a climbing round. Each should open in the default browser on its game page. Check a soccer game while it's live, because that's the crash path.
4. Click a followed team's alert. Use `Notifier`'s test alert if it has one, otherwise wait for a live game.
5. Confirm that the panel never shows a game page, and that `sample Scoreline 5` shows no `DetailView`, `Broadcast` or `Theater` frames.
6. Release as usual and check the appcast.

**Risks:**

- **Signed out.** Until the sign-in gate ships, links just work. Once it ships, a first click from each browser goes through sign-in once, so test the gate's route-keeping with a `/game/...?league=...&from=mac` link.
- **Not on the scoreboards.** A game that has left the scoreboards still resolves, because the web builds it from its summary and `league` helps.
- **Offline.** The browser shows its own error, and the panel's list behaves as today.
- **Wrong browser.** If the user's default browser isn't the one they signed in with, they sign in there once.

### Phase 2: delete (one or two releases)

**Files:** the delete list and the keep table above, in this order:

1. Move the shared types (`JSON`, `PanelMotion`, `UpdatedLabel`, `TournamentLogo`, `CoStreamIcon` or its removal, and `Viz`/`SectionAccessory` or inlining).
2. Route the remaining `Page` cases to the web (see the route map below), then cut them from `RootView`.
3. Cut the uses in `ScoreStore`, `Providers`, `Models`, `TeamColors`, `Components`, `EventRow`, `ScoresView`, `LeagueSettingsView`, `SportsView`, `Following`, `ScheduleStore` and `ScheduleModels`.
4. Delete the files and their tests, and trim `ScorelineTests.swift`'s runner.
5. Update `CLAUDE.md` (what the Mac app is, the open work), `README.md`, the parity checklist's framing in `web/ARCHITECTURE.md`, and `test.sh` (drop `--bench`).

**Verify on the Mac:**

1. While iterating, typecheck after each step: `swiftc -typecheck -parse-as-library -sdk "$SDK" -target arm64-apple-macos15.0 -swift-version 5 -F "$SPARKLE" Sources/Scoreline/*.swift`, behind the lock. That's cheap now.
2. Run `./test.sh` (both the DEBUG typecheck and the suite).
3. Run `./build.sh`, then install locally and check the menu bar score, a followed team's alert, the panel's list in each width class, every Settings page, follow and unfollow, the team filter, pinning, and an update check from Settings.
4. Upgrade over 1.0.34 with real settings, and confirm followed teams, tournaments, leagues, order and filters are all intact.

**Risks:**

- **Hidden references.** Something kept may rely on an extension in a deleted file (`Event` in `MatchColors` and `Tiles`, `Motion` in `Celebrations` and `Moments`). The typecheck finds these.
- **Climbing rows.** They must still use World Climbing's stream time (`ClimbingBroadcast`).
- **Tournaments.** Followed tournaments must still appear in My Teams. Keep `followedEditions` and its schema migration.
- **Fixtures.** The fixture index will still list requests that no test makes any more. That's harmless until a `--record` run.

### Phase 3: polish (optional)

- `PanelController`: a fixed-width panel without detach, minimize or the resize handles. This drops the display-link motion loop and several hundred lines.
- Trim the schedule layer to the next-game fetch, and `Components`/`SharedUI` to what the list uses.
- "Use these teams on the web": the one-way import above.
- A row's menu could gain "Open in Browser" items for schedule, standings and team. Most already come from the route map.

Verify the same way as phase 2.

## Web-side work the split needs

- **Deep links exist.** `/game/:id?league=` (`web/src/data/gameHref.ts`). The Mac's event IDs and league IDs are the web's, on both sides: `espn-<id>`, `cs-<id>`, `ifsc-<event>-<index>`, and `eng.1`, `nfl`, `cs2`, `ifsc` and so on. Check one game per sport in phase 1.
- **The sign-in gate must keep the route** through sign-in, query string included. LAUNCH.md already decides this. Add an e2e test with `?league=...&from=mac`.
- **"From the Mac app":** no special landing.
  - The app reads `from=mac`, counts it with the game open (first-party analytics: game opens by league, now also by source), then drops it from the address bar with `history.replaceState` so shared links stay clean.
  - Signed out, the normal landing page shows. A visitor who came from the Mac sees one added line under the sign-in buttons: "Sign in once in this browser, and games from the Mac app open straight away."
- **Domain move.** If a custom domain comes (LAUNCH.md, Owner steps), have the Worker 301 `workers.dev` to it with path and query intact, so installed Mac builds keep working. Then ship a release that changes `WebApp.base`.
- **Push alerts** aren't needed for the split: the Mac keeps notifications. Push stays `[ ]` in the parity checklist.

### Mac page to web route (phase 2)

| Mac `Page` | Web route |
|---|---|
| `.detail(event)` | `/game/:id?league=` |
| `.team(ref)` | `/team/:id` |
| `.player(ref)` | `/player/:id` |
| `.standings(league, _)` | `/standings/:league` |
| `.rankings(league, _)` | `/rankings/:league` |
| `.bracket(source, _, _)` | `/bracket/:league/:id` |
| `.competition(ref)` | `/competition/:slug` |
| `.schedule(scope, mode)` | `/schedule/:scope?` or `/schedule/team/:teamID`, with results by mode |
| `.eventResults(ref)` | `/results/climbing/:eventID/:dcatID` or `/results/tournament/:slug` |
| `.scores`, `.manage`, `.following`, `.sports`, `.sport`, `.league` | Stay on the Mac (the list and settings). The league page's Upcoming and Results link to `/settings/league/:id`. |

Check each ID's format against the web's route parsers when building `WebApp.swift`. ARCHITECTURE.md says the profile routes accept every path built by hand elsewhere.
