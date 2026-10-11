-- The partner platform (the owner's brief, 11 October 2026): feature permissions an admin turns on or off for every
-- partner or for one, the promotional flyer generator (templates, admin-approved campaigns, uploaded images, each
-- partner's saved flyers), and partners an admin creates directly.

-- ---------------------------------------------------------------- permissions
-- Every partner feature, ON or OFF for all partners (here) and optionally for one partner (affiliates.permissions:
-- true / false overrides, a missing key follows the global setting). The backend checks these on every request.
ALTER TABLE partner_settings ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{
  "dashboard": true, "referral_links": true, "promo_codes": true, "referral_stats": true,
  "commission_withdrawals": true, "wallet_deposits": true, "flyers": true, "campaigns": true,
  "tools_mines": false, "tools_aviator": false, "tools_crash": false, "tools_other": false
}'::jsonb;
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS created_by_admin TEXT;   -- the admin who created the account, if one did

-- ---------------------------------------------------------------- flyers
-- uploaded promotional images (kept in the database: the web service has no lasting disk)
CREATE TABLE IF NOT EXISTS flyer_assets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data       BYTEA NOT NULL,
  size       INTEGER NOT NULL CHECK (size > 0 AND size <= 2000000),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the templates partners choose from: 20 built-in designs (drawn by the page) and any an admin adds
CREATE TABLE IF NOT EXISTS flyer_templates (
  id         TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  builtin    BOOLEAN NOT NULL DEFAULT false,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  sort       INTEGER NOT NULL DEFAULT 100,
  -- custom templates: the design they're based on, colours, an uploaded background, wording
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO flyer_templates (id, name, category, builtin, enabled, sort) VALUES
  ('welcome',     'Welcome bonus',            'Welcome',     true, true,   1),
  ('casino',      'Casino promotion',         'Casino',      true, true,   2),
  ('sports',      'Sports betting',           'Sports',      true, false,  3),
  ('live',        'Live casino',              'Live casino', true, true,   4),
  ('aviator',     'Aviator',                  'Games',       true, true,   5),
  ('mines',       'Mines',                    'Games',       true, true,   6),
  ('slots',       'Slots',                    'Games',       true, true,   7),
  ('register',    'Registration',             'Sign-up',     true, true,   8),
  ('mobile',      'Mobile play',              'General',     true, true,   9),
  ('weekend',     'Weekend promotion',        'Campaign',    true, true,  10),
  ('vip',         'VIP',                      'Premium',     true, true,  11),
  ('new-player',  'New player',               'Sign-up',     true, true,  12),
  ('jackpot',     'Jackpot',                  'Games',       true, true,  13),
  ('football',    'Football betting',         'Sports',      true, false, 14),
  ('basketball',  'Basketball betting',       'Sports',      true, false, 15),
  ('referral',    'Invite a friend',          'Referral',    true, true,  16),
  ('general',     'WIN B casino',             'General',     true, true,  17),
  ('special',     'Special campaign',         'Campaign',    true, true,  18),
  ('partner-ad',  'Partner advertisement',    'Partner',     true, true,  19),
  ('premium',     'Premium casino',           'Premium',     true, true,  20)
ON CONFLICT (id) DO NOTHING;

-- promotional campaigns an admin approves: the only place a bonus or offer on a flyer can come from
CREATE TABLE IF NOT EXISTS flyer_campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,                  -- for partners choosing a campaign
  headline     TEXT NOT NULL,                  -- the big words on the flyer
  offer        TEXT,                           -- the approved bonus or offer, exactly as it may be shown
  body         TEXT,                           -- a line or two of supporting text
  cta          TEXT NOT NULL DEFAULT 'Join now',
  terms        TEXT,                           -- small print
  asset_id     UUID REFERENCES flyer_assets(id) ON DELETE SET NULL,
  template_ids TEXT[],                         -- the templates it suits (NULL: any)
  active       BOOLEAN NOT NULL DEFAULT true,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- flyers a partner saved (the image is drawn again from these, with the campaign's current wording)
CREATE TABLE IF NOT EXISTS partner_flyers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE CASCADE,
  template_id  TEXT NOT NULL REFERENCES flyer_templates(id) ON DELETE CASCADE,
  campaign_id  UUID REFERENCES flyer_campaigns(id) ON DELETE SET NULL,
  size         TEXT NOT NULL,
  title        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_flyers_aff_idx ON partner_flyers(affiliate_id, created_at DESC);
