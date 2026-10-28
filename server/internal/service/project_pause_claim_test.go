package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestPausedProjectHoldsQueuedTasks covers the paused-project fence: a queued
// task whose issue belongs to a paused project is neither listed as a claim
// candidate nor claimed, and becomes claimable once the project resumes.
func TestPausedProjectHoldsQueuedTasks(t *testing.T) {
	pool := newResolveOriginatorPool(t)
	ctx := context.Background()
	q := db.New(pool)
	workspaceID, _, agentID, issueID := seedAttributionFixture(t, pool)

	var runtimeID, projectID string
	if err := pool.QueryRow(ctx, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID); err != nil {
		t.Fatalf("read agent runtime: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO project (workspace_id, title, status) VALUES ($1, 'Paused', 'paused') RETURNING id
	`, workspaceID).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE issue SET project_id = $1 WHERE id = $2`, projectID, issueID); err != nil {
		t.Fatalf("attach issue to project: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agent_runtime SET status = 'online', last_seen_at = now() WHERE id = $1`, runtimeID); err != nil {
		t.Fatalf("refresh runtime: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		pool.Exec(context.Background(), `UPDATE issue SET project_id = NULL WHERE id = $1`, issueID)
		pool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID)
	})

	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority)
		VALUES ($1, $2, $3, 'queued', 0)
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("insert queued task: %v", err)
	}

	claim := func() (db.AgentTaskQueue, error) {
		return q.ClaimAgentTask(ctx, db.ClaimAgentTaskParams{
			AgentID:          util.MustParseUUID(agentID),
			RuntimeID:        util.MustParseUUID(runtimeID),
			PrepareLeaseSecs: 60,
			RuntimeStaleSecs: RuntimeClaimFreshnessSeconds,
		})
	}
	candidates := func() int {
		t.Helper()
		single, err := q.ListQueuedClaimCandidatesByRuntime(ctx, util.MustParseUUID(runtimeID))
		if err != nil {
			t.Fatalf("list candidates: %v", err)
		}
		batch, err := q.ListQueuedClaimCandidatesByRuntimes(ctx, []pgtype.UUID{util.MustParseUUID(runtimeID)})
		if err != nil {
			t.Fatalf("list batch candidates: %v", err)
		}
		if len(single) != len(batch) {
			t.Fatalf("candidate lists disagree: single=%d batch=%d", len(single), len(batch))
		}
		return len(single)
	}

	if n := candidates(); n != 0 {
		t.Fatalf("paused project: candidates = %d, want 0", n)
	}
	if _, err := claim(); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("paused project: ClaimAgentTask error = %v, want no rows", err)
	}
	held, err := q.ListQueuedTasksForProject(ctx, util.MustParseUUID(projectID))
	if err != nil || len(held) != 1 {
		t.Fatalf("ListQueuedTasksForProject = %d tasks, err %v; want 1", len(held), err)
	}

	if _, err := pool.Exec(ctx, `UPDATE project SET status = 'in_progress' WHERE id = $1`, projectID); err != nil {
		t.Fatalf("resume project: %v", err)
	}
	if n := candidates(); n != 1 {
		t.Fatalf("resumed project: candidates = %d, want 1", n)
	}
	claimed, err := claim()
	if err != nil {
		t.Fatalf("resumed project claim: %v", err)
	}
	if util.UUIDToString(claimed.ID) != taskID {
		t.Fatalf("claimed task = %s, want %s", util.UUIDToString(claimed.ID), taskID)
	}
}
