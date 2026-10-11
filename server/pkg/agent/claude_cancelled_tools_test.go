package agent

import (
	"context"
	"log/slog"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

const claudeCancelledToolResultLine = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","is_error":true,"content":"The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."}]}}`

func runFakeClaude(t *testing.T, script string, opts ExecOptions) Result {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	fakePath := filepath.Join(t.TempDir(), "claude")
	writeTestExecutable(t, fakePath, []byte("#!/bin/sh\n"+script))

	backend, err := New("claude", Config{
		ExecutablePath: fakePath,
		Env:            map[string]string{"IS_SANDBOX": "1"},
		Logger:         slog.Default(),
	})
	if err != nil {
		t.Fatalf("new claude backend: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if opts.Timeout == 0 {
		opts.Timeout = 5 * time.Second
	}
	session, err := backend.Execute(ctx, "prompt", opts)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	go func() {
		for range session.Messages {
		}
	}()
	select {
	case result, ok := <-session.Result:
		if !ok {
			t.Fatal("result channel closed without a value")
		}
		return result
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for result")
	}
	return Result{}
}

func TestCountClaudeCancelledToolResults(t *testing.T) {
	t.Parallel()

	cancelText := claudeToolCancelledText + " STOP what you are doing and wait for the user to tell you how to proceed."
	results, cancelled := countClaudeCancelledToolResults(mustMarshal(t, claudeMessageContent{
		Role: "user",
		Content: []claudeContentBlock{
			{Type: "tool_result", ToolUseID: "a", Content: mustMarshal(t, cancelText)},
			{Type: "tool_result", ToolUseID: "b", Content: mustMarshal(t, []claudeContentBlock{{Type: "text", Text: cancelText}})},
			{Type: "tool_result", ToolUseID: "c", Content: mustMarshal(t, "ok")},
			{Type: "text", Text: cancelText},
		},
	}))
	if results != 3 || cancelled != 2 {
		t.Fatalf("got results=%d cancelled=%d, want 3 and 2", results, cancelled)
	}
}

// MS-2094: on --resume Claude first runs a turn for the orphaned background
// tasks of the previous process and emits its own result. Closing stdin on
// that result left the prompt turn without a way to answer SDK callbacks, and
// Claude cancelled every tool call. The fake fails unless its control request,
// sent after the notification result, is still answered.
func TestClaudeExecuteKeepsStdinOpenAfterTaskNotificationResult(t *testing.T) {
	t.Parallel()

	result := runFakeClaude(t, `IFS= read -r _
echo '{"type":"system","subtype":"init","session_id":"sess-orphan"}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":"","session_id":"sess-orphan","origin":{"kind":"task-notification"}}'
echo '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"true"}}}'
if ! IFS= read -r reply; then
  echo '{"type":"result","subtype":"error","is_error":true,"result":"stdin closed before the prompt turn","session_id":"sess-orphan"}'
  exit 0
fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-orphan"}'
`, ExecOptions{ResumeSessionID: "sess-orphan"})

	if result.Status != "completed" || result.Output != "done" {
		t.Fatalf("result = %+v, want the prompt turn's answer", result)
	}
	if result.RetireSession {
		t.Fatal("a healthy run must not retire its session")
	}
}

func TestClaudeExecuteFailsRunWhereEveryToolCallWasCancelled(t *testing.T) {
	t.Parallel()

	result := runFakeClaude(t, `IFS= read -r _
echo '{"type":"system","subtype":"init","session_id":"sess-cancelled"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"Bash","input":{"command":"git status"}}]}}'
cat <<'EOF'
`+claudeCancelledToolResultLine+`
EOF
echo '{"type":"result","subtype":"success","is_error":false,"result":"Every tool call was rejected.","session_id":"sess-cancelled"}'
`, ExecOptions{ResumeSessionID: "sess-cancelled"})

	if result.Status != "failed" || result.Output != "" {
		t.Fatalf("result = %+v, want a failed run without output", result)
	}
	if !result.RetireSession || result.SessionID != "sess-cancelled" {
		t.Fatalf("result = %+v, want the session reported and retired", result)
	}
	if result.ResumeRejected {
		t.Fatal("the resume itself worked; it must not be reported as rejected")
	}
}

func TestClaudeExecuteKeepsRunWithSomeCancelledToolCalls(t *testing.T) {
	t.Parallel()

	result := runFakeClaude(t, `IFS= read -r _
echo '{"type":"system","subtype":"init","session_id":"sess-partial"}'
cat <<'EOF'
`+claudeCancelledToolResultLine+`
EOF
echo '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-2","content":"ok"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-partial"}'
`, ExecOptions{})

	if result.Status != "completed" || result.Output != "done" || result.RetireSession {
		t.Fatalf("result = %+v, want a normal completion", result)
	}
}
