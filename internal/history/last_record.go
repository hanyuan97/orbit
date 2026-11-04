package history

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"
)

// tailWindow is the first slice of the file LastRecordTime reads from the end;
// it doubles until a complete record fits, so an oversized last line still
// resolves without reading the whole file in the common case.
const tailWindow = 4 * 1024

// LastRecordTime reports the timestamp of the newest record in dir's history
// file. It reads backwards from the end because callers such as
// `instance list` run it once per instance, and the file grows to megabytes
// before rotating. A torn final line (a write in flight) is skipped in favour
// of the record before it. The zero time means the file is missing or holds
// no readable record.
func LastRecordTime(dir string) time.Time {
	f, err := os.Open(filepath.Join(dir, fileName))
	if err != nil {
		return time.Time{}
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return time.Time{}
	}
	size := info.Size()
	for window := int64(tailWindow); ; window *= 2 {
		start := max(size-window, 0)
		buf := make([]byte, size-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return time.Time{}
		}
		if start > 0 {
			cut := bytes.IndexByte(buf, '\n')
			if cut < 0 {
				continue
			}
			buf = buf[cut+1:]
		}
		if ts := newestTimestamp(buf); !ts.IsZero() || start == 0 {
			return ts
		}
	}
}

// LastRecordTime has already dropped the window's leading partial line, so
// every line here is whole except possibly a torn final one.
func newestTimestamp(lines []byte) time.Time {
	for len(lines) > 0 {
		lines = bytes.TrimRight(lines, "\n")
		line := lines
		if i := bytes.LastIndexByte(lines, '\n'); i >= 0 {
			line, lines = lines[i+1:], lines[:i]
		} else {
			lines = nil
		}
		var rec struct {
			Timestamp time.Time `json:"timestamp"`
		}
		if json.Unmarshal(line, &rec) == nil && !rec.Timestamp.IsZero() {
			return rec.Timestamp
		}
	}
	return time.Time{}
}
