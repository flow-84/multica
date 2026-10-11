//go:build !windows

package daemon

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRunTaskRetiresClaudeSessionWhenEveryToolCallWasCancelled pins MS-2094:
// a Claude run whose every tool call came back cancelled did no work, so it
// must not complete, and its session must be retired so the next task on the
// issue starts fresh instead of resuming a transcript full of "STOP" notices.
func TestRunTaskRetiresClaudeSessionWhenEveryToolCallWasCancelled(t *testing.T) {
	home := t.TempDir()
	redirectTestHome(t, home)

	fakeBin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --version) echo "2.1.296 (Claude Code)"; exit 0 ;;
    --help) echo "Usage: claude [options]"; exit 0 ;;
  esac
done
IFS= read -r _
echo '{"type":"system","subtype":"init","session_id":"sess-cancelled"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"Bash","input":{"command":"git status"}}]}}'
cat <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","is_error":true,"content":"The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."}]}}
EOF
echo '{"type":"result","subtype":"success","is_error":false,"result":"Every tool call was rejected.","session_id":"sess-cancelled"}'
`
	if err := os.WriteFile(fakeBin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	d := &Daemon{
		client:         NewClient(srv.URL),
		logger:         logger,
		workspaces:     make(map[string]*workspaceState),
		runtimeIndex:   map[string]Runtime{"rt-claude": {ID: "rt-claude", Provider: "claude"}},
		activeEnvRoots: make(map[string]int),
		cfg: Config{
			WorkspacesRoot: t.TempDir(),
			AgentTimeout:   5 * time.Second,
			ServerBaseURL:  srv.URL,
			Agents: map[string]AgentEntry{
				"claude": {Path: fakeBin},
			},
		},
	}
	task := Task{
		ID:             "task-claude-cancelled",
		WorkspaceID:    "ws-claude",
		RuntimeID:      "rt-claude",
		IssueID:        "issue-claude",
		AgentID:        "agent-claude",
		AuthToken:      "mat_claude_cancelled",
		PriorSessionID: "sess-cancelled",
		Agent: &AgentData{
			ID:   "agent-claude",
			Name: "claude-agent",
		},
	}

	result, err := d.runTask(context.Background(), task, "claude", 0, logger)
	if err != nil {
		t.Fatalf("runTask: %v", err)
	}
	if result.Status != "blocked" {
		t.Fatalf("Status = %q (comment %q), want blocked", result.Status, result.Comment)
	}
	if result.RetiredSessionID != "sess-cancelled" {
		t.Fatalf("RetiredSessionID = %q, want the cancelled run's session", result.RetiredSessionID)
	}
}
