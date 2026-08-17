// Command docsgen extracts per-parameter documentation from XTLS/Xray-docs-next and
// emits it keyed by config path, for the editor's hover help.
//
//	go run ./tools/docsgen            # fetch the pinned commit and regenerate
//	go run ./tools/docsgen -offline   # re-parse what is already cached
//
// The docs commit is pinned for the same reason the core is: unpinned upstream text
// would silently change what the app tells users about their config.
//
// LICENSING: the extracted text is a derivative of XTLS/Xray-docs-next, which is
// CC BY-SA 4.0. That means the extract must stay CC BY-SA 4.0, must be attributed, and
// must be marked as modified. It therefore lives in its own directory with its own
// LICENSE and ATTRIBUTION, separate from this project's code. Xray-core itself is
// MPL-2.0 and unrelated to this.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// docsCommit pins XTLS/Xray-docs-next.
const docsCommit = "901005cfbb887f20b60db4d59b5bce466206f5f3" // main @ 2026-08-06

const rawBase = "https://raw.githubusercontent.com/XTLS/Xray-docs-next/" + docsCommit + "/docs/en/"

// source maps one documentation file to the config paths its object headings describe.
//
// The mapping is hand-written because it is genuinely editorial: the docs are
// organised by object type ("BalancerObject") while a config is addressed by path
// ("routing.balancers[]"), and nothing in the markdown states the correspondence.
type source struct {
	file    string
	objects map[string]string // heading name -> config path prefix ("" = drop)
}

