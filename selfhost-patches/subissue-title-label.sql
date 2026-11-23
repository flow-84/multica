-- fl0w 24.11.2026 (MS-4310): Unterkarten und Phasen tragen ihre Elternkarte und Stufe im Titel,
-- z. B. "[MS-4160 P1] Fans-Liste virtualisieren". Ohne das sah eine Phase auf dem Board aus wie
-- eine eigene Karte und wurde von Hand angestossen. Die Beschriftung sitzt in der Datenbank, weil
-- jeder Weg (Agenten-CLI, Claude-Connector vom Handy, Terminal, Oberflaeche) hier durchkommt und
-- das Backend-Image unveraendert vom Original kommt. Idempotent, wird von
-- ~/.multica/update-selfhost.sh nach jedem Update erneut angewendet.
--
-- Regeln:
--   * Anlegen oder Aendern mit Elternkarte: "[<Eltern-Kennung> P<Stufe>] <Titel>", ohne Stufe
--     "[<Eltern-Kennung>] <Titel>". Ein vorhandenes Etikett wird ersetzt, nie gestapelt.
--   * Ein von Hand geschriebenes "P1:", "Phase 2 -", "Stufe 3 ·" am Anfang faellt weg, wenn die
--     Stufe gesetzt ist (steht dann schon im Etikett).
--   * Elternkarte entfernt: Etikett wird entfernt. Karten ohne Elternkarte bleiben unberuehrt.
--   * Aenderungen, die weder Titel noch Elternkarte noch Stufe betreffen, fassen den Titel nicht an;
--     bestehende Unterkarten bekommen das Etikett also erst bei der naechsten solchen Aenderung.
--
-- Bekannte Grenze: Die Doppelkarten-Sperre des Servers vergleicht den ungelabelten Titel aus der
-- Anfrage mit dem gelabelten gespeicherten Titel und erkennt eine wiederholte Unterkarte mit
-- demselben Titel deshalb nicht mehr. Gemessen 21.-24.11.2026: 50 Anlagen, 0 Treffer der Sperre.

CREATE OR REPLACE FUNCTION fl0w_subissue_title(title text, parent_ident text, stage integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH bare AS (
    SELECT btrim(regexp_replace(btrim(title),
      '^\[(?:[A-Za-z][A-Za-z0-9]*-|#)[0-9]+(?: P[0-9]+)?\][[:space:]]*', '')) AS t
  ), folded AS (
    SELECT CASE
      WHEN stage IS NULL THEN t
      ELSE COALESCE(NULLIF(btrim(regexp_replace(t,
        '^(?:p|phase|stage|stufe) ?[0-9]+[[:space:]]*[:·|–—-][[:space:]]*', '', 'i')), ''), t)
    END AS t FROM bare
  )
  SELECT CASE
    WHEN parent_ident IS NULL OR parent_ident = '' THEN t
    WHEN stage IS NULL THEN '[' || parent_ident || '] ' || t
    ELSE '[' || parent_ident || ' P' || stage || '] ' || t
  END FROM folded
$$;

CREATE OR REPLACE FUNCTION fl0w_subissue_title_label() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_ident text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.title IS NOT DISTINCT FROM OLD.title
     AND NEW.parent_issue_id IS NOT DISTINCT FROM OLD.parent_issue_id
     AND NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_issue_id IS NULL THEN
    -- Only strip a label this trigger wrote; a top-level issue keeps its title as typed.
    IF TG_OP = 'UPDATE' AND OLD.parent_issue_id IS NOT NULL THEN
      NEW.title := fl0w_subissue_title(NEW.title, NULL, NULL);
    END IF;
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(w.issue_prefix, '') || '-', '#') || p.number
    INTO parent_ident
    FROM issue p JOIN workspace w ON w.id = p.workspace_id
   WHERE p.id = NEW.parent_issue_id;
  IF parent_ident IS NOT NULL THEN
    NEW.title := fl0w_subissue_title(NEW.title, parent_ident, NEW.stage);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fl0w_subissue_title_label ON issue;
CREATE TRIGGER fl0w_subissue_title_label
  BEFORE INSERT OR UPDATE OF title, parent_issue_id, stage ON issue
  FOR EACH ROW EXECUTE FUNCTION fl0w_subissue_title_label();
