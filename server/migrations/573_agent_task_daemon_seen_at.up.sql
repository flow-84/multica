-- Last time the owning daemon polled this in-flight task's status. The runtime
-- heartbeat only proves the daemon process is alive; this proves it still holds
-- the task, so the sweeper can fail a row whose daemon has lost it (MS-2563).
ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS daemon_seen_at timestamptz;
