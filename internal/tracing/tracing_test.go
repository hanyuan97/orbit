package tracing

import (
	"strconv"
	"strings"
	"testing"
)

func sp(trace, span, parent, service, name string, start, end int64, status string) Span {
	return Span{
		TraceID: trace, SpanID: span, ParentID: parent, Service: service, Name: name,
		StartUnixNano: start, EndUnixNano: end, DurationMs: float64(end-start) / 1e6, Status: status,
	}
}

func TestSummarizeRootServiceAndDuration(t *testing.T) {
	s := NewStore(10)
	// root api 0..400ms, child billing 50..330ms (error), child kafka 100..112ms
	s.Ingest([]Span{
		sp("t1", "a", "", "api", "POST /api/payment", 0, 400_000_000, "ok"),
		sp("t1", "b", "a", "billing", "POST /settle", 50_000_000, 330_000_000, "error"),
		sp("t1", "c", "a", "api", "kafka produce", 100_000_000, 112_000_000, "ok"),
	})

	list, _ := s.List(0, TraceFilter{})
	if len(list) != 1 {
		t.Fatalf("want 1 trace, got %d", len(list))
	}
	g := list[0]
	if g.RootService != "api" || g.RootName != "POST /api/payment" {
		t.Errorf("root = %s %q, want api POST /api/payment", g.RootService, g.RootName)
	}
	if g.SpanCount != 3 {
		t.Errorf("spanCount = %d, want 3", g.SpanCount)
	}
	if g.Status != "error" {
		t.Errorf("status = %s, want error (a child errored)", g.Status)
	}
	if g.DurationMs != 400 {
		t.Errorf("duration = %vms, want 400 (min start to max end)", g.DurationMs)
	}
	// services in first-seen order, api then billing (kafka span is api too)
	if len(g.Services) != 2 || g.Services[0] != "api" || g.Services[1] != "billing" {
		t.Errorf("services = %v, want [api billing]", g.Services)
	}
}

func TestGetReturnsSortedSpansAndNotFound(t *testing.T) {
	s := NewStore(10)
	s.Ingest([]Span{
		sp("t1", "b", "a", "billing", "child", 50, 80, "ok"),
		sp("t1", "a", "", "api", "root", 0, 100, "ok"),
	})
	tr, ok := s.Get("t1")
	if !ok {
		t.Fatal("Get(t1) not found")
	}
	if len(tr.Spans) != 2 || tr.Spans[0].SpanID != "a" {
		t.Errorf("spans not sorted by start; got %+v", tr.Spans)
	}
	if _, ok := s.Get("nope"); ok {
		t.Error("Get(nope) should be not found")
	}
}

func TestRingBufferEvictsOldest(t *testing.T) {
	s := NewStore(2)
	s.Ingest([]Span{sp("t1", "a", "", "api", "r", 10, 20, "ok")})
	s.Ingest([]Span{sp("t2", "a", "", "api", "r", 20, 30, "ok")})
	s.Ingest([]Span{sp("t3", "a", "", "api", "r", 30, 40, "ok")})

	if _, ok := s.Get("t1"); ok {
		t.Error("t1 should have been evicted")
	}
	if _, ok := s.Get("t3"); !ok {
		t.Error("t3 should be present")
	}
	if list, _ := s.List(0, TraceFilter{}); len(list) != 2 {
		t.Errorf("trace count = %d, want 2", len(list))
	}
}

func TestReExportDedupesBySpanID(t *testing.T) {
	s := NewStore(10)
	s.Ingest([]Span{sp("t1", "a", "", "api", "r", 0, 100, "ok")})
	// same span id arrives again (re-export) — must not double-count
	s.Ingest([]Span{sp("t1", "a", "", "api", "r", 0, 100, "ok")})
	tr, _ := s.Get("t1")
	if tr.SpanCount != 1 {
		t.Errorf("spanCount = %d, want 1 (dedup by span id)", tr.SpanCount)
	}
}

func TestStatsCounts(t *testing.T) {
	s := NewStore(10)
	s.Ingest([]Span{
		sp("t1", "a", "", "api", "r", 0, 100, "ok"),
		sp("t1", "b", "a", "billing", "c", 10, 90, "ok"),
	})
	st := s.Stats()
	if st.TotalSpans != 2 || st.TraceCount != 1 {
		t.Errorf("stats = %+v, want TotalSpans=2 TraceCount=1", st)
	}
	if st.SpansPerMin != 2 {
		t.Errorf("spansPerMin = %d, want 2", st.SpansPerMin)
	}
	if st.LastReceivedUnixMs == 0 {
		t.Error("lastReceived should be set after ingest")
	}
}

