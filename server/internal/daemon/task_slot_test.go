package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestRunBatchPollerWaitingLocalDirectoryDoesNotHoldSlot pins that a task
// queued behind a busy local_directory gives its execution slot back. With
// three slots, one running task plus two tasks waiting on the same directory
// used to fill the daemon, so a task bound for another directory stayed
// unclaimed until the first one finished.
func TestRunBatchPollerWaitingLocalDirectoryDoesNotHoldSlot(t *testing.T) {
	t.Parallel()

	const daemonID = "d-test"
	resources := func(dir string) json.RawMessage {
		ref, err := json.Marshal(localDirectoryRef{LocalPath: dir, DaemonID: daemonID})
		if err != nil {
			t.Fatalf("marshal ref: %v", err)
		}
		res, err := json.Marshal([]ProjectResourceData{{ID: "r-" + dir, ResourceType: localDirectoryResourceType, ResourceRef: ref}})
		if err != nil {
			t.Fatalf("marshal resources: %v", err)
		}
		return res
	}
	sharedDir := resources(t.TempDir())
	otherDir := resources(t.TempDir())
	taskJSON := func(id, issue string, res json.RawMessage) string {
		return fmt.Sprintf(`{"id":%q,"runtime_id":"rt-1","issue_id":%q,"agent":{"name":"a"},"project_resources":%s}`, id, issue, res)
	}

	var (
		parked      atomic.Int32
		firstServed atomic.Bool
		otherServed atomic.Bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/daemon/tasks/claim"):
			switch {
			case firstServed.CompareAndSwap(false, true):
				fmt.Fprintf(w, `{"tasks":[%s,%s,%s]}`,
					taskJSON("shared-1", "i1", sharedDir),
					taskJSON("shared-2", "i2", sharedDir),
					taskJSON("shared-3", "i3", sharedDir))
			case parked.Load() == 2 && otherServed.CompareAndSwap(false, true):
				fmt.Fprintf(w, `{"tasks":[%s]}`, taskJSON("other", "i4", otherDir))
			default:
				w.Write([]byte(`{"tasks":[]}`))
			}
		case strings.HasSuffix(r.URL.Path, "/wait-local-directory"):
			parked.Add(1)
			w.Write([]byte(`{}`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	d := New(Config{
		ServerBaseURL:      srv.URL,
		DaemonID:           daemonID,
		HeartbeatInterval:  time.Hour,
		PollInterval:       20 * time.Millisecond,
		MaxConcurrentTasks: 3,
	}, slog.New(slog.NewTextHandler(noopWriter{}, nil)))
	d.workspaces["ws-1"] = &workspaceState{workspaceID: "ws-1", runtimeIDs: []string{"rt-1"}}
	d.runtimeIndex["rt-1"] = Runtime{ID: "rt-1"}
	d.cancelPollInterval = time.Hour
	d.taskSlotWait = 20 * time.Millisecond

	var (
		mu         sync.Mutex
		running    int
		maxRunning int
		slotsInUse = map[int]string{}
	)
	var holderStarted atomic.Bool
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	otherStarted := make(chan struct{})
	releaseOther := make(chan struct{})
	sharedDone := make(chan string, 2)
	d.runner = taskRunnerFunc(func(ctx context.Context, task Task, provider string, slot int, log *slog.Logger) (TaskResult, error) {
		mu.Lock()
		running++
		maxRunning = max(maxRunning, running)
		if holder, ok := slotsInUse[slot]; ok {
			t.Errorf("task %s runs on slot %d already used by %s", task.ID, slot, holder)
		}
		slotsInUse[slot] = task.ID
		mu.Unlock()
		defer func() {
			mu.Lock()
			running--
			delete(slotsInUse, slot)
			mu.Unlock()
		}()
		switch {
		case task.ID == "other":
			close(otherStarted)
			<-releaseOther
		case holderStarted.CompareAndSwap(false, true):
			// Whichever shared task won the directory keeps it busy.
			close(firstStarted)
			<-releaseFirst
		default:
			sharedDone <- task.ID
		}
		return TaskResult{Status: "completed"}, nil
	})

	sem := newTaskSlotSemaphore(d.cfg.MaxConcurrentTasks)
	wakeup := make(chan struct{}, 1)
	var taskWG sync.WaitGroup
	ctx, cancel := context.WithCancel(context.Background())
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		d.runBatchPoller(ctx, ctx, sem, wakeup, &taskWG)
	}()
	stop := func() {
		cancel()
		<-pollDone
	}

	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		stop()
		t.Fatal("first task on the shared directory did not start")
	}
	select {
	case <-otherStarted:
	case <-time.After(2 * time.Second):
		stop()
		t.Fatalf("task on another directory did not start while two tasks waited on the shared one; parked=%d", parked.Load())
	}
	if got := d.resourceWaitTasks.Load(); got != 2 {
		t.Errorf("resource wait tasks = %d, want 2", got)
	}

	// The waiters still run one at a time on the shared directory once it
	// frees up, and never push the daemon past its slot count.
	close(releaseFirst)
	for i := 0; i < 2; i++ {
		select {
		case <-sharedDone:
		case <-time.After(2 * time.Second):
			stop()
			t.Fatal("waiting task did not run after the directory was released")
		}
	}
	close(releaseOther)
	taskWG.Wait()
	stop()

	mu.Lock()
	defer mu.Unlock()
	if maxRunning > d.cfg.MaxConcurrentTasks {
		t.Fatalf("max concurrently running tasks = %d, want <= %d", maxRunning, d.cfg.MaxConcurrentTasks)
	}
	if got := len(sem); got != d.cfg.MaxConcurrentTasks {
		t.Fatalf("free slots after all tasks ended = %d, want %d", got, d.cfg.MaxConcurrentTasks)
	}
}

// TestTaskSlotLeaseParkResume pins the lease bookkeeping: a parked lease
// frees its slot, resume takes one back, and release after a cancelled
// resume does not return a slot twice.
func TestTaskSlotLeaseParkResume(t *testing.T) {
	t.Parallel()

	sem := newTaskSlotSemaphore(1)
	slot := <-sem
	wakeup := make(chan struct{}, 1)
	lease := newTaskSlotLease(sem, wakeup, slot)

	lease.park()
	if len(sem) != 1 {
		t.Fatalf("free slots after park = %d, want 1", len(sem))
	}
	if len(wakeup) != 1 {
		t.Fatal("park did not wake the poller")
	}
	other := <-sem // another task takes the freed slot

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lease.resume(ctx); err == nil {
		t.Fatal("resume with no free slot and a cancelled ctx returned nil")
	}
	lease.release()
	if len(sem) != 0 {
		t.Fatalf("release of a parked lease returned a slot; free = %d", len(sem))
	}

	sem <- other
	if err := lease.resume(context.Background()); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if got := lease.currentSlot(-1); got != other {
		t.Fatalf("slot after resume = %d, want %d", got, other)
	}
	lease.release()
	lease.release()
	if len(sem) != 1 {
		t.Fatalf("free slots after release = %d, want 1", len(sem))
	}

	var nilLease *taskSlotLease
	nilLease.park()
	nilLease.release()
	if err := nilLease.resume(context.Background()); err != nil {
		t.Fatalf("nil lease resume: %v", err)
	}
	if got := nilLease.currentSlot(7); got != 7 {
		t.Fatalf("nil lease slot = %d, want fallback 7", got)
	}
}
