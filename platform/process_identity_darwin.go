//go:build darwin

package platform

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// ProcessArgs returns the live argv of pid as the kernel reports it, which
// may differ from what was exec'd when the program rewrites argv[0].
func ProcessArgs(pid int) ([]string, error) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return nil, fmt.Errorf("reading argv of pid %d: %w", pid, err)
	}
	return parseProcArgs2(raw)
}

// parseProcArgs2 decodes kern.procargs2: a native-endian int32 argc, the
// exec path, NUL padding, then argc NUL-terminated arguments.
func parseProcArgs2(raw []byte) ([]string, error) {
	if len(raw) < 4 {
		return nil, fmt.Errorf("procargs2 too short")
	}
	argc := int(binary.NativeEndian.Uint32(raw[:4]))
	rest := raw[4:]
	end := bytes.IndexByte(rest, 0)
	if end < 0 {
		return nil, fmt.Errorf("procargs2 missing exec path")
	}
	rest = bytes.TrimLeft(rest[end:], "\x00")
	args := make([]string, 0, argc)
	for len(args) < argc && len(rest) > 0 {
		end = bytes.IndexByte(rest, 0)
		if end < 0 {
			end = len(rest)
		}
		args = append(args, string(rest[:end]))
		if end == len(rest) {
			break
		}
		rest = rest[end+1:]
	}
	return args, nil
}

// ProcessWorkingDir returns the current working directory of pid.
func ProcessWorkingDir(pid int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sysutilExecTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return "", fmt.Errorf("reading cwd of pid %d: %w", pid, err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "n") {
			return line[1:], nil
		}
	}
	return "", fmt.Errorf("reading cwd of pid %d: lsof reported none", pid)
}
