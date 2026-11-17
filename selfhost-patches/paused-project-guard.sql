-- fl0w 17.11.2026: In einem pausierten Projekt startet kein Agentenlauf, egal ueber welchen Weg
-- (Zuweisung, Kommentar/@mention, Wakeup, Autopilot, Skript). Der Server prueft den Projektstatus
-- nicht; deshalb sitzt die Sperre an der einen Stelle, an der jeder Lauf entsteht: dem INSERT in
-- agent_task_queue. Der Lauf wird nicht abgewiesen (das wuerde API-Aufrufe scheitern lassen),
-- sondern sofort als cancelled mit failure_reason 'project_paused' abgelegt; der Daemon holt nur
-- queued-Laeufe ab. Idempotent, wird von ~/.multica/update-selfhost.sh nach jedem Update erneut
-- angewendet.
CREATE OR REPLACE FUNCTION fl0w_paused_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  proj_status text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'queued' THEN
    RETURN NEW;
  END IF;
  IF NEW.issue_id IS NOT NULL THEN
    SELECT p.status INTO proj_status
      FROM issue i JOIN project p ON p.id = i.project_id
     WHERE i.id = NEW.issue_id;
  ELSIF NEW.autopilot_run_id IS NOT NULL THEN
    SELECT p.status INTO proj_status
      FROM autopilot_run r JOIN autopilot a ON a.id = r.autopilot_id JOIN project p ON p.id = a.project_id
     WHERE r.id = NEW.autopilot_run_id;
  END IF;
  IF proj_status = 'paused' THEN
    NEW.status := 'cancelled';
    NEW.completed_at := now();
    NEW.failure_reason := 'project_paused';
    NEW.cancelled_by_name := 'Sperre: Projekt pausiert';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fl0w_paused_project_guard ON agent_task_queue;
CREATE TRIGGER fl0w_paused_project_guard
  BEFORE INSERT ON agent_task_queue
  FOR EACH ROW EXECUTE FUNCTION fl0w_paused_project_guard();
