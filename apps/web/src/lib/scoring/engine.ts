// Pure local mirror of the server-side scoring RPCs (record_count_event,
// record_score_event, set_base_runner, set_home_or_away, advance_batter,
// advance_opponent_batter -- see supabase/migrations/0007, 0009, 0010, 0013,
// 0015), used to keep the live-scoring UI responsive while offline. Zero
// imports from Supabase/Dexie/React -- these functions must produce exactly
// what the matching RPC would, since the queued action is later replayed
// against the server for real once connectivity returns.
//
// Accepted limitation: if a SECOND device is also scoring this same game
// while this device is offline, this device's locally-displayed state can
// only reflect its own queued taps layered on whatever state it last saw
// before disconnecting -- it has no visibility into the other device's
// concurrent writes. Once reconnected, each queued action still replays
// correctly against the server's true current state (every RPC recomputes
// from live state under its own row lock), so the game is never corrupted,
// but the locally-shown numbers can visibly jump to reconcile. This is the
// deliberate tradeoff of "keep scoring fully offline" over the alternative
// of just pausing the UI until reconnected.

// inning_half/home_or_away/last_pitch_charged_to are plain text columns in
// the DB (not Postgres enums), so database.types.ts -- and the local `Game`
// type in game-score-panel.tsx that mirrors it -- type them loosely as
// `string`/`string | null`, matched here rather than narrowed to a literal
// union, so a `Game` value can be passed into these functions without a
// cast. Real values are always constrained to 'top'/'bottom',
// 'home'/'away'/null, and 'our'/'opponent'/null respectively by the RPCs
// that write them -- the comparisons below rely on that runtime invariant,
// not on the TS type.
export type GameState = {
  balls: number;
  strikes: number;
  outs: number;
  current_inning: number;
  inning_half: string | null;
  home_or_away: string | null;
  our_score: number;
  opponent_score: number;
  current_batter_player_id: string | null;
  current_opponent_batter_id: string | null;
  our_pitcher_pitch_count: number;
  opponent_pitcher_pitch_count: number;
  last_pitch_charged_to: string | null;
  runner_on_first: boolean;
  runner_on_second: boolean;
  runner_on_third: boolean;
};

// Safe as array-index+1-with-wraparound ONLY because game_lineup/
// game_opponent_lineup batting_order is always a dense 1..N sequence
// written by set_lineup/set_opponent_lineup -- if that invariant ever
// changes this needs to go back to an explicit "smallest greater than
// current" search like next_lineup_batter's SQL does.
export function nextInOrder(orderedIds: string[], currentId: string | null): string | null {
  if (orderedIds.length === 0) return null;
  const idx = currentId ? orderedIds.indexOf(currentId) : -1;
  if (idx === -1 || idx === orderedIds.length - 1) return orderedIds[0];
  return orderedIds[idx + 1];
}

export function applyCountEvent(
  game: GameState,
  eventType: "ball" | "strike" | "out",
  delta: 1 | -1,
  ourLineup: string[],
  opponentLineup: string[]
): GameState {
  const next = { ...game };
  const halfAtPaStart = game.inning_half;
  let nextBatter = game.current_batter_player_id;
  let nextOpponentBatter = game.current_opponent_batter_id;
  let paEnded = false;

  const weAreBatting =
    game.home_or_away !== null &&
    ((halfAtPaStart === "top" && game.home_or_away === "away") ||
      (halfAtPaStart === "bottom" && game.home_or_away === "home"));

  // Pitch-count attribution -- ball/strike only, 'out' never touches it.
  if (eventType === "ball" || eventType === "strike") {
    if (delta === 1) {
      if (game.home_or_away !== null) {
        if (weAreBatting) {
          next.opponent_pitcher_pitch_count = game.opponent_pitcher_pitch_count + 1;
          next.last_pitch_charged_to = "opponent";
        } else {
          next.our_pitcher_pitch_count = game.our_pitcher_pitch_count + 1;
          next.last_pitch_charged_to = "our";
        }
      }
    } else {
      // Undoes whichever side was actually charged, even if the half has
      // since flipped -- keyed off last_pitch_charged_to, not weAreBatting.
      if (game.last_pitch_charged_to === "opponent") {
        next.opponent_pitcher_pitch_count = Math.max(game.opponent_pitcher_pitch_count - 1, 0);
      } else if (game.last_pitch_charged_to === "our") {
        next.our_pitcher_pitch_count = Math.max(game.our_pitcher_pitch_count - 1, 0);
      }
      next.last_pitch_charged_to = null;
    }
  }

  if (delta === 1) {
    if (eventType === "ball") {
      next.balls = game.balls + 1;
      if (next.balls >= 4) {
        next.balls = 0;
        next.strikes = 0;
        paEnded = true;
      }
    } else if (eventType === "strike") {
      next.strikes = game.strikes + 1;
      if (next.strikes >= 3) {
        next.strikes = 0;
        next.balls = 0;
        next.outs = game.outs + 1;
        paEnded = true;
      }
    } else {
      next.balls = 0;
      next.strikes = 0;
      next.outs = game.outs + 1;
      paEnded = true;
    }

    if (next.outs >= 3) {
      next.outs = 0;
      if (game.inning_half === "top") {
        next.inning_half = "bottom";
      } else {
        next.inning_half = "top";
        next.current_inning = game.current_inning + 1;
      }
      next.runner_on_first = false;
      next.runner_on_second = false;
      next.runner_on_third = false;
    }

    if (paEnded && game.home_or_away !== null) {
      if (
        (halfAtPaStart === "top" && game.home_or_away === "away") ||
        (halfAtPaStart === "bottom" && game.home_or_away === "home")
      ) {
        if (ourLineup.length > 0) nextBatter = nextInOrder(ourLineup, game.current_batter_player_id);
      } else {
        if (opponentLineup.length > 0)
          nextOpponentBatter = nextInOrder(opponentLineup, game.current_opponent_batter_id);
      }
    }
  } else {
    if (eventType === "ball") next.balls = Math.max(game.balls - 1, 0);
    else if (eventType === "strike") next.strikes = Math.max(game.strikes - 1, 0);
    else next.outs = Math.max(game.outs - 1, 0);
  }

  next.current_batter_player_id = nextBatter;
  next.current_opponent_batter_id = nextOpponentBatter;
  return next;
}

export function applyRunEvent(game: GameState, runs: 1 | -1, scoringTeam: "us" | "opponent"): GameState {
  return scoringTeam === "us"
    ? { ...game, our_score: Math.max(game.our_score + runs, 0) }
    : { ...game, opponent_score: Math.max(game.opponent_score + runs, 0) };
}

export function applyBaseRunner(game: GameState, base: "first" | "second" | "third", occupied: boolean): GameState {
  if (base === "first") return { ...game, runner_on_first: occupied };
  if (base === "second") return { ...game, runner_on_second: occupied };
  return { ...game, runner_on_third: occupied };
}

export function applyHomeOrAway(game: GameState, value: "home" | "away"): GameState {
  return { ...game, home_or_away: value };
}

export function applyAdvanceBatter(game: GameState, ourLineup: string[]): GameState {
  return { ...game, current_batter_player_id: nextInOrder(ourLineup, game.current_batter_player_id) };
}

export function applyAdvanceOpponentBatter(game: GameState, opponentLineup: string[]): GameState {
  return { ...game, current_opponent_batter_id: nextInOrder(opponentLineup, game.current_opponent_batter_id) };
}
