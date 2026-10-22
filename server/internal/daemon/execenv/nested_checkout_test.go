package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// MS-2470: the agent wrote a whole plugin into a blog checkout it had placed
// inside the CRM task worktree. Finalize committed only a gitlink for it and
// then removed the worktree, deleting the uncommitted plugin with it.
func TestFinalizeKeepsWorktreeWhenNestedCheckoutHoldsUnsavedWork(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		ignored bool
	}{{name: "untracked"}, {name: "ignored", ignored: true}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := newTestRepo(t)
			wt := prepareForTest(t, repo)
			if tc.ignored {
				writeFile(t, filepath.Join(wt.Path, ".gitignore"), "blog/\n")
			}
			nested := filepath.Join(wt.Path, "blog")
			gitRun(t, wt.Path, "clone", "-q", repo, nested)
			writeFile(t, filepath.Join(nested, "plugin.php"), "finished plugin\n")
			writeFile(t, filepath.Join(wt.Path, "crm-change.txt"), "crm work\n")

			outcome, err := wt.Finalize(worktreeTestLogger())
			if err == nil || !strings.Contains(err.Error(), `"blog"`) {
				t.Fatalf("Finalize error = %v, want a refusal naming the nested checkout", err)
			}
			if outcome.PreservedPath != wt.Path || outcome.Branch != "" {
				t.Fatalf("outcome = %+v, want the worktree preserved and no branch delivered", outcome)
			}
			if got := readFile(t, filepath.Join(nested, "plugin.php")); got != "finished plugin\n" {
				t.Fatalf("nested work = %q, want it kept on disk", got)
			}
		})
	}
}

func TestFinalizeKeepsSavedNestedCheckoutOutOfTheBranch(t *testing.T) {
	t.Parallel()
	repo := newTestRepo(t)
	wt := prepareForTest(t, repo)
	// A clone sitting on its pushed origin/main holds nothing of its own.
	gitRun(t, wt.Path, "clone", "-q", repo, filepath.Join(wt.Path, "blog"))
	writeFile(t, filepath.Join(wt.Path, "crm-change.txt"), "crm work\n")

	outcome, err := wt.Finalize(worktreeTestLogger())
	if err != nil {
		t.Fatalf("Finalize: %v", err)
	}
	if !outcome.AutoCommitted {
		t.Fatal("the agent's own change was not committed")
	}
	tree := gitRun(t, repo, "ls-tree", "--name-only", outcome.Branch)
	if strings.Contains(tree, "blog") {
		t.Fatalf("delivered branch records the nested checkout as a gitlink:\n%s", tree)
	}
	if !strings.Contains(tree, "crm-change.txt") {
		t.Fatalf("delivered branch is missing the agent's change:\n%s", tree)
	}
}

func TestFindCheckoutsWithUnsavedWork(t *testing.T) {
	t.Parallel()
	repo := newTestRepo(t)
	root := t.TempDir()
	clean := filepath.Join(root, "workdir", "clean")
	dirty := filepath.Join(root, "workdir", "dirty")
	unpushed := filepath.Join(root, "worktree", "unpushed")
	for _, dir := range []string{clean, dirty, unpushed} {
		gitRun(t, root, "clone", "-q", repo, dir)
	}
	writeFile(t, filepath.Join(dirty, "draft.txt"), "draft\n")
	writeFile(t, filepath.Join(unpushed, "local.txt"), "local\n")
	gitRun(t, unpushed, "add", "local.txt")
	gitRun(t, unpushed, "commit", "-qm", "local only")
	// A dependency tree is never scanned, even if it contains a checkout.
	if err := os.MkdirAll(filepath.Join(root, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, root, "clone", "-q", repo, filepath.Join(root, "node_modules", "dep"))
	writeFile(t, filepath.Join(root, "node_modules", "dep", "x.txt"), "x\n")

	got := FindCheckoutsWithUnsavedWork(root, 3)
	if len(got) != 2 || got[0] != dirty || got[1] != unpushed {
		t.Fatalf("checkouts with unsaved work = %v, want [%s %s]", got, dirty, unpushed)
	}
}
