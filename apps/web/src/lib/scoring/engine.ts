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
  runner_on_first_player_id: string | null;
  runner_on_second_player_id: string | null;
  runner_on_third_player_id: string | null;
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
  eventType: "ball" | "strike" | "out" | "foul",
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

  // Pitch-count attribution -- ball/strike/foul only, 'out' never touches it.
  if (eventType === "ball" || eventType === "strike" || eventType === "foul") {
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

        // Identity cascade first (reads the OLD booleans, still on `game`)
        // -- third depends on old first+second, second depends on old
        // first, matching the boolean cascade's dependency order. Only
        // carried when it's our half; the opponent side never gets
        // identity.
        if (weAreBatting) {
          if (game.runner_on_first && game.runner_on_second) {
            next.runner_on_third_player_id = game.runner_on_second_player_id;
          }
          if (game.runner_on_first) {
            next.runner_on_second_player_id = game.runner_on_first_player_id;
          }
          next.runner_on_first_player_id = game.current_batter_player_id;
        } else {
          next.runner_on_first_player_id = null;
          next.runner_on_second_player_id = null;
          next.runner_on_third_player_id = null;
        }

        const runScored = game.runner_on_first && game.runner_on_second && game.runner_on_third;
        next.runner_on_third = (game.runner_on_first && game.runner_on_second) || game.runner_on_third;
        next.runner_on_second = game.runner_on_first || game.runner_on_second;
        next.runner_on_first = true;

        if (runScored && game.home_or_away !== null) {
          if (weAreBatting) next.our_score = game.our_score + 1;
          else next.opponent_score = game.opponent_score + 1;
        }
      }
    } else if (eventType === "strike") {
      next.strikes = game.strikes + 1;
      if (next.strikes >= 3) {
        next.strikes = 0;
        next.balls = 0;
        next.outs = game.outs + 1;
        paEnded = true;
      }
    } else if (eventType === "foul") {
      // Only counts as a strike below 2 -- never forces a 3rd strike/out
      // on its own (real baseball's foul-bunt-with-2-strikes exception
      // isn't modeled, matching record_count_event).
      if (next.strikes < 2) next.strikes = game.strikes + 1;
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
      next.runner_on_first_player_id = null;
      next.runner_on_second_player_id = null;
      next.runner_on_third_player_id = null;
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
    else if (eventType === "foul") next.strikes = Math.max(game.strikes - 1, 0);
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

export function applyBaseRunner(
  game: GameState,
  base: "first" | "second" | "third",
  occupied: boolean,
  playerId: string | null = null
): GameState {
  const id = occupied ? playerId : null;
  if (base === "first") return { ...game, runner_on_first: occupied, runner_on_first_player_id: id };
  if (base === "second") return { ...game, runner_on_second: occupied, runner_on_second_player_id: id };
  return { ...game, runner_on_third: occupied, runner_on_third_player_id: id };
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

export type HitType = "single" | "double" | "triple" | "home_run" | "hbp";

// Mirrors record_batter_hit: single/double/triple place only the new
// batter (existing runners are left exactly where they are -- real
// advancement on a hit is situational, not a fixed rule); home_run scores
// the batter and every occupied base (the one deterministic case) and
// clears the diamond. hbp (hit by pitch) shares single's branch below --
// the same force-cascade placement rule applies to a batter forced to
// first by either a walk or a pitch.
export function applyBatterHit(
  game: GameState,
  hitType: HitType,
  ourLineup: string[],
  opponentLineup: string[]
): GameState {
  const next = { ...game };
  const weAreBatting =
    game.home_or_away !== null &&
    ((game.inning_half === "top" && game.home_or_away === "away") ||
      (game.inning_half === "bottom" && game.home_or_away === "home"));

  const batterId = weAreBatting ? game.current_batter_player_id : null;
  let runs = 0;

  if (hitType === "home_run") {
    // Deterministic: batter and every occupied base all score, bases clear.
    runs = 1;
    if (game.runner_on_first) runs += 1;
    if (game.runner_on_second) runs += 1;
    if (game.runner_on_third) runs += 1;
    next.runner_on_first = false;
    next.runner_on_second = false;
    next.runner_on_third = false;
    next.runner_on_first_player_id = null;
    next.runner_on_second_player_id = null;
    next.runner_on_third_player_id = null;
  } else if (hitType === "triple") {
    // Deterministic, same philosophy as home_run: every existing runner
    // scores, batter lands on 3rd.
    if (game.runner_on_first) runs += 1;
    if (game.runner_on_second) runs += 1;
    if (game.runner_on_third) runs += 1;
    next.runner_on_first = false;
    next.runner_on_first_player_id = null;
    next.runner_on_second = false;
    next.runner_on_second_player_id = null;
    next.runner_on_third = true;
    next.runner_on_third_player_id = batterId;
  } else if (hitType === "double") {
    // 2nd and 3rd score outright; 1st advances exactly two bases, to 3rd
    // (never colliding -- 2nd's occupant is already sent home above).
    if (game.runner_on_second) runs += 1;
    if (game.runner_on_third) runs += 1;
    next.runner_on_first = false;
    next.runner_on_first_player_id = null;
    next.runner_on_second = true;
    next.runner_on_second_player_id = batterId;
    next.runner_on_third = game.runner_on_first;
    next.runner_on_third_player_id = game.runner_on_first_player_id;
  } else {
    // single or hbp: landing base (1st) forces anyone there to 2nd,
    // cascading to 3rd (and home) as needed -- same shape as the walk's
    // force cascade.
    if (game.runner_on_first) {
      if (game.runner_on_second) {
        if (game.runner_on_third) runs += 1;
        next.runner_on_third = true;
        next.runner_on_third_player_id = game.runner_on_second_player_id;
      }
      next.runner_on_second = true;
      next.runner_on_second_player_id = game.runner_on_first_player_id;
    }
    next.runner_on_first = true;
    next.runner_on_first_player_id = batterId;
  }

  if (runs > 0 && game.home_or_away !== null) {
    if (weAreBatting) next.our_score = game.our_score + runs;
    else next.opponent_score = game.opponent_score + runs;
  }

  next.balls = 0;
  next.strikes = 0;

  if (game.home_or_away !== null) {
    if (weAreBatting) {
      if (ourLineup.length > 0) next.current_batter_player_id = nextInOrder(ourLineup, game.current_batter_player_id);
    } else {
      if (opponentLineup.length > 0)
        next.current_opponent_batter_id = nextInOrder(opponentLineup, game.current_opponent_batter_id);
    }
  }

  return next;
}

export function applySetCurrentBatter(game: GameState, playerId: string): GameState {
  return { ...game, current_batter_player_id: playerId };
}

// Mirrors move_base_runner's gameplay effect (the `reason` tag is
// stats-only metadata handled server-side, not needed for local state).
export function applyMoveBaseRunner(
  game: GameState,
  fromBase: "first" | "second" | "third",
  toBase: "second" | "third" | "home" | "out"
): GameState {
  const next = { ...game };
  const moverId =
    fromBase === "first"
      ? game.runner_on_first_player_id
      : fromBase === "second"
        ? game.runner_on_second_player_id
        : game.runner_on_third_player_id;

  if (fromBase === "first") {
    next.runner_on_first = false;
    next.runner_on_first_player_id = null;
  } else if (fromBase === "second") {
    next.runner_on_second = false;
    next.runner_on_second_player_id = null;
  } else {
    next.runner_on_third = false;
    next.runner_on_third_player_id = null;
  }

  if (toBase === "second") {
    next.runner_on_second = true;
    next.runner_on_second_player_id = moverId;
  } else if (toBase === "third") {
    next.runner_on_third = true;
    next.runner_on_third_player_id = moverId;
  } else if (toBase === "home") {
    const weAreBatting =
      game.home_or_away !== null &&
      ((game.inning_half === "top" && game.home_or_away === "away") ||
        (game.inning_half === "bottom" && game.home_or_away === "home"));
    if (game.home_or_away !== null) {
      if (weAreBatting) next.our_score = game.our_score + 1;
      else next.opponent_score = game.opponent_score + 1;
    }
  } else {
    next.outs = game.outs + 1;
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
      next.runner_on_first_player_id = null;
      next.runner_on_second_player_id = null;
      next.runner_on_third_player_id = null;
    }
  }

  return next;
}
