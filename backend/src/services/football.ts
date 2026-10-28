import type { Pool } from "pg";
import { AdminError, logAction } from "./admin.js";

const DATA_API = "https://api.football-data.org/v4";
const RIGHTS_FLAG = "FOOTBALL_DATA_COMMERCIAL_RIGHTS_CONFIRMED";
let feedCache: { expiresAt: number; value: Awaited<ReturnType<typeof fetchFootballData>> } | null = null;
let feedRequest: Promise<Awaited<ReturnType<typeof fetchFootballData>>> | null = null;

function dataDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function footballPage(db: Pool, env: NodeJS.ProcessEnv = process.env) {
  const [settings, custom] = await Promise.all([
    db.query<{ enabled: boolean; wagering_enabled: boolean }>(
      `SELECT enabled, wagering_enabled FROM football_settings WHERE id = 1`
    ),
    db.query(
      `SELECT f.id, l.name AS league, l.country, h.id AS home_team_id, h.name AS home_team,
              h.logo_data_url IS NOT NULL AS home_team_has_logo,
              a.id AS away_team_id, a.name AS away_team, a.logo_data_url IS NOT NULL AS away_team_has_logo,
              f.starts_at, f.match_type, f.description, f.status, f.home_score, f.away_score, f.source, f.updated_at
         FROM football_fixtures f
         JOIN football_leagues l ON l.id = f.league_id
         JOIN football_teams h ON h.id = f.home_team_id
         JOIN football_teams a ON a.id = f.away_team_id
        WHERE f.published AND l.enabled AND f.source = 'custom'
        ORDER BY f.starts_at LIMIT 250`
    ),
  ]);
  const active = settings.rows[0]?.enabled === true;
  const configured = active && env[RIGHTS_FLAG] === "true" && !!env.FOOTBALL_DATA_API_KEY?.trim();
  const feed = !active
    ? { status: "unavailable", message: "Football information is currently disabled.", fixtures: [] }
    : configured
    ? await footballDataFeed(env.FOOTBALL_DATA_API_KEY!.trim())
    : {
      status: "unavailable",
      message: env[RIGHTS_FLAG] === "true"
        ? "Football data credentials are not configured."
        : "A commercial data license has not been confirmed. No external fixtures or scores are being displayed.",
      fixtures: [],
    };
  return {
    enabled: active,
    wagering_enabled: false,
    provider: { id: "football-data.org", status: feed.status, message: feed.message ?? null },
    leagues: active ? feed.fixtures.map((f) => ({ id: f.competitionId, name: f.league, country: f.country, source: "provider" })) : [],
    fixtures: active ? [
      ...feed.fixtures,
      ...custom.rows.map((row) => ({
        ...row,
        home_team_logo: row.home_team_has_logo ? `/api/football/teams/${row.home_team_id}/logo` : null,
        away_team_logo: row.away_team_has_logo ? `/api/football/teams/${row.away_team_id}/logo` : null,
        source: "custom",
      })),
    ] : [],
  };
}

async function footballDataFeed(token: string) {
  if (feedCache && feedCache.expiresAt > Date.now()) return feedCache.value;
  if (feedRequest) return feedRequest;
  feedRequest = fetchFootballData(token);
  try {
    const value = await feedRequest;
    feedCache = { expiresAt: Date.now() + 60_000, value };
    return value;
  } finally {
    feedRequest = null;
  }
}

