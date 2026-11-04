package tracing

import (
	"strings"
)

// HealthRule identifies Orbit's own health-probe traffic by its root span.
// The store does not know about health checks or config; the daemon builds
// the rule from the probe's User-Agent and each resource's configured HTTP
// health_check.path and hands it over through Store.SetHealthRule.
type HealthRule struct {
	// UserAgent is the token Orbit's HTTP probe sends; a root span whose
	// recorded user agent contains it is health traffic.
	UserAgent string
	// Paths maps a resource name (the service name Orbit injects as
	// OTEL_SERVICE_NAME) to its health_check.path — the fallback for services
	// whose instrumentation does not record the user agent.
	Paths map[string]string
}

// OTel semantic-convention keys, current and legacy, that instrumentations use
// for the request's user agent and path.
var (
	userAgentAttrKeys = []string{"user_agent.original", "http.user_agent"}
	pathAttrKeys      = []string{"http.route", "url.path", "http.target"}
)

func (r HealthRule) matches(root *Span) bool {
	if r.UserAgent != "" {
		for _, k := range userAgentAttrKeys {
			if strings.Contains(root.Attributes[k], r.UserAgent) {
				return true
			}
		}
	}
	want := stripQuery(r.Paths[root.Service])
	if want == "" {
		return false
	}
	for _, k := range pathAttrKeys {
		if v, ok := root.Attributes[k]; ok && stripQuery(v) == want {
			return true
		}
	}
	return false
}

func stripQuery(p string) string {
	path, _, _ := strings.Cut(p, "?")
	return path
}

// TraceFilter narrows a trace list. The zero value keeps every trace except
// non-error health traffic.
type TraceFilter struct {
	// Search is a case-insensitive substring. Store.List matches it against
	// every span's service, name and attribute values; MatchSummary can only
	// see summary fields (see there).
	Search string
	// Service keeps only traces that include this service.
	Service string
	// IncludeHealth keeps Orbit health-probe traces that would otherwise be
	// hidden. Errored health traces are never hidden: a failing health
	// endpoint is what someone debugging wants to see.
	IncludeHealth bool
}

// hidesHealth reports whether sum is health traffic this filter hides.
func (f TraceFilter) hidesHealth(sum *TraceSummary) bool {
	return !f.IncludeHealth && sum.Health && sum.Status != "error"
}

func (f TraceFilter) hasService(sum *TraceSummary) bool {
	if f.Service == "" {
		return true
	}
	for _, svc := range sum.Services {
		if svc == f.Service {
			return true
		}
	}
	return false
}

// MatchSummary applies the filter to a summary alone, for streams that carry
// no spans (`orbit trace -f`). Search reaches only the root service, root name
// and services there — span names and attributes need Store.List.
func (f TraceFilter) MatchSummary(sum TraceSummary) bool {
	if f.hidesHealth(&sum) || !f.hasService(&sum) {
		return false
	}
	if f.Search == "" {
		return true
	}
	needle := strings.ToLower(f.Search)
	if containsFold(sum.RootService, needle) || containsFold(sum.RootName, needle) {
		return true
	}
	for _, svc := range sum.Services {
		if containsFold(svc, needle) {
			return true
		}
	}
	return false
}

// matchesSpans reports whether any span's service, name or attribute value
// contains the lowered needle — a superset of what MatchSummary sees, so a
// trace found under -f is also found by the list.
func matchesSpans(spans map[string]Span, needle string) bool {
	for _, sp := range spans {
		if containsFold(sp.Service, needle) || containsFold(sp.Name, needle) {
			return true
		}
		for _, v := range sp.Attributes {
			if containsFold(v, needle) {
				return true
			}
		}
	}
	return false
}

func containsFold(s, lowerNeedle string) bool {
	return strings.Contains(strings.ToLower(s), lowerNeedle)
}
