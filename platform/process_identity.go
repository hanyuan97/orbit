package platform

import "errors"

// ErrProcessIdentityUnsupported means this platform cannot report a live
// process's argv or working directory, so callers cannot prove who owns it.
var ErrProcessIdentityUnsupported = errors.New("process identity is not readable on this platform")
