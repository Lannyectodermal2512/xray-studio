// Build-time tooling. A separate module because it shares no dependencies with the
// sidecar and must not drag them into its build — docsgen is stdlib-only.
module xraystudio/tools

go 1.26
