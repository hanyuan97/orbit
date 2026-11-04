package history

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLastRecordTimeReportsNewestRecord(t *testing.T) {
	dir := t.TempDir()
	rec, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	first := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	last := first.Add(time.Hour)
	rec.Record(Record{ID: "a", Timestamp: first, Source: SourceCLI, Status: StatusPending})
	// A long record pushes the newest one past the first read window.
	rec.Record(Record{ID: "a", Timestamp: first, Source: SourceCLI, Status: StatusError, Error: strings.Repeat("x", 3*tailWindow)})
	rec.Record(Record{ID: "b", Timestamp: last, Source: SourceCLI, Status: StatusError, Error: strings.Repeat("y", 3*tailWindow)})
	_ = rec.Close()

	if got := LastRecordTime(dir); !got.Equal(last) {
		t.Fatalf("LastRecordTime = %v, want %v", got, last)
	}
}

func TestLastRecordTimeSkipsTornFinalLine(t *testing.T) {
	dir := t.TempDir()
	want := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	content := `{"id":"a","timestamp":"2026-01-02T03:04:05Z","status":"ok"}` + "\n" + `{"id":"b","timest`
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LastRecordTime(dir); !got.Equal(want) {
		t.Fatalf("LastRecordTime = %v, want %v", got, want)
	}
}

func TestLastRecordTimeReportsNothingWithoutRecords(t *testing.T) {
	missing := t.TempDir()
	if got := LastRecordTime(missing); !got.IsZero() {
		t.Fatalf("missing file: LastRecordTime = %v, want none", got)
	}
	empty := t.TempDir()
	if err := os.WriteFile(filepath.Join(empty, fileName), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LastRecordTime(empty); !got.IsZero() {
		t.Fatalf("empty file: LastRecordTime = %v, want none", got)
	}
}
