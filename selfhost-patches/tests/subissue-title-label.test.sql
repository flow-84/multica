-- Checks fl0w_subissue_title from ../subissue-title-label.sql. apply.sh runs it right after the
-- patch inside one rolled-back transaction and only applies the patch when it passes.
DO $$
DECLARE
  c record;
  got text;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('staged child',          'Fans-Liste virtualisieren', 'MS-4160', 1,    '[MS-4160 P1] Fans-Liste virtualisieren'),
    ('unstaged child',        'Doku nachziehen',           'MS-4160', NULL, '[MS-4160] Doku nachziehen'),
    ('restage replaces',      '[MS-4160 P1] Fans-Liste',   'MS-4160', 2,    '[MS-4160 P2] Fans-Liste'),
    ('reparent replaces',     '[MS-4160 P1] Fans-Liste',   'MS-4200', 1,    '[MS-4200 P1] Fans-Liste'),
    ('detach strips',         '[MS-4160 P1] Fans-Liste',   NULL,      NULL, 'Fans-Liste'),
    ('idempotent',            '[MS-4160 P1] Fans-Liste',   'MS-4160', 1,    '[MS-4160 P1] Fans-Liste'),
    ('P1: folded',            'P1: Fans-Liste',            'MS-4160', 1,    '[MS-4160 P1] Fans-Liste'),
    ('Phase 3 – folded',      'Phase 3 – Fans-Liste',      'MS-4160', 3,    '[MS-4160 P3] Fans-Liste'),
    ('Stufe 2 · folded',      'Stufe 2 · Fans-Liste',      'MS-4160', 2,    '[MS-4160 P2] Fans-Liste'),
    ('marker kept unstaged',  'Phase 3 – Fans-Liste',      'MS-4160', NULL, '[MS-4160] Phase 3 – Fans-Liste'),
    ('Plan: kept',            'Plan: Fans-Liste',          'MS-4160', 1,    '[MS-4160 P1] Plan: Fans-Liste'),
    ('marker only kept',      'P1:',                       'MS-4160', 1,    '[MS-4160 P1] P1:'),
    ('legacy hash ident',     '[#12 P1] Fans-Liste',       '#12',     2,    '[#12 P2] Fans-Liste'),
    ('foreign bracket kept',  '[WIP] Fans-Liste',          'MS-4160', 1,    '[MS-4160 P1] [WIP] Fans-Liste')
  ) AS t(name, title, parent_ident, stage, want) LOOP
    got := fl0w_subissue_title(c.title, c.parent_ident, c.stage);
    IF got IS DISTINCT FROM c.want THEN
      RAISE EXCEPTION 'fl0w_subissue_title % : got %, want %', c.name, got, c.want;
    END IF;
  END LOOP;
END $$;