func TestSubscribeReceivesSummary(t *testing.T) {
	s := NewStore(10)
	ch, cancel := s.Subscribe()
	defer cancel()
	s.Ingest([]Span{sp("t1", "a", "", "api", "r", 0, 100, "error")})
	select {
	case sum := <-ch:
		if sum.TraceID != "t1" || sum.Status != "error" {
			t.Errorf("got %+v, want t1/error", sum)
		}
	default:
		t.Fatal("expected a summary on the subscription channel")
	}
}

func TestIngestCapsSpansPerTrace(t *testing.T) {
	s := NewStore(10)
	// Push more spans into one trace than the per-trace cap allows.
	over := maxSpansPerTrace + 50
	batch := make([]Span, 0, over)
	for i := 0; i < over; i++ {
		batch = append(batch, sp("t1", spanID(i), "", "api", "r", int64(i), int64(i+1), "ok"))
	}
	s.Ingest(batch)

	tr, ok := s.Get("t1")
	if !ok {
		t.Fatal("trace missing")
	}
	if tr.SpanCount != maxSpansPerTrace {
		t.Errorf("SpanCount = %d, want cap %d", tr.SpanCount, maxSpansPerTrace)
	}
	if dropped := s.Stats().SpansDropped; dropped != int64(over-maxSpansPerTrace) {
		t.Errorf("SpansDropped = %d, want %d", dropped, over-maxSpansPerTrace)
	}
}

func TestIngestDropsOversizedAttributes(t *testing.T) {
	s := NewStore(10)
	big := sp("t1", "a", "", "api", "r", 0, 10, "ok")
	huge := make([]byte, maxAttrBytesPerSpan+1)
	for i := range huge {
		huge[i] = 'x'
	}
	big.Attributes = map[string]string{"sql": string(huge)}
	s.Ingest([]Span{big})

	tr, ok := s.Get("t1")
	if !ok || len(tr.Spans) != 1 {
		t.Fatal("span should be kept even when its attributes are dropped")
	}
	if tr.Spans[0].Attributes != nil {
		t.Errorf("oversized attributes should be dropped, got %v", tr.Spans[0].Attributes)
	}
}

func TestSetReceiverReflectedInStats(t *testing.T) {
	s := NewStore(10)
	// Unhealthy: no port, carries the error.
	s.SetReceiver(false, 0, "bind: address already in use")
	st := s.Stats()
	if st.ReceiverHealthy || st.ActualPort != 0 || st.ReceiverError == "" {
		t.Errorf("unhealthy stats wrong: %+v", st)
	}
	// Healthy: reports the bound port, clears the error.
	s.SetReceiver(true, 4319, "")
	st = s.Stats()
	if !st.ReceiverHealthy || st.ActualPort != 4319 || st.ReceiverError != "" {
		t.Errorf("healthy stats wrong: %+v", st)
	}
}

func spanID(i int) string {
	return "s" + strconv.Itoa(i)
}

func withAttrs(s Span, kv ...string) Span {
	s.Attributes = map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		s.Attributes[kv[i]] = kv[i+1]
	}
	return s
}

func traceIDs(list []TraceSummary) []string {
	ids := make([]string, len(list))
	for i, t := range list {
		ids[i] = t.TraceID
	}
	return ids
}

func TestListSearchReachesSpanNamesAndAttributes(t *testing.T) {
	s := NewStore(10)
	s.Ingest([]Span{
		withAttrs(sp("t1", "a", "", "webapp", "GET", 0, 10, "ok"), "url.path", "/item/1"),
		sp("t2", "a", "", "webapp", "GET /other", 1, 10, "ok"),
		sp("t2", "b", "a", "catalog-api", "SELECT Catalog", 2, 5, "ok"),
		sp("t3", "a", "", "worker", "tick", 3, 10, "ok"),
	})
	for _, tc := range []struct {
		search string
		want   []string
	}{
		{"ITEM/1", []string{"t1"}},         // attribute value, case-insensitive
		{"select catalog", []string{"t2"}}, // child span name
		{"worker", []string{"t3"}},         // root service
		{"catalog-api", []string{"t2"}},    // downstream service
		{"nothing-matches", []string{}},    // empty, not nil-panicking
		{"", []string{"t3", "t2", "t1"}},   // no search keeps everything, newest first
	} {
		list, _ := s.List(0, TraceFilter{Search: tc.search})
		if got := traceIDs(list); strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Errorf("search %q = %v, want %v", tc.search, got, tc.want)
		}
	}
}

