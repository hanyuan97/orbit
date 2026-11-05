package tracing

import (
	"bytes"
	"compress/gzip"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	collectorlogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
)

func resourceLogs(service, scope string, records ...*logspb.LogRecord) *logspb.ResourceLogs {
	return &logspb.ResourceLogs{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{strAttr("service.name", service)}},
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope:      &commonpb.InstrumentationScope{Name: scope},
			LogRecords: records,
		}},
	}
}

func stringBody(s string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: s}}
}

var logTraceID = []byte{0x0a, 0x1b, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}

func logsExport() *collectorlogspb.ExportLogsServiceRequest {
	return &collectorlogspb.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{
		resourceLogs("api", "Payments.Controller",
			&logspb.LogRecord{
				TimeUnixNano: 1_000_000_000, ObservedTimeUnixNano: 1_000_000_500,
				SeverityNumber: logspb.SeverityNumber_SEVERITY_NUMBER_ERROR, SeverityText: "Error",
				Body:    stringBody("payment failed"),
				TraceId: logTraceID, SpanId: []byte{1, 1, 1, 1, 1, 1, 1, 1},
				Attributes: []*commonpb.KeyValue{
					strAttr("exception.type", "System.InvalidOperationException"),
					strAttr("exception.message", "card declined"),
					strAttr("exception.stacktrace", "at Payments.Charge()\n at Payments.Post()"),
					{Key: "Attempt", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 3}}},
				},
			},
		),
		resourceLogs("billing", "Billing.Worker",
			&logspb.LogRecord{
				TimeUnixNano: 2_000_000_000,
				SeverityText: "Warning",
				Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_KvlistValue{KvlistValue: &commonpb.KeyValueList{
					Values: []*commonpb.KeyValue{strAttr("Reason", "retry")},
				}}},
				TraceId: make([]byte, 16), SpanId: make([]byte, 8),
			},
		),
	}}
}

func postLogs(t *testing.T, url, contentType string, body []byte, gzipped bool) *http.Response {
	t.Helper()
	if gzipped {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		_, _ = gz.Write(body)
		_ = gz.Close()
		body = buf.Bytes()
	}
	req, err := http.NewRequest(http.MethodPost, url+"/v1/logs", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	if gzipped {
		req.Header.Set("Content-Encoding", "gzip")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_ = resp.Body.Close()
	return resp
}

// TestOTLPLogReceiver posts the same export as protobuf and as gzipped JSON
// and asserts both land as attributed, queryable records.
func TestOTLPLogReceiver(t *testing.T) {
	export := logsExport()
	pb, err := proto.Marshal(export)
	if err != nil {
		t.Fatal(err)
	}
	js, err := protojson.Marshal(export)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, contentType string
		body              []byte
		gzipped           bool
		wantResponseType  string
	}{
		{"protobuf", "application/x-protobuf", pb, false, "application/x-protobuf"},
		{"gzipped json", "application/json", js, true, "application/json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := NewStore(10)
			srv := httptest.NewServer(store.OTLPHandler())
			defer srv.Close()

			resp := postLogs(t, srv.URL, tc.contentType, tc.body, tc.gzipped)
			if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != tc.wantResponseType {
				t.Fatalf("status %d content-type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
			}

			page := store.Logs().Query(0, LogFilter{})
			if len(page.Logs) != 2 || page.LatestSeq != 2 || page.HasMore {
				t.Fatalf("page = %+v, want 2 records, latestSeq 2", page)
			}
			warn, failure := page.Logs[0], page.Logs[1]

			if failure.Seq != 1 || failure.Service != "api" || failure.Scope != "Payments.Controller" ||
				failure.Body != "payment failed" || failure.SeverityNumber != 17 || failure.SeverityText != "Error" ||
				failure.TimeUnixNano != 1_000_000_000 || failure.ObservedTimeUnixNano != 1_000_000_500 ||
				failure.TraceID != "0a1b02030405060708090a0b0c0d0e0f" || failure.SpanID != "0101010101010101" {
				t.Errorf("error record = %+v", failure)
			}
			if failure.Attributes["exception.type"] != "System.InvalidOperationException" ||
				failure.Attributes["exception.stacktrace"] != "at Payments.Charge()\n at Payments.Post()" ||
				failure.Attributes["Attempt"] != "3" {
				t.Errorf("error attributes = %v", failure.Attributes)
			}

			if warn.Service != "billing" || warn.SeverityNumber != 13 || warn.TraceID != "" || warn.SpanID != "" {
				t.Errorf("warning record = %+v (severity from text, all-zero ids dropped)", warn)
			}
			if !strings.Contains(warn.Body, `"Reason"`) || !strings.Contains(warn.Body, `"retry"`) {
				t.Errorf("non-string body = %q, want it rendered as JSON", warn.Body)
			}
			if warn.ObservedTimeUnixNano == 0 {
				t.Error("observed time should fall back to the receive time")
			}
		})
	}
}

func TestOTLPLogReceiverRejectsBadRequests(t *testing.T) {
	store := NewStore(10)
	srv := httptest.NewServer(store.OTLPHandler())
	defer srv.Close()

	if resp := postLogs(t, srv.URL, "application/x-protobuf", []byte{0xff, 0xff}, false); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("undecodable body: status %d, want 400", resp.StatusCode)
	}
	huge := bytes.Repeat([]byte{'x'}, maxOTLPBodyBytes+1)
	if resp := postLogs(t, srv.URL, "application/x-protobuf", huge, false); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body: status %d, want 413", resp.StatusCode)
	}
	resp, err := http.Get(srv.URL + "/v1/logs")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET: status %d, want 405", resp.StatusCode)
	}
	if page := store.Logs().Query(0, LogFilter{}); len(page.Logs) != 0 {
		t.Errorf("rejected requests stored %d records", len(page.Logs))
	}
}

