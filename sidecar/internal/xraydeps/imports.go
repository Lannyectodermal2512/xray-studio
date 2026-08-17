// Package xraydeps blank-imports every Xray-core package whose init() registers a
// config type, so that any config the user throws at us can be built.
//
// It exists as its own package purely so the list is auditable in one place, and so
// that the diff against upstream's main/distro/all/all.go is easy to eyeball when
// rebasing onto a new Xray version.
//
// Two things worth knowing about this list:
//
//   - Most proxy and transport registrations arrive *transitively*. Importing
//     infra/conf (which infra/conf/serial pulls in) imports the implementation package
//     for every protocol — e.g. infra/conf/vless.go imports proxy/vless{,/inbound,/outbound}.
//     That is why upstream's all.go can omit proxy/hysteria, proxy/tun and
//     transport/internet/hysteria and still support them. We list them anyway: relying
//     on a transitive import to register a feature is exactly the kind of thing that
//     breaks silently on a version bump.
//
//   - The three "mandatory" app packages are NOT covered transitively. infra/conf/xray.go
//     imports the app/proxyman *protobuf* package, not app/proxyman/inbound|outbound.
//     Drop them and configs build fine but nothing listens or dials.
//
// Deliberately omitted vs upstream all.go: main/commands/all (the whole CLI),
// main/confloader/external (fetches configs over HTTP), main/{json,toml,yaml} (we call
// infra/conf/serial directly). app/commander and the *:command services are kept so a
// user config that declares an `api` block still works.
package xraydeps

import (
	// Mandatory. Not covered transitively — see the package comment.
	_ "github.com/xtls/xray-core/app/dispatcher"
	_ "github.com/xtls/xray-core/app/proxyman/inbound"
	_ "github.com/xtls/xray-core/app/proxyman/outbound"

	// Breaks the dependency cycle caused by core importing the internet package.
	// Required for observatory probes: tagged.Dialer is nil without it, so every
	// probe panics. Non-obvious and easy to lose in a rebase.
	_ "github.com/xtls/xray-core/transport/internet/tagged/taggedimpl"

	// Commander + API services, so configs with an `api` block load unchanged.
	_ "github.com/xtls/xray-core/app/commander"
	_ "github.com/xtls/xray-core/app/log/command"
	_ "github.com/xtls/xray-core/app/observatory/command"
	_ "github.com/xtls/xray-core/app/proxyman/command"
	_ "github.com/xtls/xray-core/app/stats/command"

	// Apps.
	_ "github.com/xtls/xray-core/app/dns"
	_ "github.com/xtls/xray-core/app/dns/fakedns"
	_ "github.com/xtls/xray-core/app/geodata"
	_ "github.com/xtls/xray-core/app/log"
	_ "github.com/xtls/xray-core/app/metrics"
	_ "github.com/xtls/xray-core/app/observatory"
	_ "github.com/xtls/xray-core/app/policy"
	_ "github.com/xtls/xray-core/app/reverse"
	_ "github.com/xtls/xray-core/app/router"
	_ "github.com/xtls/xray-core/app/stats"

	// The burst observatory. leastLoad and leastPing are useless without one, and it
	// is the only source of HealthPing (deviation / all / fail), which is what
	// leastLoad actually ranks on.
	_ "github.com/xtls/xray-core/app/observatory/burst"

	// Proxies.
	_ "github.com/xtls/xray-core/proxy/blackhole"
	_ "github.com/xtls/xray-core/proxy/dns"
	_ "github.com/xtls/xray-core/proxy/dokodemo"
	_ "github.com/xtls/xray-core/proxy/freedom"
	_ "github.com/xtls/xray-core/proxy/http"
	_ "github.com/xtls/xray-core/proxy/hysteria"
	_ "github.com/xtls/xray-core/proxy/loopback"
	_ "github.com/xtls/xray-core/proxy/shadowsocks"
	_ "github.com/xtls/xray-core/proxy/shadowsocks_2022"
	_ "github.com/xtls/xray-core/proxy/socks"
	_ "github.com/xtls/xray-core/proxy/trojan"
	_ "github.com/xtls/xray-core/proxy/tun"
	_ "github.com/xtls/xray-core/proxy/vless/inbound"
	_ "github.com/xtls/xray-core/proxy/vless/outbound"
	_ "github.com/xtls/xray-core/proxy/vmess/inbound"
	_ "github.com/xtls/xray-core/proxy/vmess/outbound"
	_ "github.com/xtls/xray-core/proxy/wireguard"

	// Transports.
	_ "github.com/xtls/xray-core/transport/internet/finalmask"
	_ "github.com/xtls/xray-core/transport/internet/grpc"
	_ "github.com/xtls/xray-core/transport/internet/httpupgrade"
	_ "github.com/xtls/xray-core/transport/internet/hysteria"
	_ "github.com/xtls/xray-core/transport/internet/kcp"
	_ "github.com/xtls/xray-core/transport/internet/reality"
	_ "github.com/xtls/xray-core/transport/internet/splithttp"
	_ "github.com/xtls/xray-core/transport/internet/tcp"
	_ "github.com/xtls/xray-core/transport/internet/tls"
	_ "github.com/xtls/xray-core/transport/internet/udp"
	_ "github.com/xtls/xray-core/transport/internet/websocket"

	// Transport headers.
	_ "github.com/xtls/xray-core/transport/internet/headers/http"
	_ "github.com/xtls/xray-core/transport/internet/headers/noop"
)
