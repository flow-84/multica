package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// projectContextFile is the subset of .multica/project/resources.json the CLI
// needs. The daemon writes that file into the task working directory whenever
// a task carries project context (see execenv.writeProjectResources).
type projectContextFile struct {
	ManagedBy    string `json:"managed_by"`
	ProjectID    string `json:"project_id"`
	ProjectTitle string `json:"project_title"`
}

// activeProjectContext reads the project context the daemon wrote for this
// task, searching the working directory and its parents so the lookup still
// works from inside a repository checkout below the workdir. It returns an
// empty struct when no project context is present.
func activeProjectContext() projectContextFile {
	dir, err := os.Getwd()
	if err != nil {
		return projectContextFile{}
	}
	for {
		// Like daemonTaskContextMarkerPath: only a readable, parseable file
		// carrying the daemon's discriminator counts as project context.
		// Anything else — missing file, unreadable path, or a foreign
		// resources.json someone left in an ancestor directory — is "no
		// signal here", so we keep walking up rather than scoping a query to
		// a project the daemon never set.
		if data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(execenv.ProjectResourcesRelPath))); err == nil {
			var pc projectContextFile
			if json.Unmarshal(data, &pc) == nil &&
				pc.ManagedBy == execenv.ProjectResourcesManagedBy && pc.ProjectID != "" {
				return pc
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return projectContextFile{}
		}
		dir = parent
	}
}
