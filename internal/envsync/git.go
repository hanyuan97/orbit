package envsync

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

type CloneError struct {
	URL    string
	Err    error
	Output string
}

func (e *CloneError) Error() string {
	return fmt.Sprintf("git clone %s: %v\n%s", e.DisplayURL(), e.Err, e.RedactedOutput())
}

// RedactedOutput is Git's output with the URL's credentials removed. Git
// strips userinfo itself but echoes the query, so a query left over after
// replacing the full URL is removed on its own.
func (e *CloneError) RedactedOutput() string {
	output := strings.ReplaceAll(e.Output, e.URL, e.DisplayURL())
	// The query is cut from the raw URL, not url.Parse, so a URL that does
	// not parse still loses it.
	if _, rest, found := strings.Cut(e.URL, "?"); found {
		if query, _, _ := strings.Cut(rest, "#"); query != "" {
			output = strings.ReplaceAll(output, "?"+query, "")
		}
	}
	return output
}

func (e *CloneError) Unwrap() error {
	return e.Err
}

func (e *CloneError) DisplayURL() string {
	return displayURL(e.URL)
}

func (e *CloneError) IsGitHub() bool {
	parsed, err := url.Parse(e.URL)
	if err == nil && strings.EqualFold(parsed.Hostname(), "github.com") {
		return true
	}
	return strings.HasPrefix(strings.ToLower(e.URL), "git@github.com:")
}

func (e *CloneError) ReportsAmbiguousGitHubAvailability() bool {
	if !e.IsGitHub() {
		return false
	}
	output := strings.ToLower(e.Output)
	return strings.Contains(output, "repository not found") ||
		strings.Contains(output, "repository does not exist") ||
		strings.Contains(output, "could not read username for 'https://github.com")
}

// CloneAt resolves ref to one detached commit so a branch or tag cannot move
// between fetch and checkout. An empty ref preserves Git's default-branch
// behavior for user-managed repositories that intentionally track it.
func CloneAt(url, ref, destDir string) (string, error) {
	commit, _, err := CloneAtResolved(url, ref, destDir)
	return commit, err
}

func CloneAtResolved(url, ref, destDir string) (string, string, error) {
	if ref == "" {
		cmd := exec.Command("git", "clone", "--depth", "1", "--quiet", url, destDir)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", "", &CloneError{URL: url, Err: err, Output: string(out)}
		}
		commit, err := repositoryCommit(url, destDir)
		if err != nil {
			return "", "", err
		}
		branch, branchErr := gitIn(destDir, "symbolic-ref", "--short", "HEAD")
		if branchErr != nil {
			return "", "", &CloneError{URL: url, Err: branchErr, Output: string(branch)}
		}
		return commit, strings.TrimSpace(string(branch)), nil
	}

	if err := os.MkdirAll(destDir, 0755); err != nil {
		return "", "", fmt.Errorf("create clone destination: %w", err)
	}
	if out, err := gitIn(destDir, "init", "--quiet"); err != nil {
		return "", "", &CloneError{URL: url, Err: err, Output: string(out)}
	}
	if out, err := gitIn(destDir, "fetch", "--depth", "1", "--quiet", url, ref); err != nil {
		return "", "", &CloneError{URL: url, Err: err, Output: string(out)}
	}
	if out, err := gitIn(destDir, "checkout", "--detach", "--quiet", "FETCH_HEAD"); err != nil {
		return "", "", &CloneError{URL: url, Err: err, Output: string(out)}
	}
	commit, err := repositoryCommit(url, destDir)
	return commit, ref, err
}

func repositoryCommit(url, dir string) (string, error) {
	out, err := gitIn(dir, "rev-parse", "HEAD")
	if err != nil {
		return "", &CloneError{URL: url, Err: err, Output: string(out)}
	}
	return strings.TrimSpace(string(out)), nil
}

func gitIn(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

func displayURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return stripUnparsedCredentials(raw)
	}
	remote := parsed.IsAbs() && parsed.Host != ""
	if parsed.User == nil && !(remote && (parsed.RawQuery != "" || parsed.ForceQuery)) {
		return raw
	}
	parsed.User = sshLogin(parsed.Scheme, parsed.User)
	if remote {
		parsed.RawQuery = ""
		parsed.ForceQuery = false
	}
	return parsed.String()
}

// stripUnparsedCredentials still hides credentials when url.Parse rejects the
// URL, for example a password with a bad percent-escape. Like displayURL it
// keeps an SSH username (see sshLogin). SCP-style remotes (git@host:path)
// have no "://" and carry no secret, so they pass through.
func stripUnparsedCredentials(raw string) string {
	scheme, rest, found := strings.Cut(raw, "://")
	if !found {
		return raw
	}
	authority, path, hasPath := strings.Cut(rest, "/")
	// Userinfo goes first: a password may itself contain "?".
	login := ""
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		if username, _, _ := strings.Cut(authority[:at], ":"); username != "" && isSSHScheme(scheme) {
			login = username + "@"
		}
		authority = authority[at+1:]
	}
	authority, _, inAuthority := strings.Cut(authority, "?")
	redacted := scheme + "://" + login + authority
	if hasPath && !inAuthority {
		path, _, _ = strings.Cut(path, "?")
		redacted += "/" + path
	}
	return redacted
}

// sshLogin keeps only the username of an SSH URL: it selects the account the
// server authenticates, and without it ssh logs in as the local user, which
// hosts that accept only a fixed user such as git@ reject. Any other scheme's
// username can be a token (https://<token>@host), so it goes.
func sshLogin(scheme string, user *url.Userinfo) *url.Userinfo {
	if user == nil || user.Username() == "" || !isSSHScheme(scheme) {
		return nil
	}
	return url.User(user.Username())
}

// isSSHScheme reports the schemes Git routes over its SSH transport.
func isSSHScheme(scheme string) bool {
	switch strings.ToLower(scheme) {
	case "ssh", "git+ssh", "ssh+git":
		return true
	}
	return false
}

// RedactURL removes the credentials a remote URL can carry: userinfo other
// than an SSH username, and the query of an absolute URL. Git never sends a
// query to a smart-HTTP remote intact (it appends /info/refs after it), so
// dropping it loses nothing.
func RedactURL(raw string) string {
	return displayURL(raw)
}
