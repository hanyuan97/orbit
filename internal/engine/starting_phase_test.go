package engine

import (
	"context"
	"testing"

	"github.com/iml885203/orbit/config"
)

func TestStartingPhaseSeparatesLaunchFromReadinessWait(t *testing.T) {
	cfg := &config.Config{Services: map[string]*config.Service{"api": {Name: "api"}}}
	o := newTestOrchestrator(cfg)
	release := make(chan struct{})
	o.OnStartProcess = func(context.Context, string, int, *config.Config, *config.Service) error {
		<-release
		return nil
	}
	probing := make(chan struct{})
	o.OnHealthCheck = func(context.Context, string, int) error {
		close(probing)
		return nil
	}

	if err := o.startService(context.Background(), "api"); err != nil {
		t.Fatalf("startService: %v", err)
	}
	if got := serviceInfo(t, o, "api").StartingPhase(); got != StartingPhaseLaunching {
		t.Fatalf("phase while start hook runs = %q, want %q", got, StartingPhaseLaunching)
	}

	close(release)
	<-probing
	if got := serviceInfo(t, o, "api").StartingPhase(); got != StartingPhaseProbing {
		t.Fatalf("phase after launch = %q, want %q", got, StartingPhaseProbing)
	}

	o.mu.Lock()
	o.services["api"].Transition(StateHealthy)
	o.mu.Unlock()
	if got := serviceInfo(t, o, "api").StartingPhase(); got != "" {
		t.Fatalf("phase outside starting = %q, want empty", got)
	}
}

func serviceInfo(t *testing.T, o *Orchestrator, name string) *ServiceInfo {
	t.Helper()
	info, ok := o.GetServiceInfo(name)
	if !ok {
		t.Fatalf("service %q unknown", name)
	}
	return &info
}
