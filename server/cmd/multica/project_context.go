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
		// Like daemonTaskContextMarkerPath, anything other than a readable,
		// parseable file is treated as "no signal here" and we keep walking up.
		if data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(execenv.ProjectResourcesRelPath))); err == nil {
			var pc projectContextFile
			if json.Unmarshal(data, &pc) == nil && pc.ProjectID != "" {
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