func seqs(page LogPage) []int64 {
	out := make([]int64, len(page.Logs))
	for i, r := range page.Logs {
		out[i] = r.Seq
	}
	return out
}

func equalSeqs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestLogStoreEvictsOldestPastEitherCeiling(t *testing.T) {
	byCount := NewLogStore(3, 1<<20)
	for i := 0; i < 5; i++ {
		byCount.Ingest([]LogRecord{{Service: "api", Body: "line"}})
	}
	page := byCount.Query(0, LogFilter{})
	if got := seqs(page); !equalSeqs(got, []int64{5, 4, 3}) || page.LatestSeq != 5 {
		t.Errorf("count ceiling kept %v (latest %d), want [5 4 3]", got, page.LatestSeq)
	}

	big := strings.Repeat("x", 1000)
	byBytes := NewLogStore(100, 2*(logRecordOverhead+len("api")+len(big)))
	byBytes.Ingest([]LogRecord{{Service: "api", Body: big}, {Service: "api", Body: big}, {Service: "api", Body: big}})
	if got := seqs(byBytes.Query(0, LogFilter{})); !equalSeqs(got, []int64{3, 2}) {
		t.Errorf("byte ceiling kept %v, want [3 2]", got)
	}

	huge := NewLogStore(10, 1<<20)
	huge.Ingest([]LogRecord{{Body: strings.Repeat("é", maxLogValueBytes), Attributes: map[string]string{"exception.stacktrace": strings.Repeat("y", maxLogValueBytes+1)}}})
	rec := huge.Query(0, LogFilter{}).Logs[0]
	if !strings.HasSuffix(rec.Body, truncatedMark) || len(rec.Body) > maxLogValueBytes+len(truncatedMark) {
		t.Errorf("body not truncated to the value ceiling: %d bytes", len(rec.Body))
	}
	if !strings.HasSuffix(rec.Attributes["exception.stacktrace"], truncatedMark) {
		t.Error("oversized attribute value should be truncated, not dropped")
	}
}

func TestParseSeverity(t *testing.T) {
	for in, want := range map[string]int32{
		"warn": 13, "Warning": 13, "ERROR": 17, "information": 9, "critical": 21, "trace": 1, "7": 7,
	} {
		if got, err := ParseSeverity(in); err != nil || got != want {
			t.Errorf("ParseSeverity(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "loud", "0", "25"} {
		if _, err := ParseSeverity(in); !errors.Is(err, ErrUnknownSeverity) {
			t.Errorf("ParseSeverity(%q) err = %v, want ErrUnknownSeverity", in, err)
		}
	}
	if SeverityName(14) != "WARN" || SeverityName(0) != "" {
		t.Errorf("SeverityName: 14=%q 0=%q", SeverityName(14), SeverityName(0))
	}
}
