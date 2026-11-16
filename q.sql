SELECT max(plan_time) last_before FROM sys_cron_executions WHERE job_name='issue_wakeup_dispatch' AND plan_time < '2026-11-09 07:06Z';
