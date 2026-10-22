package daemon

import "context"

// taskSlotLease is the execution slot one dispatched task holds from the
// daemon-wide semaphore. A task parked on a local_directory path mutex hands
// its slot back for the length of the wait and takes one again before it does
// any further work, so tasks queued behind a busy directory never count
// against MaxConcurrentTasks and cannot keep tasks bound for other
// directories in `queued`.
//
// A lease belongs to the goroutine running its task; it is not safe for
// concurrent use. All methods are nil-safe so code paths reached without a
// lease (direct handleTask calls in tests) keep their previous behavior.
type taskSlotLease struct {
	sem    chan int
	wakeup chan struct{}
	slot   int
	held   bool
}

func newTaskSlotLease(sem chan int, wakeup chan struct{}, slot int) *taskSlotLease {
	return &taskSlotLease{sem: sem, wakeup: wakeup, slot: slot, held: true}
}

// currentSlot returns the slot index the task holds now, or fallback without
// a lease. The index can change across a park/resume cycle.
func (l *taskSlotLease) currentSlot(fallback int) int {
	if l == nil {
		return fallback
	}
	return l.slot
}

// park returns the slot to the semaphore and wakes the poller so it can claim
// work for it right away.
func (l *taskSlotLease) park() {
	if l == nil || !l.held {
		return
	}
	l.held = false
	l.sem <- l.slot
	signalPollerWakeup(l.wakeup)
}

// resume takes a slot again after park. It returns immediately when the slot
// is still held, and blocks until a slot frees up or ctx ends otherwise.
func (l *taskSlotLease) resume(ctx context.Context) error {
	if l == nil || l.held {
		return nil
	}
	select {
	case s := <-l.sem:
		l.slot = s
		l.held = true
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// release returns the slot for good when the task ends. A lease that is
// parked at that point has nothing to return.
func (l *taskSlotLease) release() {
	if l == nil || !l.held {
		return
	}
	l.held = false
	l.sem <- l.slot
}

type taskSlotLeaseKey struct{}

func withTaskSlotLease(ctx context.Context, l *taskSlotLease) context.Context {
	return context.WithValue(ctx, taskSlotLeaseKey{}, l)
}

func taskSlotLeaseFrom(ctx context.Context) *taskSlotLease {
	l, _ := ctx.Value(taskSlotLeaseKey{}).(*taskSlotLease)
	return l
}

// taskSlotsInUse reports how many execution slots are taken, for /health.
func (d *Daemon) taskSlotsInUse() int64 {
	sem := d.taskSlots.Load()
	if sem == nil {
		return 0
	}
	return int64(cap(*sem) - len(*sem))
}
