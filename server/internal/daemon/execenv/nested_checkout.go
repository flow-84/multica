package execenv

import (
	"os"
	"path/filepath"
	"strings"
)

// nestedCheckouts lists git checkouts sitting untracked or ignored inside
// worktreePath, relative to it — typically a repository `multica repo checkout`
// placed in the task's working directory. Git never descends into them, so the
// task branch can at most record a gitlink, never their content.
func nestedCheckouts(worktreePath string) ([]string, error) {
	out, err := runGitStdout(worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching")
	if err != nil {
		return nil, err
	}
	var checkouts []string
	for _, entry := range strings.Split(out, "\x00") {
		if len(entry) < 4 || (!strings.HasPrefix(entry, "?? ") && !strings.HasPrefix(entry, "!! ")) || !strings.HasSuffix(entry, "/") {
			continue
		}
		rel := strings.TrimSuffix(entry[3:], "/")
		if _, err := os.Lstat(filepath.Join(worktreePath, rel, ".git")); err == nil {
			checkouts = append(checkouts, rel)
		}
	}
	return checkouts, nil
}

// CheckoutHoldsUnsavedWork reports whether the git checkout at dir carries work
// that exists nowhere else: uncommitted changes, or commits no remote-tracking
// ref reaches. Deleting such a directory loses that work, so anything that
// cannot be checked counts as unsaved.
func CheckoutHoldsUnsavedWork(dir string) bool {
	if out, err := runGitStdout(dir, "status", "--porcelain"); err != nil || strings.TrimSpace(out) != "" {
		return true
	}
	if _, err := runGitTrimmed(dir, "rev-parse", "--verify", "HEAD"); err != nil {
		// A clean checkout without a single commit holds nothing to lose.
		return false
	}
	out, err := runGitStdout(dir, "rev-list", "-1", "HEAD", "--not", "--remotes")
	return err != nil || strings.TrimSpace(out) != ""
}

// FindCheckoutsWithUnsavedWork walks root for git checkouts (a `.git` file or
// directory) down to maxDepth levels and returns those holding unsaved work. It
// keeps descending into a checkout, because a repo checked out inside a task
// worktree is a checkout of its own, but skips regenerable dependency trees, so
// the cost stays at a few directory reads per task env.
func FindCheckoutsWithUnsavedWork(root string, maxDepth int) []string {
	var found []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil && CheckoutHoldsUnsavedWork(dir) {
			found = append(found, dir)
		}
		if depth >= maxDepth {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			switch entry.Name() {
			case "node_modules", ".next", ".turbo", ".git":
				continue
			}
			walk(filepath.Join(dir, entry.Name()), depth+1)
		}
	}
	walk(root, 0)
	return found
}
