package daemon

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/iml885203/orbit/config"
	"github.com/iml885203/orbit/internal/health"
	"github.com/iml885203/orbit/internal/tracing"
)

func TestTraceIDLineRegexp(t *testing.T) {
	const id = "0a1b02030405060708090a0b0c0d0e0f"
	re, err := traceIDLineRegexp(id)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	matches := []string{
		`{"Timestamp":"...","TraceId":"` + id + `","Level":"Error"}`,
		`lvl=INFO TraceId=` + id + ` msg=hello`,
		`trace_id=` + id,
		`{"traceId":"` + id + `"}`,
	}
	for _, line := range matches {
		if !re.MatchString(line) {
			t.Errorf("should match: %s", line)
		}
	}

	// Field-anchored: a bare mention of the id (URL, pasted text) is not a
	// join hit, and neither is a different trace's id in the field.
	nonMatches := []string{
		`GET /api/traces/` + id + ` 200`,
		`TraceId=ffff02030405060708090a0b0c0d0e0f`,
		`SpanId=` + id[:16],
	}
	for _, line := range nonMatches {
		if re.MatchString(line) {
			t.Errorf("should NOT match: %s", line)
		}
	}
}

func TestBindOTLPListener_FallsBackPastConflict(t *testing.T) {
	// Occupy the desired port, then let the binder fall back.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy: %v", err)
	}
	defer func() { _ = occupied.Close() }()
	desired := occupied.Addr().(*net.TCPAddr).Port

	ln, port, err := bindOTLPListener(desired, otlpPortFallbackTries)
	if err != nil {
		t.Fatalf("expected fallback to succeed, got %v", err)
	}
	defer func() { _ = ln.Close() }()
	if port == desired {
		t.Errorf("bound the occupied port %d instead of falling back", desired)
	}
	if port <= desired || port >= desired+otlpPortFallbackTries {
		t.Errorf("fallback port %d out of expected range (%d, %d)", port, desired, desired+otlpPortFallbackTries)
	}
}

func TestBindOTLPListener_PinnedPortDoesNotFallBack(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy: %v", err)
	}
	defer func() { _ = occupied.Close() }()
	desired := occupied.Addr().(*net.TCPAddr).Port

	// tries==1 models an explicit (pinned) port: a conflict must surface as an
	// error, not silently move.
	if _, _, err := bindOTLPListener(desired, 1); err == nil {
		t.Error("pinned port conflict should error, not fall back")
	}
}

func TestTracesListQueryParameters(t *testing.T) {
	cfg := testConfig()
	cfg.Services = map[string]*config.Service{
		"legacy": {Name: "legacy", HealthCheck: &config.HealthCheckConfig{Type: "http", Path: "/healthz"}},
	}
	srv := newTestServer(t, cfg)
	root := func(trace, service, name string, start int64, attrs map[string]string) tracing.Span {
		return tracing.Span{TraceID: trace, SpanID: "a", Service: service, Name: name,
			StartUnixNano: start, EndUnixNano: start + 10, Status: "ok", Attributes: attrs}
	}
	srv.tracing.Ingest([]tracing.Span{
		root("probe", "api", "GET /health", 1, map[string]string{"user_agent.original": health.ProbeUserAgent}),
		root("legacy-probe", "legacy", "GET", 2, map[string]string{"url.path": "/healthz"}),
		root("item", "webapp", "GET", 3, map[string]string{"url.path": "/item/1"}),
		root("other", "api", "GET /other", 4, nil),
	})

	list := func(query string) ([]string, string) {
		t.Helper()
		rec := httptest.NewRecorder()
		srv.handleTracesList(rec, httptest.NewRequest(http.MethodGet, "/api/traces"+query, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", query, rec.Code)
		}
		// The body stays a bare array of summaries.
		var got []tracing.TraceSummary
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: body is not a summary array: %v", query, err)
		}
		ids := make([]string, len(got))
		for i, s := range got {
			ids[i] = s.TraceID
		}
		return ids, rec.Header().Get(HiddenHealthTracesHeader)
	}

	for _, tc := range []struct {
		query, wantIDs, wantHidden string
	}{
		{"", "other,item", "2"},
		{"?include_health=1", "other,item,legacy-probe,probe", "0"},
		{"?search=item/1", "item", "0"},
		{"?service=api", "other", "1"},
		{"?service=api&include_health=true&limit=1", "other", "0"},
	} {
		ids, hidden := list(tc.query)
		if got := strings.Join(ids, ","); got != tc.wantIDs || hidden != tc.wantHidden {
			t.Errorf("%q: ids=%s hidden=%s, want ids=%s hidden=%s", tc.query, got, hidden, tc.wantIDs, tc.wantHidden)
		}
	}

	rec := httptest.NewRecorder()
	srv.handleTracesList(rec, httptest.NewRequest(http.MethodGet, "/api/traces?include_health=yes", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("include_health=yes: status %d, want 400 rather than silently hiding", rec.Code)
	}
}
