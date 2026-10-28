CREATE TABLE IF NOT EXISTS football_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  wagering_enabled BOOLEAN NOT NULL DEFAULT false CHECK (wagering_enabled = false),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO football_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS football_leagues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('custom', 'provider')),
  provider_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, provider_id),
  UNIQUE (source, country, name)
);

CREATE TABLE IF NOT EXISTS football_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('custom', 'provider')),
  provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, provider_id),
  UNIQUE (source, country, name)
);

CREATE TABLE IF NOT EXISTS football_fixtures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES football_leagues(id) ON DELETE RESTRICT,
  home_team_id UUID NOT NULL REFERENCES football_teams(id) ON DELETE RESTRICT,
  away_team_id UUID NOT NULL REFERENCES football_teams(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'CUSTOM' CHECK (match_type IN ('LEAGUE', 'CUP', 'FRIENDLY', 'CUSTOM')),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('DRAFT', 'SCHEDULED', 'LIVE', 'HALF_TIME', 'FINISHED', 'POSTPONED', 'CANCELLED')),
  home_score INTEGER CHECK (home_score IS NULL OR home_score >= 0),
  away_score INTEGER CHECK (away_score IS NULL OR away_score >= 0),
  source TEXT NOT NULL CHECK (source IN ('custom', 'provider')),
  provider_id TEXT,
  published BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id),
  UNIQUE (source, provider_id)
);
CREATE INDEX IF NOT EXISTS football_fixtures_schedule_idx
  ON football_fixtures (starts_at, league_id) WHERE published;
CREATE INDEX IF NOT EXISTS football_fixtures_status_idx
  ON football_fixtures (status, starts_at) WHERE published;

CREATE TABLE IF NOT EXISTS football_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id UUID NOT NULL REFERENCES football_fixtures(id) ON DELETE RESTRICT,
  market_key TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds NUMERIC(10,4) NOT NULL CHECK (odds > 1),
  source TEXT NOT NULL CHECK (source = 'provider'),
  provider_id TEXT,
  suspended BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, market_key, selection, source, provider_id)
);
CREATE INDEX IF NOT EXISTS football_markets_fixture_idx ON football_markets (fixture_id);

CREATE TABLE IF NOT EXISTS football_admin_activity (
  id BIGSERIAL PRIMARY KEY,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS football_admin_activity_created_idx ON football_admin_activity (created_at DESC);
