package fault

import (
	"strings"
	"testing"
)

// An unknown kind is refused, not accepted and ignored.
//
// This is the bug it prevents, reported from a real session: a rule naming a kind the
// running sidecar did not implement was armed, listed in the interface, and did
// nothing at all. Everything looked correct and no dial was ever faulted.
func TestUnknownKindIsRefused(t *testing.T) {
	_, err := Compile([]*Rule{{ID: "x", Enabled: true, Kind: "tspu_16_20", TagGlob: "*"}})
	if err == nil {
		t.Fatal("an unimplemented kind was accepted; it would arm and do nothing")
	}
	if !strings.Contains(err.Error(), "rebuild the sidecar") {
		t.Errorf("the error should say how to fix it, got: %v", err)
	}
}

// Every kind the engine names is accepted, so the allowlist cannot drift out of step
// with the constants beside it.
func TestEveryDeclaredKindCompiles(t *testing.T) {
	kinds := []Kind{
		KindBlackhole, KindRefuse, KindHostUnreachable, KindNetUnreachable, KindDNSFail,
		KindTLSHang, KindTLSGarbage, KindLatency, KindThrottle, KindResetAfter,
		KindUDPLoss, KindQuotaFreeze,
	}
	for _, k := range kinds {
		if _, err := Compile([]*Rule{{ID: "x", Enabled: true, Kind: k, TagGlob: "*"}}); err != nil {
			t.Errorf("%s should compile: %v", k, err)
		}
	}
}

// A disabled rule is skipped before the check, so an old saved rule set with a kind
// this build lost cannot block every other rule in the list from arming.
func TestDisabledUnknownKindIsIgnored(t *testing.T) {
	if _, err := Compile([]*Rule{{ID: "x", Enabled: false, Kind: "gone", TagGlob: "*"}}); err != nil {
		t.Errorf("a disabled rule should not be validated: %v", err)
	}
}
