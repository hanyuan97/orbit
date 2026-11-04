package health

import "time"

// ProtocolH2C is the Result.Protocol of a probe answered over cleartext
// HTTP/2; an HTTP/1.x answer reports its own version, such as "HTTP/1.1".
const ProtocolH2C = "h2c"

// Result represents the outcome of a health check.
type Result struct {
	Service string
	Healthy bool
	Message string
	Latency time.Duration
	// Protocol is the cleartext HTTP protocol that answered ("h2c" or the
	// HTTP/1.x version); empty for other check types and for HTTPS.
	Protocol string
}
