package envsync

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// makeLocalRepo creates a bare-ish git repo at a tmp dir and returns the
// file:// URL. Works on any machine with git installed.
func makeLocalRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@test",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@test",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	for rel, content := range files {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	run("add", ".")
	run("commit", "-q", "-m", "seed")
	return "file://" + dir
}

func TestClone_ShallowCheckout(t *testing.T) {
	url := makeLocalRepo(t, map[string]string{
		"envs/development.yaml": "version: 1\n",
		"README.md":             "hi",
	})
	dest := t.TempDir()

	if _, err := CloneAt(url, "", dest); err != nil {
		t.Fatalf("Clone: %v", err)
	}

	// Normalize line endings: a Windows checkout with core.autocrlf=true
	// rewrites "\n" to "\r\n", which is harmless for the YAML orbit syncs.
	if got := readFile(t, filepath.Join(dest, "envs", "development.yaml")); strings.ReplaceAll(got, "\r\n", "\n") != "version: 1\n" {
		t.Errorf("development.yaml = %q", got)
	}
	if got := readFile(t, filepath.Join(dest, "README.md")); got != "hi" {
		t.Errorf("README.md = %q", got)
	}
}

func TestClone_NonExistentFails(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dest := t.TempDir()
	_, err := CloneAt("file:///nonexistent/repo", "", dest)
	if err == nil {
		t.Error("expected error for non-existent repo, got nil")
	}
	var cloneErr *CloneError
	if !errors.As(err, &cloneErr) {
		t.Fatalf("error = %T, want *CloneError", err)
	}
	if cloneErr.URL != "file:///nonexistent/repo" {
		t.Errorf("clone URL = %q", cloneErr.URL)
	}
}

func TestCloneErrorRedactsURLCredentials(t *testing.T) {
	err := &CloneError{
		URL: "https://secret-token@github.com/example/private.git",
		Err: errors.New("exit status 128"),
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("error leaks URL credentials: %v", err)
	}
	if got := err.DisplayURL(); got != "https://github.com/example/private.git" {
		t.Fatalf("display URL = %q", got)
	}
	if !err.IsGitHub() {
		t.Fatal("GitHub URL was not recognized")
	}
}

func TestCloneErrorRecognizesAmbiguousGitHubAvailability(t *testing.T) {
	tests := []struct {
		name   string
		url    string
		output string
		want   bool
	}{
		{
			name:   "GitHub repository not found",
			url:    "https://github.com/example/missing.git",
			output: "remote: Repository not found.\nfatal: repository unavailable",
			want:   true,
		},
		{
			name:   "macOS anonymous Git cannot prompt for GitHub username",
			url:    "https://github.com/example/missing.git",
			output: "fatal: could not read Username for 'https://github.com': Device not configured",
			want:   true,
		},
		{
			name:   "same prompt failure on another host is not GitHub ambiguity",
			url:    "https://git.example.com/example/missing.git",
			output: "fatal: could not read Username for 'https://git.example.com': Device not configured",
			want:   false,
		},
		{
			name:   "explicit GitHub authentication failure",
			url:    "https://github.com/example/private.git",
			output: "fatal: Authentication failed",
			want:   false,
		},
		{
			name:   "GitHub network failure",
			url:    "https://github.com/example/repo.git",
			output: "fatal: unable to access: Could not resolve host",
			want:   false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := &CloneError{URL: test.url, Output: test.output}
			if got := err.ReportsAmbiguousGitHubAvailability(); got != test.want {
				t.Fatalf("ReportsAmbiguousGitHubAvailability() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestRedactURLHidesCredentialsEvenWhenTheURLDoesNotParse(t *testing.T) {
	tests := map[string]string{
		"https://user:bad%zz-token@github.com/example/env.git": "https://github.com/example/env.git",
		"https://user:p@ss@exa mple.com":                       "https://exa mple.com",
		"git@github.com:example/env.git":                       "git@github.com:example/env.git",
		"https://user:bad%zz@host/env.git?access_token=secret": "https://host/env.git",
		"https://user:pa?ss@host/repo":                         "https://host/repo",
		"https://user:p%zz?q@host/r":                           "https://host/r",
	}
	for raw, want := range tests {
		if got := RedactURL(raw); got != want {
			t.Errorf("RedactURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestRedactURLDropsTheQueryOfARemoteURL(t *testing.T) {
	tests := map[string]string{
		"https://host/env.git?access_token=secret":         "https://host/env.git",
		"https://user:pw@host/env.git?private_token=x#ref": "https://host/env.git#ref",
		"https://host/env.git?":                            "https://host/env.git",
		"https://host/env.git":                             "https://host/env.git",
		"file:///tmp/env?x=1":                              "file:///tmp/env?x=1",
	}
	for raw, want := range tests {
		if got := RedactURL(raw); got != want {
			t.Errorf("RedactURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

// Git strips userinfo from the URL it echoes but keeps the query, so the
// echoed form never equals the configured URL.
func TestCloneErrorRedactsAQueryTokenGitEchoes(t *testing.T) {
	err := &CloneError{
		URL:    "https://user:pw@127.0.0.1:9/repo?access_token=secret",
		Err:    errors.New("exit status 128"),
		Output: "fatal: unable to access 'https://127.0.0.1:9/repo?access_token=secret/': Couldn't connect to server",
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "pw") {
		t.Fatalf("error leaks URL credentials: %v", err)
	}
	if want := "fatal: unable to access 'https://127.0.0.1:9/repo/': Couldn't connect to server"; err.RedactedOutput() != want {
		t.Fatalf("RedactedOutput() = %q, want %q", err.RedactedOutput(), want)
	}
}

func TestCloneErrorRedactsAQueryTokenWhenTheURLDoesNotParse(t *testing.T) {
	err := &CloneError{
		URL:    "https://user:bad%zz@127.0.0.1:9/repo?access_token=secret",
		Err:    errors.New("exit status 128"),
		Output: "fatal: unable to access 'https://127.0.0.1:9/repo?access_token=secret/'",
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "bad%zz") {
		t.Fatalf("error leaks URL credentials: %v", err)
	}
}

// Over SSH the username picks the account the server authenticates, so it is
// not a credential: dropping it makes later syncs log in as the local user.
// A password in an SSH URL is still one, as is any HTTP userinfo.
func TestRedactURLKeepsTheSSHUsername(t *testing.T) {
	tests := map[string]string{
		"ssh://git@host/srv/repo.git":        "ssh://git@host/srv/repo.git",
		"ssh://git:secret@host/srv/repo.git": "ssh://git@host/srv/repo.git",
		"git+ssh://git@host:2222/repo.git":   "git+ssh://git@host:2222/repo.git",
		"SSH+GIT://git:pw@host/repo.git":     "ssh+git://git@host/repo.git",
		"ssh://git:bad%zz@host/repo.git":     "ssh://git@host/repo.git",
		"ssh://host/repo.git":                "ssh://host/repo.git",
		"ssh://:pw@host/repo.git":            "ssh://host/repo.git",
		"ssh://:bad%zz@host/repo.git":        "ssh://host/repo.git",
		"https://secret-token@host/repo.git": "https://host/repo.git",
	}
	for raw, want := range tests {
		if got := RedactURL(raw); got != want {
			t.Errorf("RedactURL(%q) = %q, want %q", raw, got, want)
		}
	}
}
