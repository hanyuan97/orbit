package app

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iml885203/orbit/cli"
	"github.com/iml885203/orbit/daemon"
	"github.com/iml885203/orbit/internal/envsource"
	"github.com/iml885203/orbit/internal/envsync"
)

func TestSourceHelpTeachesTheSmallCommandSet(t *testing.T) {
	command := sourceCmd()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs([]string{"--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	help := output.String()
	for _, want := range []string{
		"A source is a Git repository or local directory",
		"orbit source add company",
		"orbit source sync --all",
		"orbit switch company/development",
	} {
		if !strings.Contains(help, want) {
			t.Errorf("source help missing %q:\n%s", want, help)
		}
	}
	for _, removed := range []string{"info", "update", "set-default", "set-workspace", "clear-workspace"} {
		if _, _, err := command.Find([]string{removed}); err == nil {
			t.Errorf("removed source command %q is still available", removed)
		}
	}
}

func TestSourcePrimarySubcommandHelpExplainsBehaviorBeforeExecution(t *testing.T) {
	for _, test := range []struct {
		name string
		want []string
	}{
		{name: "add", want: []string{"Exactly one of --url or --path", "validates and synchronizes", "first source"}},
		{name: "sync", want: []string{"first source", "--all", "--dry"}},
		{name: "remove", want: []string{"running environment", "clears that selection", "Orbit chooses the", "never deletes"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := sourceCmd()
			var output bytes.Buffer
			command.SetOut(&output)
			command.SetErr(&output)
			command.SetArgs([]string{test.name, "--help"})
			if err := command.Execute(); err != nil {
				t.Fatal(err)
			}
			for _, want := range test.want {
				if !strings.Contains(output.String(), want) {
					t.Errorf("%s help missing %q:\n%s", test.name, want, output.String())
				}
			}
		})
	}
}

func TestSourceRemoveFirstMakesTheNextSourceFirst(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	registry, err := envsource.Load(envsource.RegistryPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(envsource.Source{Name: "first", Type: envsource.TypeLocal, Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(envsource.Source{Name: "second", Type: envsource.TypeLocal, Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}

	command := sourceRemoveCmd()
	command.SetArgs([]string{"first"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	reloaded, err := envsource.Load(envsource.RegistryPath(home))
	if err != nil {
		t.Fatal(err)
	}
	firstSource, err := reloaded.First()
	if err != nil || firstSource.Name != "second" {
		t.Fatalf("first after removal = %#v, %v", firstSource, err)
	}
}

func TestEnvSyncWithoutRepositoryFlagsSynchronizesFirstSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	resetEnvSyncFlags(t)
	sourceRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sourceRoot, "envs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "envs", "development.yaml"), []byte("version: \"3\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	registry, err := envsource.Load(envsource.RegistryPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(envsource.Source{Name: "local", Type: envsource.TypeLocal, Path: sourceRoot}); err != nil {
		t.Fatal(err)
	}

	command := envSyncCmd()
	var stderr bytes.Buffer
	command.SetErr(&stderr)
	if err := command.RunE(command, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "deprecated") || !strings.Contains(stderr.String(), "orbit source sync") {
		t.Fatalf("deprecation warning = %q", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(envsource.EnvsDir(home, "local"), "development.yaml")); err != nil {
		t.Fatalf("legacy command did not perform a real sync: %v", err)
	}
}

func TestLegacySourceMigrationAddsOneStructuredNotice(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	settings := daemon.LoadSettings(daemon.DefaultSettingsPath())
	if err := settings.Set("env_repo_url", "https://example.com/environments.git"); err != nil {
		t.Fatal(err)
	}
	legacyEnvs := envsDestDir()
	if err := os.MkdirAll(legacyEnvs, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyEnvs, "development.yaml"), []byte("version: \"3\"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	cli.JSONOutput = true
	t.Cleanup(func() { cli.JSONOutput = false })

	if _, err := sourceRegistry(); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := cli.WriteJSONSuccess(&output, "orbit source list --json", map[string]any{"operation": "source_list"}, nil); err != nil {
		t.Fatal(err)
	}
	envelope := decodeEnvelope(t, output.Bytes())
	if len(envelope.Notices) != 1 || envelope.Notices[0].Code != "environment_source_migrated" {
		t.Fatalf("migration notices = %#v", envelope.Notices)
	}
	data, ok := envelope.Notices[0].Data.(map[string]any)
	if !ok || data["source_name"] != "default" || data["offline"] != true || data["cached_environments"] != float64(1) {
		t.Fatalf("migration notice data = %#v", envelope.Notices[0].Data)
	}

	if _, err := sourceRegistry(); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := cli.WriteJSONSuccess(&output, "orbit source list --json", map[string]any{"operation": "source_list"}, nil); err != nil {
		t.Fatal(err)
	}
	if repeated := decodeEnvelope(t, output.Bytes()).Notices; len(repeated) != 0 {
		t.Fatalf("repeated migration notices = %#v", repeated)
	}
}

func TestEnvSyncJSONKeepsDeprecationMetadataInsideTheEnvelope(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	resetEnvSyncFlags(t)
	cli.JSONOutput = true
	sourceRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sourceRoot, "envs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "envs", "development.yaml"), []byte("version: \"3\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	registry, err := envsource.Load(envsource.RegistryPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(envsource.Source{Name: "local", Type: envsource.TypeLocal, Path: sourceRoot}); err != nil {
		t.Fatal(err)
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previousStdout := os.Stdout
	os.Stdout = write
	t.Cleanup(func() { os.Stdout = previousStdout })
	command := envSyncCmd()
	var stderr bytes.Buffer
	command.SetErr(&stderr)
	runErr := command.RunE(command, nil)
	if closeErr := write.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	os.Stdout = previousStdout
	if runErr != nil {
		t.Fatal(runErr)
	}
	var output bytes.Buffer
	if _, err := output.ReadFrom(read); err != nil {
		t.Fatal(err)
	}
	envelope := decodeEnvelope(t, output.Bytes())
	data, ok := envelope.Data.(map[string]any)
	if !ok {
		t.Fatalf("data = %#v", envelope.Data)
	}
	if data["deprecated_command"] != "orbit env sync" || data["replacement_command"] != "orbit source sync" {
		t.Fatalf("deprecation metadata = %#v", data)
	}
	if !strings.Contains(stderr.String(), "deprecated") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestLegacyEnvSyncFlagsFailWithExecutableAction(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	resetEnvSyncFlags(t)
	registry, err := envsource.Load(envsource.RegistryPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(envsource.Source{Name: "company", Type: envsource.TypeGit, URL: "https://example.com/old.git"}); err != nil {
		t.Fatal(err)
	}
	command := envSyncCmd()
	command.SetArgs([]string{"--url", "https://example.com/new repo.git", "--ref", "release candidate"})
	err = command.Execute()
	if err == nil {
		t.Fatal("legacy repository flags unexpectedly succeeded")
	}
	var output bytes.Buffer
	if writeErr := cli.WriteJSONError(&output, "orbit env sync --url ... --json", err); writeErr != nil {
		t.Fatal(writeErr)
	}
	envelope := decodeEnvelope(t, output.Bytes())
	if len(envelope.RecommendedActions) != 1 {
		t.Fatalf("recommended actions = %+v", envelope.RecommendedActions)
	}
	action := envelope.RecommendedActions[0].Command
	if strings.Contains(action, "<") || strings.Contains(action, ">") {
		t.Fatalf("recommended action contains unresolved placeholder: %q", action)
	}
	for _, want := range []string{"orbit source --help"} {
		if !strings.Contains(action, want) {
			t.Errorf("recommended action %q missing %q", action, want)
		}
	}
}

func TestEnvSyncHelpIsOnlyAMigrationBridge(t *testing.T) {
	command := envSyncCmd()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs([]string{"--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	help := output.String()
	for _, want := range []string{"Deprecated", "orbit source sync", "Old to new", "no longer mutate"} {
		if !strings.Contains(help, want) {
			t.Errorf("env sync help missing %q:\n%s", want, help)
		}
	}
	for _, removed := range []string{"use and remember", "pin and remember", "without remembering"} {
		if strings.Contains(help, removed) {
			t.Fatalf("env sync help retains removed behavior %q:\n%s", removed, help)
		}
	}
}

func resetEnvSyncFlags(t *testing.T) {
	t.Helper()
	previous := []any{envSyncDryRun, envSyncYes, envSyncNoApply, cli.JSONOutput}
	envSyncDryRun, envSyncYes, envSyncNoApply, cli.JSONOutput = false, false, false, false
	t.Cleanup(func() {
		envSyncDryRun = previous[0].(bool)
		envSyncYes = previous[1].(bool)
		envSyncNoApply = previous[2].(bool)
		cli.JSONOutput = previous[3].(bool)
	})
}

func TestLegacyEnvSyncConflictsAreInvalidArguments(t *testing.T) {
	resetEnvSyncFlags(t)
	command := envSyncCmd()
	command.SetArgs([]string{"--url", "https://example.com/environments.git", "--path", "/tmp/environments"})
	err := command.Execute()
	if !errors.Is(err, cli.ErrInvalidArgument) {
		t.Fatalf("error = %v, want invalid argument", err)
	}
}

func TestLegacyEnvSyncDoesNotSilentlyDropEmptyOrSyncModifierFlags(t *testing.T) {
	for _, args := range [][]string{
		{"--url", ""},
		{"--url", "https://example.com/new.git", "--dry"},
		{"--ref", "release", "--no-apply"},
		{"--path", t.TempDir(), "--yes"},
	} {
		resetEnvSyncFlags(t)
		t.Setenv("ORBIT_HOME", t.TempDir())
		command := envSyncCmd()
		command.SetArgs(args)
		if err := command.Execute(); err == nil {
			t.Fatalf("legacy args %q unexpectedly succeeded", args)
		}
	}
}

func TestFailedSourceAddRetriesTheAddWithoutCredentials(t *testing.T) {
	source := envsource.Source{
		Name: "team",
		Type: envsource.TypeGit,
		URL:  "https://user:s3cret-token@github.com/example/private-env.git",
		Ref:  "main",
	}
	failure := firstSyncError(source, &envsync.CloneError{URL: source.URL, Err: errors.New("exit status 128")}, sourceAddCommand(source))

	var buf bytes.Buffer
	if err := cli.WriteJSONFailure(&buf, "orbit source add --json", nil, failure, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "s3cret-token") {
		t.Fatalf("credential leaked into JSON:\n%s", buf.String())
	}
	envelope := decodeEnvelope(t, buf.Bytes())
	if envelope.Error == nil || envelope.Error.Code != "env_repo_access" {
		t.Fatalf("error = %+v", envelope.Error)
	}
	retry := "orbit source add team --url https://github.com/example/private-env.git --ref main"
	commands := make([]string, 0, len(envelope.RecommendedActions))
	for _, action := range envelope.RecommendedActions {
		commands = append(commands, action.Command)
	}
	want := []string{retry + " --json", "gh auth login", "gh auth setup-git"}
	if strings.Join(commands, "\n") != strings.Join(want, "\n") {
		t.Fatalf("recommended_actions = %q, want %q", commands, want)
	}
	if envelope.Error.NextCommand != retry+" --json" {
		t.Fatalf("next_command = %q", envelope.Error.NextCommand)
	}
	if !strings.Contains(envelope.Error.Message, "retry `"+retry+"`") ||
		strings.Contains(envelope.Error.Message, "orbit source sync") {
		t.Fatalf("message = %q", envelope.Error.Message)
	}

	var human bytes.Buffer
	printExecutionError(&human, failure)
	if strings.Contains(human.String(), "s3cret-token") || strings.Contains(human.String(), "orbit source sync") ||
		!strings.Contains(human.String(), "Next: "+retry+"\n") {
		t.Fatalf("human output:\n%s", human.String())
	}
}

func TestFailedSourceAddWithoutGitRetriesTheAdd(t *testing.T) {
	source := envsource.Source{Name: "team", Type: envsource.TypeGit, URL: "https://git.example.com/env.git", Workspace: "/work/my app"}
	failure := firstSyncError(source, &envsync.CloneError{URL: source.URL, Err: exec.ErrNotFound}, sourceAddCommand(source))

	var buf bytes.Buffer
	if err := cli.WriteJSONFailure(&buf, "orbit source add --json", nil, failure, nil); err != nil {
		t.Fatal(err)
	}
	envelope := decodeEnvelope(t, buf.Bytes())
	retry := "orbit source add team --url https://git.example.com/env.git --workspace '/work/my app'"
	if len(envelope.RecommendedActions) != 1 || envelope.RecommendedActions[0].Command != retry+" --json" {
		t.Fatalf("recommended_actions = %+v", envelope.RecommendedActions)
	}
	if !strings.Contains(envelope.Error.Message, "Install Git") || !strings.Contains(envelope.Error.Message, "retry `"+retry+"`") {
		t.Fatalf("message = %q", envelope.Error.Message)
	}
}
