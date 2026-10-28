import assert from "node:assert/strict";
import test from "node:test";
import { setupWalletDb } from "./helpers/walletDb.js";
import {
  createCustomFootballFixture, createFootballLeague, createFootballTeam, footballManagement,
  customFootballTeamLogo, footballPage, saveFootballSettings, updateCustomFootballFixture, updateCustomFootballTeam,
} from "../src/services/football.js";

test("Football stays non-wagering and shows no invented provider fixtures without rights and credentials", async () => {
  const { db } = await setupWalletDb();
  const result = await footballPage(db, {});
  assert.equal(result.enabled, false);
  assert.equal(result.wagering_enabled, false);
  assert.deepEqual(result.fixtures, []);
  assert.equal(result.provider.status, "unavailable");
});

test("Admin custom events are explicit drafts and publish as custom without odds", async () => {
  const { db } = await setupWalletDb();
  const admin = "admin@example";
  const league = await createFootballLeague(db, admin, { name: "Test Cup", country: "Ghana" });
  const badge = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rN8AAAAASUVORK5CYII=";
  const home = await createFootballTeam(db, admin, { name: "North FC", country: "Ghana", logo_data_url: badge });
  const away = await createFootballTeam(db, admin, { name: "South FC", country: "Ghana" });
  const kickoff = new Date(Date.now() + 86400000).toISOString();
  const fixture = await createCustomFootballFixture(db, admin, {
    league_id: league.id,
    home_team_id: home.id,
    away_team_id: away.id,
    starts_at: kickoff,
  });
  assert.equal(fixture.status, "DRAFT");
  assert.equal(fixture.published, false);
  await saveFootballSettings(db, admin, { enabled: true });

  let page = await footballPage(db, {});
  assert.deepEqual(page.fixtures, []);
  await updateCustomFootballFixture(db, admin, String(fixture.id), {
    published: true, status: "FINISHED", home_score: 1, away_score: 0,
  });
  page = await footballPage(db, {});
  assert.equal(page.fixtures.length, 1);
  assert.equal(page.fixtures[0].source, "custom");
  assert.equal(page.fixtures[0].home_team, "North FC");
  assert.equal(page.fixtures[0].home_score, 1);
  assert.equal(page.fixtures[0].away_score, 0);
  assert.equal(page.fixtures[0].home_team_logo, `/api/football/teams/${home.id}/logo`);
  assert.equal(page.fixtures[0].away_team_logo, null);
  assert.equal("odds" in page.fixtures[0], false);

  const management = await footballManagement(db);
  assert.equal(management.fixtures.length, 1);
  assert.equal(management.settings.wagering_enabled, false);
});

test("Real-money wagering cannot be enabled through football admin settings", async () => {
  const { db } = await setupWalletDb();
  await assert.rejects(
    saveFootballSettings(db, "admin@example", { enabled: true, wagering_enabled: true }),
    /Football must remain non-wagering/
  );
});

test("Admin team logos are validated, persisted, served as images, and removable", async () => {
  const { db } = await setupWalletDb();
  const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rN8AAAAASUVORK5CYII=";
  const team = await createFootballTeam(db, "admin@example", {
    name: "Badge FC", country: "Ghana", logo_data_url: logo,
  });
  assert.equal(team.has_logo, true);
  const image = await customFootballTeamLogo(db, String(team.id));
  assert.equal(image?.contentType, "image/png");
  assert.ok((image?.bytes.length ?? 0) > 8);

  await updateCustomFootballTeam(db, "admin@example", String(team.id), {
    name: "Badge FC", country: "Ghana", logo_data_url: null,
  });
  assert.equal(await customFootballTeamLogo(db, String(team.id)), null);
  await assert.rejects(
    createFootballTeam(db, "admin@example", {
      name: "Bad Badge FC", country: "Ghana", logo_data_url: "data:image/png;base64,Zm9v",
    }),
    /does not match its image type/
  );
});