async function fetchFootballData(token: string): Promise<{
  status: "connected" | "unavailable";
  message?: string;
  fixtures: Array<Record<string, unknown> & { competitionId: string; league: string; country: string }>;
}> {
  const from = dataDate(new Date(Date.now() - 864e5));
  const to = dataDate(new Date(Date.now() + 14 * 864e5));
  const url = new URL(`${DATA_API}/matches`);
  url.searchParams.set("dateFrom", from);
  url.searchParams.set("dateTo", to);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-Auth-Token": token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.error("[football/data] provider request failed: %s", (error as Error).message);
    return { status: "unavailable", message: "The football data provider could not be reached.", fixtures: [] };
  }
  if (!response.ok) {
    console.error("[football/data] provider returned HTTP %s", response.status);
    return { status: "unavailable", message: "The football data provider is temporarily unavailable.", fixtures: [] };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.error("[football/data] provider response could not be decoded: %s", (error as Error).message);
    return { status: "unavailable", message: "The football data provider returned an unreadable response.", fixtures: [] };
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { matches?: unknown }).matches)) {
    console.error("[football/data] provider response did not contain a matches list");
    return { status: "unavailable", message: "The football data provider returned an unsupported response.", fixtures: [] };
  }
  const matches = (body as { matches: unknown[] }).matches;
  const fixtures = matches.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const m = item as Record<string, unknown>;
    const competition = m.competition && typeof m.competition === "object" ? m.competition as Record<string, unknown> : {};
    const area = competition.area && typeof competition.area === "object" ? competition.area as Record<string, unknown> : {};
    const home = m.homeTeam && typeof m.homeTeam === "object" ? m.homeTeam as Record<string, unknown> : {};
    const away = m.awayTeam && typeof m.awayTeam === "object" ? m.awayTeam as Record<string, unknown> : {};
    const score = m.score && typeof m.score === "object" ? m.score as Record<string, unknown> : {};
    const fullTime = score.fullTime && typeof score.fullTime === "object" ? score.fullTime as Record<string, unknown> : {};
    if (typeof m.id !== "number" || typeof m.utcDate !== "string" ||
        typeof competition.id !== "number" || typeof competition.name !== "string" ||
        typeof home.name !== "string" || typeof away.name !== "string") return [];
    return [{
      provider_id: String(m.id),
      competitionId: String(competition.id),
      league: competition.name,
      country: typeof area.name === "string" ? area.name : "International",
      home_team: home.name,
      away_team: away.name,
      home_team_logo: trustedCrest(home.crest),
      away_team_logo: trustedCrest(away.crest),
      starts_at: m.utcDate,
      status: typeof m.status === "string" ? m.status : "SCHEDULED",
      home_score: typeof fullTime.home === "number" ? fullTime.home : null,
      away_score: typeof fullTime.away === "number" ? fullTime.away : null,
      source: "provider",
    }];
  });
  return { status: "connected", fixtures };
}

function trustedCrest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "crests.football-data.org" ? url.href : null;
  } catch {
    return null;
  }
}

function parseTeamLogo(value: unknown): { dataUrl: string | null; provided: boolean } {
  if (value === undefined) return { dataUrl: null, provided: false };
  if (value === null || value === "") return { dataUrl: null, provided: true };
  if (typeof value !== "string") throw new AdminError("invalid_team_logo", "Upload a PNG, JPEG or WebP team logo", 400);
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new AdminError("invalid_team_logo", "Upload a PNG, JPEG or WebP team logo", 400);
  const encoded = match[2];
  if (!encoded) throw new AdminError("invalid_team_logo", "Upload a PNG, JPEG or WebP team logo", 400);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 512 * 1024) throw new AdminError("team_logo_too_large", "Team logos must be 512 KB or smaller", 400);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if ((match[1] === "png" && !png) || (match[1] === "jpeg" && !jpeg) || (match[1] === "webp" && !webp)) {
    throw new AdminError("invalid_team_logo", "The uploaded file does not match its image type", 400);
  }
  return { dataUrl: value, provided: true };
}

export async function customFootballTeamLogo(db: Pool, id: string) {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<{ logo_data_url: string | null }>(
    `SELECT logo_data_url FROM football_teams WHERE id = $1 AND source = 'custom'`,
    [id]
  );
  const value = rows[0]?.logo_data_url;
  if (!value) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    console.error("[football/logo] Stored logo for team %s has an invalid data URL", id);
    throw new Error("Stored football team logo is invalid");
  }
  const encoded = match[2];
  if (!encoded) {
    console.error("[football/logo] Stored logo for team %s has an empty image", id);
    throw new Error("Stored football team logo is empty");
  }
  return { contentType: `image/${match[1]}`, bytes: Buffer.from(encoded, "base64") };
}

