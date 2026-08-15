// Hand-written to match supabase/migrations/0001_init_schema.sql,
// 0002_rls_policies.sql, and 0003_team_join_functions.sql.
//
// Superseded by the real generated output once the Supabase CLI is linked:
//   supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts
// Re-run that after any future schema change instead of hand-editing this file.

export type TeamRole = "admin" | "family" | "fan";
export type MemberStatus = "pending" | "approved" | "rejected" | "removed";
export type EventType = "game" | "practice" | "other";
export type RsvpStatus = "yes" | "no" | "maybe" | "no_response";
export type GameStatus = "scheduled" | "live" | "final" | "postponed" | "canceled";
export type AdminInviteStatus = "pending" | "accepted" | "revoked";
export type EventVisibility = "public" | "private";
export type TeamVisibility = "public" | "private";

type TableDef<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<
        {
          id: string;
          full_name: string;
          phone: string | null;
          preferred_locale: string;
          avatar_url: string | null;
          created_at: string;
        },
        {
          id: string;
          full_name: string;
          phone?: string | null;
          preferred_locale?: string;
          avatar_url?: string | null;
          created_at?: string;
        }
      >;
      teams: TableDef<
        {
          id: string;
          name: string;
          sport: string;
          age_group: string | null;
          logo_url: string | null;
          invite_code: string;
          created_by: string | null;
          created_at: string;
          visibility: TeamVisibility;
        },
        {
          id?: string;
          name: string;
          sport?: string;
          age_group?: string | null;
          logo_url?: string | null;
          invite_code?: string;
          created_by?: string | null;
          created_at?: string;
          visibility?: TeamVisibility;
        }
      >;
      seasons: TableDef<
        {
          id: string;
          team_id: string;
          name: string;
          year: number;
          starts_on: string | null;
          ends_on: string | null;
          is_active: boolean;
          created_at: string;
        },
        {
          id?: string;
          team_id: string;
          name: string;
          year: number;
          starts_on?: string | null;
          ends_on?: string | null;
          is_active?: boolean;
          created_at?: string;
        }
      >;
      team_members: TableDef<
        {
          id: string;
          team_id: string;
          user_id: string;
          role: TeamRole;
          status: MemberStatus;
          requested_at: string;
          decided_by: string | null;
          decided_at: string | null;
        },
        {
          id?: string;
          team_id: string;
          user_id: string;
          role: TeamRole;
          status?: MemberStatus;
          requested_at?: string;
          decided_by?: string | null;
          decided_at?: string | null;
        }
      >;
      players: TableDef<
        {
          id: string;
          team_id: string;
          first_name: string;
          last_name: string;
          jersey_number: string | null;
          primary_position: string | null;
          birth_year: number | null;
          created_at: string;
        },
        {
          id?: string;
          team_id: string;
          first_name: string;
          last_name: string;
          jersey_number?: string | null;
          primary_position?: string | null;
          birth_year?: number | null;
          created_at?: string;
        }
      >;
      season_rosters: TableDef<
        { id: string; season_id: string; player_id: string; active: boolean },
        { id?: string; season_id: string; player_id: string; active?: boolean }
      >;
      family_links: TableDef<
        { id: string; team_member_id: string; player_id: string },
        { id?: string; team_member_id: string; player_id: string }
      >;
      events: TableDef<
        {
          id: string;
          team_id: string;
          season_id: string | null;
          type: EventType;
          title: string | null;
          opponent_name: string | null;
          location: string | null;
          starts_at: string;
          ends_at: string | null;
          created_by: string | null;
          created_at: string;
          visibility: EventVisibility;
        },
        {
          id?: string;
          team_id: string;
          season_id?: string | null;
          type?: EventType;
          title?: string | null;
          opponent_name?: string | null;
          location?: string | null;
          starts_at: string;
          ends_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          visibility?: EventVisibility;
        }
      >;
      event_rsvps: TableDef<
        {
          id: string;
          event_id: string;
          player_id: string;
          responded_by: string | null;
          status: RsvpStatus;
          updated_at: string;
        },
        {
          id?: string;
          event_id: string;
          player_id: string;
          responded_by?: string | null;
          status?: RsvpStatus;
          updated_at?: string;
        }
      >;
      snack_assignments: TableDef<
        {
          id: string;
          event_id: string;
          family_link_id: string | null;
          item: string | null;
          confirmed: boolean;
          created_at: string;
        },
        {
          id?: string;
          event_id: string;
          family_link_id?: string | null;
          item?: string | null;
          confirmed?: boolean;
          created_at?: string;
        }
      >;
      games: TableDef<
        {
          id: string;
          event_id: string;
          status: GameStatus;
          home_or_away: string | null;
          our_score: number;
          opponent_score: number;
          current_inning: number;
          inning_half: string | null;
          outs: number;
          balls: number;
          strikes: number;
          current_batter_player_id: string | null;
          current_pitcher_player_id: string | null;
          opponent_pitcher_name: string | null;
          opponent_pitcher_number: string | null;
          current_opponent_batter_id: string | null;
          our_pitcher_pitch_count: number;
          opponent_pitcher_pitch_count: number;
          last_pitch_charged_to: string | null;
          runner_on_first: boolean;
          runner_on_second: boolean;
          runner_on_third: boolean;
          started_at: string | null;
          ended_at: string | null;
        },
        {
          id?: string;
          event_id: string;
          status?: GameStatus;
          home_or_away?: string | null;
          our_score?: number;
          opponent_score?: number;
          current_inning?: number;
          inning_half?: string | null;
          outs?: number;
          balls?: number;
          strikes?: number;
          current_batter_player_id?: string | null;
          current_pitcher_player_id?: string | null;
          opponent_pitcher_name?: string | null;
          opponent_pitcher_number?: string | null;
          current_opponent_batter_id?: string | null;
          our_pitcher_pitch_count?: number;
          opponent_pitcher_pitch_count?: number;
          last_pitch_charged_to?: string | null;
          runner_on_first?: boolean;
          runner_on_second?: boolean;
          runner_on_third?: boolean;
          started_at?: string | null;
          ended_at?: string | null;
        }
      >;
      game_score_events: TableDef<
        {
          id: string;
          game_id: string;
          inning: number;
          inning_half: string;
          runs_scored: number;
          scoring_team: string;
          note: string | null;
          created_by: string | null;
          created_at: string;
        },
        {
          id?: string;
          game_id: string;
          inning: number;
          inning_half: string;
          runs_scored?: number;
          scoring_team: string;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        }
      >;
      game_lineup: TableDef<
        {
          id: string;
          game_id: string;
          player_id: string;
          batting_order: number;
          position: string | null;
        },
        {
          id?: string;
          game_id: string;
          player_id: string;
          batting_order: number;
          position?: string | null;
        }
      >;
      game_opponent_lineup: TableDef<
        {
          id: string;
          game_id: string;
          batting_order: number;
          display_name: string | null;
          jersey_number: string | null;
        },
        {
          id?: string;
          game_id: string;
          batting_order: number;
          display_name?: string | null;
          jersey_number?: string | null;
        }
      >;
      team_messages: TableDef<
        { id: string; team_id: string; sender_id: string | null; body: string; created_at: string },
        { id?: string; team_id: string; sender_id?: string | null; body: string; created_at?: string }
      >;
      team_season_records: TableDef<
        { season_id: string; wins: number; losses: number; ties: number; updated_at: string },
        { season_id: string; wins?: number; losses?: number; ties?: number; updated_at?: string }
      >;
      admin_invites: TableDef<
        {
          id: string;
          team_id: string;
          invited_email: string;
          token: string;
          status: AdminInviteStatus;
          invited_by: string | null;
          created_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
        },
        {
          id?: string;
          team_id: string;
          invited_email: string;
          token?: string;
          status?: AdminInviteStatus;
          invited_by?: string | null;
          created_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
        }
      >;
      push_subscriptions: TableDef<
        {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth_key: string;
          created_at: string;
        },
        {
          id?: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth_key: string;
          created_at?: string;
        }
      >;
      notification_log: TableDef<
        {
          id: string;
          user_id: string;
          event_id: string;
          notification_type: string;
          sent_at: string;
        },
        {
          id?: string;
          user_id: string;
          event_id: string;
          notification_type: string;
          sent_at?: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      is_team_admin: { Args: { p_team_id: string }; Returns: boolean };
      is_approved_member: { Args: { p_team_id: string }; Returns: boolean };
      is_approved_family: { Args: { p_team_id: string }; Returns: boolean };
      owns_player_via_family: { Args: { p_player_id: string }; Returns: boolean };
      record_score_event: {
        Args: {
          p_game_id: string;
          p_runs: number;
          p_scoring_team: string;
          p_note?: string | null;
        };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      record_count_event: {
        Args: { p_game_id: string; p_event_type: string; p_delta?: number };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      start_game: {
        Args: { p_event_id: string };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      finalize_game: {
        Args: { p_game_id: string };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      advance_batter: {
        Args: { p_game_id: string };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      set_lineup: {
        Args: { p_game_id: string; p_player_ids: string[] };
        Returns: Database["public"]["Tables"]["game_lineup"]["Row"][];
      };
      set_current_pitcher: {
        Args: { p_game_id: string; p_player_id: string | null };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      set_home_or_away: {
        Args: { p_game_id: string; p_home_or_away: string };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      advance_opponent_batter: {
        Args: { p_game_id: string };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      set_opponent_lineup: {
        Args: {
          p_game_id: string;
          p_entries: { display_name: string | null; jersey_number: string | null }[];
        };
        Returns: Database["public"]["Tables"]["game_opponent_lineup"]["Row"][];
      };
      set_opponent_pitcher: {
        Args: { p_game_id: string; p_name: string | null; p_number: string | null };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      set_base_runner: {
        Args: { p_game_id: string; p_base: string; p_occupied: boolean };
        Returns: Database["public"]["Tables"]["games"]["Row"];
      };
      recalculate_season_record: { Args: { p_season_id: string }; Returns: undefined };
      create_team: {
        Args: {
          p_name: string;
          p_sport?: string;
          p_age_group?: string | null;
          p_visibility?: TeamVisibility;
        };
        Returns: Database["public"]["Tables"]["teams"]["Row"];
      };
      get_joinable_team: {
        Args: { p_invite_code: string };
        Returns: Pick<
          Database["public"]["Tables"]["teams"]["Row"],
          "id" | "name" | "sport" | "age_group"
        >[];
      };
      get_joinable_roster: {
        Args: { p_invite_code?: string | null; p_team_id?: string | null };
        Returns: {
          player_id: string;
          first_name: string;
          last_name: string;
          jersey_number: string | null;
        }[];
      };
      request_to_join_team: {
        Args: {
          p_invite_code?: string | null;
          p_role: TeamRole;
          p_player_ids?: string[] | null;
          p_team_id?: string | null;
        };
        Returns: Database["public"]["Tables"]["team_members"]["Row"];
      };
      search_teams: {
        Args: { p_query: string };
        Returns: Pick<
          Database["public"]["Tables"]["teams"]["Row"],
          "id" | "name" | "sport" | "age_group"
        >[];
      };
      approve_join_request: {
        Args: { p_team_member_id: string };
        Returns: Database["public"]["Tables"]["team_members"]["Row"];
      };
      reject_join_request: {
        Args: { p_team_member_id: string };
        Returns: Database["public"]["Tables"]["team_members"]["Row"];
      };
      create_admin_invite: {
        Args: { p_team_id: string; p_email: string };
        Returns: Database["public"]["Tables"]["admin_invites"]["Row"];
      };
      revoke_admin_invite: {
        Args: { p_invite_id: string };
        Returns: Database["public"]["Tables"]["admin_invites"]["Row"];
      };
      get_admin_invite: {
        Args: { p_token: string };
        Returns: { team_id: string; team_name: string; invited_email: string; status: AdminInviteStatus }[];
      };
      accept_admin_invite: {
        Args: { p_token: string };
        Returns: Database["public"]["Tables"]["team_members"]["Row"];
      };
      is_team_creator: { Args: { p_team_id: string }; Returns: boolean };
      remove_team_admin: {
        Args: { p_team_member_id: string };
        Returns: Database["public"]["Tables"]["team_members"]["Row"];
      };
      upsert_push_subscription: {
        Args: { p_endpoint: string; p_p256dh: string; p_auth_key: string };
        Returns: Database["public"]["Tables"]["push_subscriptions"]["Row"];
      };
    };
    Enums: {
      team_role: TeamRole;
      member_status: MemberStatus;
      event_type: EventType;
      rsvp_status: RsvpStatus;
      game_status: GameStatus;
      // admin_invites.status is a plain text + check constraint in the DB,
      // not a real pg enum like the others above -- AdminInviteStatus is a
      // TS-side convenience type only.
    };
  };
};