var sources = []source{
	{
		file: "config/routing.md",
		objects: map[string]string{
			"RoutingObject":          "routing",
			"RuleObject":             "routing.rules[]",
			"BalancerObject":         "routing.balancers[]",
			"StrategyObject":         "routing.balancers[].strategy",
			"StrategySettingsObject": "routing.balancers[].strategy.settings",
			"WebhookObject":          "routing.rules[].webhook",
		},
	},
	{
		file: "config/observatory.md",
		objects: map[string]string{
			"ObservatoryObject":      "observatory",
			"BurstObservatoryObject": "burstObservatory",
			"PingConfigObject":       "burstObservatory.pingConfig",
		},
	},
	{
		file:    "config/log.md",
		objects: map[string]string{"LogObject": "log"},
	},
	{
		file:    "config/api.md",
		objects: map[string]string{"ApiObject": "api", "APIObject": "api"},
	},
	{
		file: "config/policy.md",
		objects: map[string]string{
			"PolicyObject": "policy", "LevelPolicyObject": "policy.levels[]",
			"SystemPolicyObject": "policy.system",
		},
	},
	{
		file:    "config/metrics.md",
		objects: map[string]string{"MetricsObject": "metrics"},
	},
	{
		file: "config/inbound.md",
		objects: map[string]string{
			"InboundObject":  "inbounds[]",
			"SniffingObject": "inbounds[].sniffing",
			"AllocateObject": "inbounds[].allocate",
		},
	},
	{
		file: "config/outbound.md",
		objects: map[string]string{
			"OutboundObject":      "outbounds[]",
			"ProxySettingsObject": "outbounds[].proxySettings",
			"MuxObject":           "outbounds[].mux",
		},
	},
	{
		file: "config/outbounds/vless.md",
		objects: map[string]string{
			"VlessObject":                 "outbounds[vless].settings",
			"OutboundConfigurationObject": "outbounds[vless].settings",
			"InboundConfigurationObject":  "outbounds[vless].settings",
			"ClientObject":                "outbounds[vless].settings.clients[]",
			"ServerObject":                "outbounds[vless].settings.servers[]",
			"VnextObject":                 "outbounds[vless].settings.vnext[]",
			"UserObject":                  "outbounds[vless].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[vless].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/vmess.md",
		objects: map[string]string{
			"VmessObject":                 "outbounds[vmess].settings",
			"OutboundConfigurationObject": "outbounds[vmess].settings",
			"InboundConfigurationObject":  "outbounds[vmess].settings",
			"ClientObject":                "outbounds[vmess].settings.clients[]",
			"ServerObject":                "outbounds[vmess].settings.servers[]",
			"VnextObject":                 "outbounds[vmess].settings.vnext[]",
			"UserObject":                  "outbounds[vmess].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[vmess].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/trojan.md",
		objects: map[string]string{
			"TrojanObject":                "outbounds[trojan].settings",
			"OutboundConfigurationObject": "outbounds[trojan].settings",
			"InboundConfigurationObject":  "outbounds[trojan].settings",
			"ClientObject":                "outbounds[trojan].settings.clients[]",
			"ServerObject":                "outbounds[trojan].settings.servers[]",
			"VnextObject":                 "outbounds[trojan].settings.vnext[]",
			"UserObject":                  "outbounds[trojan].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[trojan].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/shadowsocks.md",
		objects: map[string]string{
			"ShadowsocksObject":           "outbounds[shadowsocks].settings",
			"OutboundConfigurationObject": "outbounds[shadowsocks].settings",
			"InboundConfigurationObject":  "outbounds[shadowsocks].settings",
			"ClientObject":                "outbounds[shadowsocks].settings.clients[]",
			"ServerObject":                "outbounds[shadowsocks].settings.servers[]",
			"VnextObject":                 "outbounds[shadowsocks].settings.vnext[]",
			"UserObject":                  "outbounds[shadowsocks].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[shadowsocks].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/socks.md",
		objects: map[string]string{
			"SocksObject":                 "outbounds[socks].settings",
			"OutboundConfigurationObject": "outbounds[socks].settings",
			"InboundConfigurationObject":  "outbounds[socks].settings",
			"ClientObject":                "outbounds[socks].settings.clients[]",
			"ServerObject":                "outbounds[socks].settings.servers[]",
			"VnextObject":                 "outbounds[socks].settings.vnext[]",
			"UserObject":                  "outbounds[socks].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[socks].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/http.md",
		objects: map[string]string{
			"HttpObject":                  "outbounds[http].settings",
			"OutboundConfigurationObject": "outbounds[http].settings",
			"InboundConfigurationObject":  "outbounds[http].settings",
			"ClientObject":                "outbounds[http].settings.clients[]",
			"ServerObject":                "outbounds[http].settings.servers[]",
			"VnextObject":                 "outbounds[http].settings.vnext[]",
			"UserObject":                  "outbounds[http].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[http].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/freedom.md",
		objects: map[string]string{
			"FreedomObject":               "outbounds[freedom].settings",
			"OutboundConfigurationObject": "outbounds[freedom].settings",
			"InboundConfigurationObject":  "outbounds[freedom].settings",
			"ClientObject":                "outbounds[freedom].settings.clients[]",
			"ServerObject":                "outbounds[freedom].settings.servers[]",
			"VnextObject":                 "outbounds[freedom].settings.vnext[]",
			"UserObject":                  "outbounds[freedom].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[freedom].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/blackhole.md",
		objects: map[string]string{
			"BlackholeObject":             "outbounds[blackhole].settings",
			"OutboundConfigurationObject": "outbounds[blackhole].settings",
			"InboundConfigurationObject":  "outbounds[blackhole].settings",
			"ClientObject":                "outbounds[blackhole].settings.clients[]",
			"ServerObject":                "outbounds[blackhole].settings.servers[]",
			"VnextObject":                 "outbounds[blackhole].settings.vnext[]",
			"UserObject":                  "outbounds[blackhole].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[blackhole].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/dns.md",
		objects: map[string]string{
			"DnsObject":                   "outbounds[dns].settings",
			"OutboundConfigurationObject": "outbounds[dns].settings",
			"InboundConfigurationObject":  "outbounds[dns].settings",
			"ClientObject":                "outbounds[dns].settings.clients[]",
			"ServerObject":                "outbounds[dns].settings.servers[]",
			"VnextObject":                 "outbounds[dns].settings.vnext[]",
			"UserObject":                  "outbounds[dns].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[dns].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/wireguard.md",
		objects: map[string]string{
			"WireguardObject":             "outbounds[wireguard].settings",
			"OutboundConfigurationObject": "outbounds[wireguard].settings",
			"InboundConfigurationObject":  "outbounds[wireguard].settings",
			"ClientObject":                "outbounds[wireguard].settings.clients[]",
			"ServerObject":                "outbounds[wireguard].settings.servers[]",
			"VnextObject":                 "outbounds[wireguard].settings.vnext[]",
			"UserObject":                  "outbounds[wireguard].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[wireguard].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/hysteria.md",
		objects: map[string]string{
			"HysteriaObject":              "outbounds[hysteria].settings",
			"OutboundConfigurationObject": "outbounds[hysteria].settings",
			"InboundConfigurationObject":  "outbounds[hysteria].settings",
			"ClientObject":                "outbounds[hysteria].settings.clients[]",
			"ServerObject":                "outbounds[hysteria].settings.servers[]",
			"VnextObject":                 "outbounds[hysteria].settings.vnext[]",
			"UserObject":                  "outbounds[hysteria].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[hysteria].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/loopback.md",
		objects: map[string]string{
			"LoopbackObject":              "outbounds[loopback].settings",
			"OutboundConfigurationObject": "outbounds[loopback].settings",
			"InboundConfigurationObject":  "outbounds[loopback].settings",
			"ClientObject":                "outbounds[loopback].settings.clients[]",
			"ServerObject":                "outbounds[loopback].settings.servers[]",
			"VnextObject":                 "outbounds[loopback].settings.vnext[]",
			"UserObject":                  "outbounds[loopback].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[loopback].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/dokodemo.md",
		objects: map[string]string{
			"DokodemoObject":              "outbounds[dokodemo].settings",
			"OutboundConfigurationObject": "outbounds[dokodemo].settings",
			"InboundConfigurationObject":  "outbounds[dokodemo].settings",
			"ClientObject":                "outbounds[dokodemo].settings.clients[]",
			"ServerObject":                "outbounds[dokodemo].settings.servers[]",
			"VnextObject":                 "outbounds[dokodemo].settings.vnext[]",
			"UserObject":                  "outbounds[dokodemo].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[dokodemo].settings.fallbacks[]",
		},
	},
	{
		file: "config/outbounds/tun.md",
		objects: map[string]string{
			"TunObject":                   "outbounds[tun].settings",
			"OutboundConfigurationObject": "outbounds[tun].settings",
			"InboundConfigurationObject":  "outbounds[tun].settings",
			"ClientObject":                "outbounds[tun].settings.clients[]",
			"ServerObject":                "outbounds[tun].settings.servers[]",
			"VnextObject":                 "outbounds[tun].settings.vnext[]",
			"UserObject":                  "outbounds[tun].settings.vnext[].users[]",
			"FallbackObject":              "outbounds[tun].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/vless.md",
		objects: map[string]string{
			"VlessObject":                 "inbounds[vless].settings",
			"OutboundConfigurationObject": "inbounds[vless].settings",
			"InboundConfigurationObject":  "inbounds[vless].settings",
			"ClientObject":                "inbounds[vless].settings.clients[]",
			"ServerObject":                "inbounds[vless].settings.servers[]",
			"VnextObject":                 "inbounds[vless].settings.vnext[]",
			"UserObject":                  "inbounds[vless].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[vless].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/vmess.md",
		objects: map[string]string{
			"VmessObject":                 "inbounds[vmess].settings",
			"OutboundConfigurationObject": "inbounds[vmess].settings",
			"InboundConfigurationObject":  "inbounds[vmess].settings",
			"ClientObject":                "inbounds[vmess].settings.clients[]",
			"ServerObject":                "inbounds[vmess].settings.servers[]",
			"VnextObject":                 "inbounds[vmess].settings.vnext[]",
			"UserObject":                  "inbounds[vmess].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[vmess].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/trojan.md",
		objects: map[string]string{
			"TrojanObject":                "inbounds[trojan].settings",
			"OutboundConfigurationObject": "inbounds[trojan].settings",
			"InboundConfigurationObject":  "inbounds[trojan].settings",
			"ClientObject":                "inbounds[trojan].settings.clients[]",
			"ServerObject":                "inbounds[trojan].settings.servers[]",
			"VnextObject":                 "inbounds[trojan].settings.vnext[]",
			"UserObject":                  "inbounds[trojan].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[trojan].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/shadowsocks.md",
		objects: map[string]string{
			"ShadowsocksObject":           "inbounds[shadowsocks].settings",
			"OutboundConfigurationObject": "inbounds[shadowsocks].settings",
			"InboundConfigurationObject":  "inbounds[shadowsocks].settings",
			"ClientObject":                "inbounds[shadowsocks].settings.clients[]",
			"ServerObject":                "inbounds[shadowsocks].settings.servers[]",
			"VnextObject":                 "inbounds[shadowsocks].settings.vnext[]",
			"UserObject":                  "inbounds[shadowsocks].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[shadowsocks].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/socks.md",
		objects: map[string]string{
			"SocksObject":                 "inbounds[socks].settings",
			"OutboundConfigurationObject": "inbounds[socks].settings",
			"InboundConfigurationObject":  "inbounds[socks].settings",
			"ClientObject":                "inbounds[socks].settings.clients[]",
			"ServerObject":                "inbounds[socks].settings.servers[]",
			"VnextObject":                 "inbounds[socks].settings.vnext[]",
			"UserObject":                  "inbounds[socks].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[socks].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/http.md",
		objects: map[string]string{
			"HttpObject":                  "inbounds[http].settings",
			"OutboundConfigurationObject": "inbounds[http].settings",
			"InboundConfigurationObject":  "inbounds[http].settings",
			"ClientObject":                "inbounds[http].settings.clients[]",
			"ServerObject":                "inbounds[http].settings.servers[]",
			"VnextObject":                 "inbounds[http].settings.vnext[]",
			"UserObject":                  "inbounds[http].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[http].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/freedom.md",
		objects: map[string]string{
			"FreedomObject":               "inbounds[freedom].settings",
			"OutboundConfigurationObject": "inbounds[freedom].settings",
			"InboundConfigurationObject":  "inbounds[freedom].settings",
			"ClientObject":                "inbounds[freedom].settings.clients[]",
			"ServerObject":                "inbounds[freedom].settings.servers[]",
			"VnextObject":                 "inbounds[freedom].settings.vnext[]",
			"UserObject":                  "inbounds[freedom].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[freedom].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/blackhole.md",
		objects: map[string]string{
			"BlackholeObject":             "inbounds[blackhole].settings",
			"OutboundConfigurationObject": "inbounds[blackhole].settings",
			"InboundConfigurationObject":  "inbounds[blackhole].settings",
			"ClientObject":                "inbounds[blackhole].settings.clients[]",
			"ServerObject":                "inbounds[blackhole].settings.servers[]",
			"VnextObject":                 "inbounds[blackhole].settings.vnext[]",
			"UserObject":                  "inbounds[blackhole].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[blackhole].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/dns.md",
		objects: map[string]string{
			"DnsObject":                   "inbounds[dns].settings",
			"OutboundConfigurationObject": "inbounds[dns].settings",
			"InboundConfigurationObject":  "inbounds[dns].settings",
			"ClientObject":                "inbounds[dns].settings.clients[]",
			"ServerObject":                "inbounds[dns].settings.servers[]",
			"VnextObject":                 "inbounds[dns].settings.vnext[]",
			"UserObject":                  "inbounds[dns].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[dns].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/wireguard.md",
		objects: map[string]string{
			"WireguardObject":             "inbounds[wireguard].settings",
			"OutboundConfigurationObject": "inbounds[wireguard].settings",
			"InboundConfigurationObject":  "inbounds[wireguard].settings",
			"ClientObject":                "inbounds[wireguard].settings.clients[]",
			"ServerObject":                "inbounds[wireguard].settings.servers[]",
			"VnextObject":                 "inbounds[wireguard].settings.vnext[]",
			"UserObject":                  "inbounds[wireguard].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[wireguard].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/hysteria.md",
		objects: map[string]string{
			"HysteriaObject":              "inbounds[hysteria].settings",
			"OutboundConfigurationObject": "inbounds[hysteria].settings",
			"InboundConfigurationObject":  "inbounds[hysteria].settings",
			"ClientObject":                "inbounds[hysteria].settings.clients[]",
			"ServerObject":                "inbounds[hysteria].settings.servers[]",
			"VnextObject":                 "inbounds[hysteria].settings.vnext[]",
			"UserObject":                  "inbounds[hysteria].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[hysteria].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/loopback.md",
		objects: map[string]string{
			"LoopbackObject":              "inbounds[loopback].settings",
			"OutboundConfigurationObject": "inbounds[loopback].settings",
			"InboundConfigurationObject":  "inbounds[loopback].settings",
			"ClientObject":                "inbounds[loopback].settings.clients[]",
			"ServerObject":                "inbounds[loopback].settings.servers[]",
			"VnextObject":                 "inbounds[loopback].settings.vnext[]",
			"UserObject":                  "inbounds[loopback].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[loopback].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/dokodemo.md",
		objects: map[string]string{
			"DokodemoObject":              "inbounds[dokodemo].settings",
			"OutboundConfigurationObject": "inbounds[dokodemo].settings",
			"InboundConfigurationObject":  "inbounds[dokodemo].settings",
			"ClientObject":                "inbounds[dokodemo].settings.clients[]",
			"ServerObject":                "inbounds[dokodemo].settings.servers[]",
			"VnextObject":                 "inbounds[dokodemo].settings.vnext[]",
			"UserObject":                  "inbounds[dokodemo].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[dokodemo].settings.fallbacks[]",
		},
	},
	{
		file: "config/inbounds/tun.md",
		objects: map[string]string{
			"TunObject":                   "inbounds[tun].settings",
			"OutboundConfigurationObject": "inbounds[tun].settings",
			"InboundConfigurationObject":  "inbounds[tun].settings",
			"ClientObject":                "inbounds[tun].settings.clients[]",
			"ServerObject":                "inbounds[tun].settings.servers[]",
			"VnextObject":                 "inbounds[tun].settings.vnext[]",
			"UserObject":                  "inbounds[tun].settings.vnext[].users[]",
			"FallbackObject":              "inbounds[tun].settings.fallbacks[]",
		},
	},
	{
		file:    "config/transport.md",
		objects: map[string]string{"StreamSettingsObject": "streamSettings"},
	},
	{
		file:    "config/transports/tls.md",
		objects: map[string]string{"TLSObject": "streamSettings.tlsSettings"},
	},
	{
		file:    "config/transports/reality.md",
		objects: map[string]string{"RealityObject": "streamSettings.realitySettings"},
	},
	{
		file:    "config/transports/sockopt.md",
		objects: map[string]string{"SockoptObject": "streamSettings.sockopt"},
	},
	{
		file:    "config/dns.md",
		objects: map[string]string{"DnsObject": "dns", "DNSObject": "dns", "ServerObject": "dns.servers[]"},
	},
}

// Param is one documented config parameter.
type Param struct {
	Path    string `json:"path"`             // e.g. routing.balancers[].selector
	Name    string `json:"name"`             // selector
	Type    string `json:"type"`             // \[ string \] -> [string]
	Summary string `json:"summary"`          // first paragraph
	Detail  string `json:"detail,omitempty"` // the rest
	Source  string `json:"source"`           // upstream doc URL, for attribution
}

// Bundle is the emitted file.
type Bundle struct {
	Generated   string           `json:"generated"`
	DocsCommit  string           `json:"docsCommit"`
	License     string           `json:"license"`
	Attribution string           `json:"attribution"`
	Params      map[string]Param `json:"params"`
}

var (
	// "> `name`: type"  — the type may contain escaped brackets and links.
	reParam   = regexp.MustCompile("^>\\s*`([^`]+)`\\s*:?\\s*(.*)$")
	reHeading = regexp.MustCompile(`^(#{2,6})\s+(.+?)\s*$`)
	reLink    = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`) // [text](url) -> text
	reEscaped = regexp.MustCompile(`\\([\[\]])`)            // \[ -> [

	// A type naming an Object WITHOUT a link (e.g. "\[ CostObject \]") documents its
	// fields inline, right after the parent, with no heading of their own. Linked
	// types like "[StrategySettingsObject](#...)" get their own heading instead.
	reInlineObject = regexp.MustCompile(`([A-Za-z]+Object)`)
	reIsArray      = regexp.MustCompile(`^\\?\[`)
)

func main() {
	offline := flag.Bool("offline", false, "re-parse the cache instead of fetching")
	outDir := flag.String("out", "data/docs-en", "output directory")
	cacheDir := flag.String("cache", ".build/docs-cache", "download cache")
	flag.Parse()

	if err := run(*offline, *outDir, *cacheDir); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(offline bool, outDir, cacheDir string) error {
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}

	params := map[string]Param{}
	for _, src := range sources {
		body, err := fetch(src.file, cacheDir, offline)
		if err != nil {
			// A doc file that has moved should not abort the whole run; the rest is
			// still useful, and the gap is visible in the count.
			fmt.Fprintf(os.Stderr, "  skip %s: %v\n", src.file, err)
			continue
		}
		n := extract(string(body), src, params)
		fmt.Printf("  %-34s %3d params\n", src.file, n)
	}

	bundle := Bundle{
		Generated:  time.Now().UTC().Format(time.RFC3339),
		DocsCommit: docsCommit,
		License:    "CC-BY-SA-4.0",
		Attribution: "Adapted from the XTLS/Xray-docs-next documentation " +
			"(https://github.com/XTLS/Xray-docs-next), licensed CC BY-SA 4.0. " +
			"Text was extracted per parameter and reformatted; it is not verbatim.",
		Params: params,
	}

	f, err := os.Create(filepath.Join(outDir, "params.json"))
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(bundle); err != nil {
		return err
	}

	if err := writeLicense(outDir); err != nil {
		return err
	}
	fmt.Printf("\n%d parameters -> %s/params.json\n", len(params), outDir)
	return nil
}

func fetch(file, cacheDir string, offline bool) ([]byte, error) {
	cache := filepath.Join(cacheDir, strings.ReplaceAll(file, "/", "_"))
	if b, err := os.ReadFile(cache); err == nil {
		return b, nil
	}
	if offline {
		return nil, fmt.Errorf("not cached")
	}
	req, _ := http.NewRequest(http.MethodGet, rawBase+file, nil)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return b, os.WriteFile(cache, b, 0o644)
}

// extract walks the markdown, tracking which object heading is in scope and attaching
// each "> `param`: type" block to the config path that heading maps to.
func extract(md string, src source, out map[string]Param) int {
	lines := strings.Split(md, "\n")
	prefix := ""
	// nested is set when the previous parameter's type named an inline object, so its
	// fields attach to it rather than to the enclosing object.
	nested := ""
	var cur *Param
	var body []string
	n := 0

	flush := func() {
		if cur == nil {
			return
		}
		summary, detail := splitProse(body)
		cur.Summary, cur.Detail = summary, detail
		if cur.Summary != "" {
			out[cur.Path] = *cur
			n++
		}
		cur, body = nil, nil
	}

	for _, line := range lines {
		if m := reHeading.FindStringSubmatch(line); m != nil {
			flush()
			nested = ""
			// Headings are written as "### BalancerObject" but sometimes carry a
			// trailing anchor or description; match on the first word.
			name := strings.Fields(m[2])[0]
			if p, ok := src.objects[name]; ok {
				prefix = p
			} else if _, isObject := src.objects[m[2]]; isObject {
				prefix = src.objects[m[2]]
			} else if strings.HasSuffix(name, "Object") {
				// An object we have no mapping for: stop attributing params to the
				// previous one, which would be worse than emitting nothing.
				prefix = ""
			}
			continue
		}
		if m := reParam.FindStringSubmatch(line); m != nil {
			flush()
			if prefix == "" {
				continue
			}
			parent := prefix
			if nested != "" {
				parent = nested
			}
			cur = &Param{
				Path:   parent + "." + m[1],
				Name:   m[1],
				Type:   clean(m[2]),
				Source: docURL(src.file),
			}

			// If this parameter's type names an object inline, the parameters that
			// follow describe that object, not this one.
			raw := m[2]
			if !strings.Contains(raw, "](#") && reInlineObject.MatchString(raw) {
				nested = parent + "." + m[1]
				if reIsArray.MatchString(strings.TrimSpace(raw)) {
					nested += "[]"
				}
			}
			continue
		}
		if cur != nil {
			body = append(body, line)
		}
	}
	flush()
	return n
}

// splitProse turns the lines after a parameter heading into a one-line summary plus
// the remainder, dropping fenced code blocks (the UI shows types separately).
func splitProse(lines []string) (summary, detail string) {
	var paras []string
	var cur []string
	inFence := false
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if strings.TrimSpace(l) == "" {
			if len(cur) > 0 {
				paras = append(paras, strings.Join(cur, " "))
				cur = nil
			}
			continue
		}
		cur = append(cur, strings.TrimSpace(l))
	}
	if len(cur) > 0 {
		paras = append(paras, strings.Join(cur, " "))
	}
	for i := range paras {
		paras[i] = clean(paras[i])
	}
	if len(paras) == 0 {
		return "", ""
	}
	return paras[0], strings.Join(paras[1:], "\n\n")
}

// clean strips markdown that would render as noise in a tooltip.
func clean(s string) string {
	s = reLink.ReplaceAllString(s, "$1")
	s = reEscaped.ReplaceAllString(s, "$1")
	s = strings.ReplaceAll(s, "::: tip", "")
	s = strings.ReplaceAll(s, "::: warning", "")
	s = strings.ReplaceAll(s, ":::", "")
	return strings.TrimSpace(s)
}

func docURL(file string) string {
	return "https://xtls.github.io/en/" + strings.TrimSuffix(file, ".md") + ".html"
}

func writeLicense(dir string) error {
	attrib := `# Attribution

The contents of ` + "`params.json`" + ` in this directory are **adapted from the
[XTLS/Xray-docs-next](https://github.com/XTLS/Xray-docs-next) documentation**, which is
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Pinned to commit ` + "`" + docsCommit + "`" + `.

**Modifications:** the text was extracted per configuration parameter by
` + "`tools/docsgen`" + `, split into a summary and detail, stripped of markdown links,
code fences and VuePress container syntax, and re-keyed by configuration path. It is
therefore an adaptation, not a verbatim copy.

**ShareAlike:** because this is adapted material, the contents of this directory remain
licensed under CC BY-SA 4.0. This applies to the extracted documentation text only — it
does not extend to the rest of this project, which merely reads these files at runtime.
Xray-core itself is MPL-2.0 and unrelated to this notice.
`
	if err := os.WriteFile(filepath.Join(dir, "ATTRIBUTION.md"), []byte(attrib), 0o644); err != nil {
		return err
	}
	const url = "https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt"
	if _, err := os.Stat(filepath.Join(dir, "LICENSE")); os.IsNotExist(err) {
		resp, err := (&http.Client{Timeout: 30 * time.Second}).Get(url)
		if err == nil {
			defer resp.Body.Close()
			if b, err := io.ReadAll(resp.Body); err == nil && resp.StatusCode == 200 {
				return os.WriteFile(filepath.Join(dir, "LICENSE"), b, 0o644)
			}
		}
		// Never fail the build over the licence text; record where it lives instead.
		return os.WriteFile(filepath.Join(dir, "LICENSE"),
			[]byte("Creative Commons Attribution-ShareAlike 4.0 International\n"+url+"\n"), 0o644)
	}
	return nil
}