const cleanText = (value: unknown, label: string, max = 100) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new AdminError("invalid_field", `Enter a valid ${label} (1–${max} characters)`, 400);
  return text;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function footballAudit(db: Pool, admin: string, action: string, entityType: string, id: string | null, details: Record<string, unknown> = {}) {
  await db.query(
    `INSERT INTO football_admin_activity (admin, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [admin, action, entityType, id, JSON.stringify(details)]
  );
  await logAction(db, admin, action, id, details);
}

export async function footballManagement(db: Pool) {
  const [settings, leagues, teams, fixtures] = await Promise.all([
    db.query(`SELECT enabled, wagering_enabled, updated_by, updated_at FROM football_settings WHERE id = 1`),
    db.query(`SELECT id, name, country, enabled, created_at FROM football_leagues WHERE source = 'custom' ORDER BY country, name`),
    db.query(`SELECT id, name, country, logo_data_url IS NOT NULL AS has_logo, created_at
                FROM football_teams WHERE source = 'custom' ORDER BY country, name`),
    db.query(
      `SELECT f.id, f.league_id, l.name AS league, f.home_team_id, h.name AS home_team,
              f.away_team_id, a.name AS away_team, f.starts_at, f.match_type, f.description,
              f.status, f.home_score, f.away_score,
              f.published, f.updated_at
         FROM football_fixtures f JOIN football_leagues l ON l.id = f.league_id
         JOIN football_teams h ON h.id = f.home_team_id JOIN football_teams a ON a.id = f.away_team_id
        WHERE f.source = 'custom' ORDER BY f.starts_at DESC LIMIT 300`
    ),
  ]);
  return {
    settings: settings.rows[0] ?? { enabled: false, wagering_enabled: false },
    provider: {
      id: "football-data.org",
      api_key_configured: !!process.env.FOOTBALL_DATA_API_KEY?.trim(),
      commercial_rights_confirmed: process.env[RIGHTS_FLAG] === "true",
      odds_provider_configured: false,
    },
    leagues: leagues.rows,
    teams: teams.rows,
    fixtures: fixtures.rows,
  };
}

export async function saveFootballSettings(db: Pool, admin: string, input: Record<string, unknown>) {
  if (typeof input.enabled !== "boolean" || input.wagering_enabled === true) {
    throw new AdminError("invalid_settings", "Football must remain non-wagering; provide a valid enabled switch", 400);
  }
  await db.query(
    `UPDATE football_settings SET enabled = $1, updated_by = $2, updated_at = now() WHERE id = 1`,
    [input.enabled, admin]
  );
  await footballAudit(db, admin, input.enabled ? "football.enabled" : "football.disabled", "settings", null,
    { wagering_enabled: false });
  return { enabled: input.enabled, wagering_enabled: false };
}

export async function createFootballLeague(db: Pool, admin: string, input: Record<string, unknown>) {
  const name = cleanText(input.name, "league name");
  const country = cleanText(input.country, "country name");
  const { rows } = await db.query(
    `INSERT INTO football_leagues (name, country, source) VALUES ($1, $2, 'custom')
     RETURNING id, name, country, enabled`,
    [name, country]
  );
  await footballAudit(db, admin, "football.league.created", "league", rows[0].id, { name, country, source: "custom" });
  return rows[0];
}

export async function createFootballTeam(db: Pool, admin: string, input: Record<string, unknown>) {
  const name = cleanText(input.name, "team name");
  const country = cleanText(input.country, "country name");
  const logo = parseTeamLogo(input.logo_data_url);
  const { rows } = await db.query(
    `INSERT INTO football_teams (name, country, source, logo_data_url) VALUES ($1, $2, 'custom', $3)
     RETURNING id, name, country, logo_data_url IS NOT NULL AS has_logo`,
    [name, country, logo.dataUrl]
  );
  await footballAudit(db, admin, "football.team.created", "team", rows[0].id,
    { name, country, source: "custom", has_logo: Boolean(logo.dataUrl) });
  return rows[0];
}

export async function updateCustomFootballLeague(db: Pool, admin: string, id: string, input: Record<string, unknown>) {
  if (!UUID.test(id)) throw new AdminError("not_found", "Custom league not found", 404);
  if (typeof input.enabled !== "boolean") throw new AdminError("invalid_field", "Enabled must be true or false", 400);
  const { rows } = await db.query(
    `UPDATE football_leagues SET enabled = $2 WHERE id = $1 AND source = 'custom'
     RETURNING id, name, country, enabled`,
    [id, input.enabled]
  );
  if (!rows[0]) throw new AdminError("not_found", "Custom league not found", 404);
  await footballAudit(db, admin, input.enabled ? "football.league.enabled" : "football.league.disabled", "league", id, {});
  return rows[0];
}

export async function updateCustomFootballTeam(db: Pool, admin: string, id: string, input: Record<string, unknown>) {
  if (!UUID.test(id)) throw new AdminError("not_found", "Custom team not found", 404);
  const name = cleanText(input.name, "team name");
  const country = cleanText(input.country, "country name");
  const logo = parseTeamLogo(input.logo_data_url);
  const { rows } = await db.query(
    `UPDATE football_teams SET name = $2, country = $3,
       logo_data_url = CASE WHEN $4 THEN $5 ELSE logo_data_url END
     WHERE id = $1 AND source = 'custom'
     RETURNING id, name, country, logo_data_url IS NOT NULL AS has_logo`,
    [id, name, country, logo.provided, logo.dataUrl]
  );
  if (!rows[0]) throw new AdminError("not_found", "Custom team not found", 404);
  await footballAudit(db, admin, "football.team.updated", "team", id, { name, country, has_logo: Boolean(logo.dataUrl) });
  return rows[0];
}

export async function createCustomFootballFixture(db: Pool, admin: string, input: Record<string, unknown>) {
  const leagueId = String(input.league_id ?? "");
  const homeId = String(input.home_team_id ?? "");
  const awayId = String(input.away_team_id ?? "");
  if (![leagueId, homeId, awayId].every((id) => UUID.test(id)) || homeId === awayId) {
    throw new AdminError("invalid_match", "Choose a league and two different teams", 400);
  }
  const startsAt = new Date(String(input.starts_at ?? ""));
  if (!Number.isFinite(startsAt.getTime())) throw new AdminError("invalid_match_time", "Enter a valid kickoff date and time", 400);
  const matchType = String(input.match_type ?? "CUSTOM");
  if (!["LEAGUE", "CUP", "FRIENDLY", "CUSTOM"].includes(matchType)) {
    throw new AdminError("invalid_match_type", "Choose a valid match type", 400);
  }
  const description = String(input.description ?? "").trim().slice(0, 500);
  const eligible = await db.query(
    `SELECT (SELECT count(*) FROM football_leagues WHERE id = $1 AND source = 'custom') AS league,
            (SELECT count(*) FROM football_teams WHERE id = $2 AND source = 'custom') AS home,
            (SELECT count(*) FROM football_teams WHERE id = $3 AND source = 'custom') AS away`,
    [leagueId, homeId, awayId]
  );
  const found = eligible.rows[0];
  if (Number(found.league) !== 1 || Number(found.home) !== 1 || Number(found.away) !== 1) {
    throw new AdminError("custom_entities_required", "Custom matches must use custom leagues and teams", 400);
  }
  const { rows } = await db.query(
    `INSERT INTO football_fixtures (league_id, home_team_id, away_team_id, starts_at, match_type, description, source, status, published)
     VALUES ($1, $2, $3, $4, $5, $6, 'custom', 'DRAFT', false)
     RETURNING id, league_id, home_team_id, away_team_id, starts_at, match_type, description, status, published`,
    [leagueId, homeId, awayId, startsAt.toISOString(), matchType, description]
  );
  await footballAudit(db, admin, "football.custom_fixture.created", "fixture", rows[0].id, { ...rows[0], source: "custom" });
  return rows[0];
}

export async function updateCustomFootballFixture(db: Pool, admin: string, id: string, input: Record<string, unknown>) {
  if (!UUID.test(id)) throw new AdminError("not_found", "Custom match not found", 404);
  const published = input.published;
  const status = input.status;
  const scoreProvided = input.home_score !== undefined || input.away_score !== undefined;
  if (scoreProvided && (input.home_score === undefined || input.away_score === undefined)) {
    throw new AdminError("invalid_score", "Enter both team scores together", 400);
  }
  const toScore = (value: unknown) => value === "" || value === null ? null : Number(value);
  const homeScore = scoreProvided ? toScore(input.home_score) : null;
  const awayScore = scoreProvided ? toScore(input.away_score) : null;
  if ([homeScore, awayScore].some((value) => value !== null &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 99))) {
    throw new AdminError("invalid_score", "Scores must be whole numbers from 0 to 99", 400);
  }
  let startsAt: string | null = null;
  if (input.starts_at !== undefined) {
    const parsed = new Date(String(input.starts_at));
    if (!Number.isFinite(parsed.getTime())) throw new AdminError("invalid_match_time", "Enter a valid kickoff date and time", 400);
    startsAt = parsed.toISOString();
  }
  const description = input.description === undefined ? null : String(input.description).trim().slice(0, 500);
  const matchType = input.match_type === undefined ? null : String(input.match_type);
  if (matchType !== null && !["LEAGUE", "CUP", "FRIENDLY", "CUSTOM"].includes(matchType)) {
    throw new AdminError("invalid_match_type", "Choose a valid match type", 400);
  }
  if (published !== undefined && typeof published !== "boolean") {
    throw new AdminError("invalid_field", "Published must be true or false", 400);
  }
  const allowed = ["DRAFT", "SCHEDULED", "LIVE", "HALF_TIME", "FINISHED", "POSTPONED", "CANCELLED"];
  if (status !== undefined && !allowed.includes(String(status))) throw new AdminError("invalid_status", "Choose a valid match status", 400);
  const { rows } = await db.query(
    `UPDATE football_fixtures SET
       published = COALESCE($2, published),
       status = COALESCE($3, status),
       home_score = CASE WHEN $4 THEN $5 ELSE home_score END,
       away_score = CASE WHEN $4 THEN $6 ELSE away_score END,
       starts_at = COALESCE($7, starts_at),
       description = COALESCE($8, description),
       match_type = COALESCE($9, match_type),
       updated_at = now()
     WHERE id = $1 AND source = 'custom'
     RETURNING id, status, published, home_score, away_score, starts_at, updated_at`,
    [id, published ?? null, status ?? null, scoreProvided, homeScore, awayScore, startsAt, description, matchType]
  );
  if (!rows[0]) throw new AdminError("not_found", "Custom match not found", 404);
  await footballAudit(db, admin, "football.custom_fixture.updated", "fixture", id, {
    status: rows[0].status, published: rows[0].published, home_score: rows[0].home_score, away_score: rows[0].away_score,
  });
  return rows[0];
}

export async function deleteCustomFootballFixture(db: Pool, admin: string, id: string) {
  if (!UUID.test(id)) throw new AdminError("not_found", "Custom match not found", 404);
  const { rows } = await db.query(
    `DELETE FROM football_fixtures WHERE id = $1 AND source = 'custom' RETURNING id`,
    [id]
  );
  if (!rows[0]) throw new AdminError("not_found", "Custom match not found", 404);
  await footballAudit(db, admin, "football.custom_fixture.deleted", "fixture", id, {});
  return { deleted: true };
}