func TestListServiceFilterAndLimitAfterFiltering(t *testing.T) {
	s := NewStore(10)
	s.Ingest([]Span{
		sp("t1", "a", "", "webapp", "GET /a", 1, 10, "ok"),
		sp("t1", "b", "a", "catalog-api", "GET /items", 2, 5, "ok"),
		sp("t2", "a", "", "webapp", "GET /b", 2, 10, "ok"),
		sp("t3", "a", "", "webapp", "GET /c", 3, 10, "ok"),
		sp("t3", "b", "a", "catalog-api", "GET /items", 4, 5, "ok"),
		sp("t4", "a", "", "webapp", "GET /d", 4, 10, "ok"),
	})
	list, _ := s.List(0, TraceFilter{Service: "catalog-api"})
	if got := strings.Join(traceIDs(list), ","); got != "t3,t1" {
		t.Errorf("service filter = %s, want t3,t1", got)
	}
	// The limit applies to matching traces: the two newest overall (t4, t3)
	// must not crowd out the older match.
	list, _ = s.List(2, TraceFilter{Service: "catalog-api"})
	if got := strings.Join(traceIDs(list), ","); got != "t3,t1" {
		t.Errorf("limit before filter: got %s, want t3,t1", got)
	}
}

func TestListHidesHealthTrafficExceptErrors(t *testing.T) {
	s := NewStore(10)
	s.SetHealthRule(func() HealthRule {
		return HealthRule{UserAgent: "orbit-health-probe", Paths: map[string]string{"legacy": "/healthz"}}
	})
	s.Ingest([]Span{
		// Probe recorded by user agent (any service, any path).
		withAttrs(sp("ua", "a", "", "api", "GET /health", 1, 10, "ok"), "user_agent.original", "orbit-health-probe"),
		// Service that records no user agent: matched by its configured path.
		withAttrs(sp("path", "a", "", "legacy", "GET", 2, 10, "ok"), "http.target", "/healthz?verbose=1"),
		// Same path on another service is not that service's health check.
		withAttrs(sp("other", "a", "", "api", "GET", 3, 10, "ok"), "url.path", "/healthz"),
		// A failing health endpoint stays visible.
		withAttrs(sp("failing", "a", "", "api", "GET /health", 4, 10, "error"), "http.user_agent", "orbit-health-probe"),
		sp("real", "a", "", "api", "GET /item/1", 5, 10, "ok"),
	})

	list, hidden := s.List(0, TraceFilter{})
	if got := strings.Join(traceIDs(list), ","); got != "real,failing,other" {
		t.Errorf("default list = %s, want real,failing,other", got)
	}
	if hidden != 2 {
		t.Errorf("hidden = %d, want 2", hidden)
	}

	list, hidden = s.List(0, TraceFilter{IncludeHealth: true})
	if len(list) != 5 || hidden != 0 {
		t.Errorf("include-health: %d traces, %d hidden; want 5, 0", len(list), hidden)
	}
	for _, sum := range list {
		wantHealth := sum.TraceID == "ua" || sum.TraceID == "path" || sum.TraceID == "failing"
		if sum.Health != wantHealth {
			t.Errorf("%s health = %v, want %v", sum.TraceID, sum.Health, wantHealth)
		}
	}

	// Hidden counts only traces the rest of the filter would have shown.
	if _, hidden := s.List(0, TraceFilter{Service: "legacy"}); hidden != 1 {
		t.Errorf("hidden under service filter = %d, want 1", hidden)
	}
}

func TestMatchSummarySearchesSummaryFieldsOnly(t *testing.T) {
	sum := TraceSummary{TraceID: "t", RootService: "webapp", RootName: "GET /item/1", Services: []string{"webapp", "catalog-api"}, Status: "ok"}
	cases := []struct {
		f    TraceFilter
		want bool
	}{
		{TraceFilter{}, true},
		{TraceFilter{Search: "ITEM/1"}, true},
		{TraceFilter{Search: "catalog"}, true},
		{TraceFilter{Search: "select"}, false},
		{TraceFilter{Service: "catalog-api"}, true},
		{TraceFilter{Service: "billing"}, false},
	}
	for _, c := range cases {
		if got := c.f.MatchSummary(sum); got != c.want {
			t.Errorf("%+v.MatchSummary = %v, want %v", c.f, got, c.want)
		}
	}
	health := sum
	health.Health = true
	if (TraceFilter{}).MatchSummary(health) {
		t.Error("ok health summary should be hidden by default")
	}
	if !(TraceFilter{IncludeHealth: true}).MatchSummary(health) {
		t.Error("include-health should keep it")
	}
	health.Status = "error"
	if !(TraceFilter{}).MatchSummary(health) {
		t.Error("errored health summary should stay visible")
	}
}
