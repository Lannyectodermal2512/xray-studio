// Command schemagen extracts the protocol `settings` surface from Xray's infra/conf
// package, which is the one part of the config runtime reflection cannot reach.
//
//	go -C tools run ./schemagen -src ../.build/xray-core/infra/conf -out ../data/schema
//
// Why this exists at all: the validator already derives its known-key set by reflecting
// over conf.Config, which is better than any generated artefact because it can never
// drift from the linked core. But `inbounds[].settings` and `outbounds[].settings` are
// declared as json.RawMessage and decoded later by a string-keyed registry
// (ConfigCreatorCache), so reflection stops at the boundary and every protocol-specific
// key is invisible to it.
//
// Those registries are plain map literals, so the mapping is recoverable from the
// source — which is the only place it exists. Nothing else in the tree states that
// "vless" means VLessInboundConfig.
//
// Output is keyed by protocol and reports each field's JSON name, Go type and doc
// comment. Doc comments matter: the official documentation covers protocol settings
// unevenly, and a field's own comment is often the only description there is.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

// Field is one JSON-addressable member of a settings struct.
type Field struct {
	Name string `json:"name"`           // JSON key
	Type string `json:"type"`           // Go type, rendered
	Doc  string `json:"doc,omitempty"`  // the field's own comment
	Ref  string `json:"ref,omitempty"`  // named struct this descends into
	List bool   `json:"list,omitempty"` // it is an array
}

// Struct is a named settings type.
type Struct struct {
	Name   string  `json:"name"`
	Doc    string  `json:"doc,omitempty"`
	Fields []Field `json:"fields"`
}

// Registry maps a discriminator value to the type that decodes it.
type Registry struct {
	Key     string            `json:"key"`     // the JSON field holding the discriminator
	Section string            `json:"section"` // where the payload lives ("settings", or "" for inline)
	Types   map[string]string `json:"types"`   // "vless" -> "VLessInboundConfig"
}

// Bundle is the emitted file.
type Bundle struct {
	Source     string              `json:"source"`
	Registries map[string]Registry `json:"registries"`
	Types      map[string]Struct   `json:"types"`
}

func main() {
	src := flag.String("src", "../.build/xray-core/infra/conf", "infra/conf directory")
	out := flag.String("out", "../data/schema", "output directory")
	flag.Parse()

	if err := run(*src, *out); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(srcDir, outDir string) error {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, srcDir, func(fi os.FileInfo) bool {
		// Tests declare helper structs that are not part of the config surface.
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, parser.ParseComments)
	if err != nil {
		return err
	}

	structs := map[string]*ast.StructType{}
	docs := map[string]string{}
	consts := map[string]string{}
	registries := map[string]Registry{}

	// Two passes: registry keys are often named constants (strategyLeastLoad = "leastload"),
	// so every constant has to be known before any registry is read.
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			collectStructs(file, structs, docs)
			collectConsts(file, consts)
		}
	}
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			collectRegistries(file, registries, consts)
		}
	}
	if len(registries) == 0 {
		return fmt.Errorf("no ConfigCreatorCache registries found in %s", srcDir)
	}

	// Emit only what a settings payload can actually reach, transitively. Emitting every
	// struct in the package would bury the protocol surface in unrelated types.
	want := map[string]bool{}
	for _, r := range registries {
		for _, typeName := range r.Types {
			markReachable(typeName, structs, want)
		}
	}

	types := map[string]Struct{}
	for name := range want {
		st, ok := structs[name]
		if !ok {
			continue
		}
		types[name] = Struct{Name: name, Doc: docs[name], Fields: fieldsOf(st)}
	}

	bundle := Bundle{
		Source:     "infra/conf @ the pinned Xray-core checkout",
		Registries: registries,
		Types:      types,
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(outDir, "protocols.json"))
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(bundle); err != nil {
		return err
	}

	names := make([]string, 0, len(registries))
	for n := range registries {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Printf("  %-22s %2d discriminators\n", n, len(registries[n].Types))
	}
	fmt.Printf("\n%d types -> %s/protocols.json\n", len(types), outDir)
	return nil
}

// collectStructs indexes every named struct type and its doc comment.
func collectStructs(file *ast.File, out map[string]*ast.StructType, docs map[string]string) {
	for _, decl := range file.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		for _, spec := range gd.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				continue
			}
			out[ts.Name.Name] = st
			// A type's comment sits on the TypeSpec for a grouped decl and on the
			// GenDecl for a standalone one.
			if d := text(ts.Doc); d != "" {
				docs[ts.Name.Name] = d
			} else if d := text(gd.Doc); d != "" {
				docs[ts.Name.Name] = d
			}
		}
	}
}

// collectRegistries finds `NewJSONConfigLoader(ConfigCreatorCache{...}, "key", "section")`
// calls and recovers the discriminator-to-type mapping they encode.
func collectRegistries(file *ast.File, out map[string]Registry, consts map[string]string) {
	for _, decl := range file.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.VAR {
			continue
		}
		for _, spec := range gd.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok || len(vs.Names) == 0 || len(vs.Values) == 0 {
				continue
			}
			call, ok := vs.Values[0].(*ast.CallExpr)
			if !ok || !isIdent(call.Fun, "NewJSONConfigLoader") || len(call.Args) < 1 {
				continue
			}
			lit, ok := call.Args[0].(*ast.CompositeLit)
			if !ok {
				continue
			}
			reg := Registry{Types: map[string]string{}}
			if len(call.Args) >= 2 {
				reg.Key = strLit(call.Args[1])
			}
			if len(call.Args) >= 3 {
				reg.Section = strLit(call.Args[2])
			}
			for _, elt := range lit.Elts {
				kv, ok := elt.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				key := literalOrConst(kv.Key, consts)
				if name := returnedType(kv.Value); name != "" && key != "" {
					reg.Types[key] = name
				}
			}
			if len(reg.Types) > 0 {
				out[vs.Names[0].Name] = reg
			}
		}
	}
}

// returnedType digs the type name out of `func() interface{} { return new(T) }` and the
// `&T{...}` form the registries also use.
func returnedType(e ast.Expr) string {
	fn, ok := e.(*ast.FuncLit)
	if !ok || fn.Body == nil {
		return ""
	}
	for _, stmt := range fn.Body.List {
		ret, ok := stmt.(*ast.ReturnStmt)
		if !ok || len(ret.Results) == 0 {
			continue
		}
		switch v := ret.Results[0].(type) {
		case *ast.CallExpr: // new(T)
			if isIdent(v.Fun, "new") && len(v.Args) == 1 {
				if id, ok := v.Args[0].(*ast.Ident); ok {
					return id.Name
				}
			}
		case *ast.UnaryExpr: // &T{...}
			if cl, ok := v.X.(*ast.CompositeLit); ok {
				if id, ok := cl.Type.(*ast.Ident); ok {
					return id.Name
				}
			}
		}
	}
	return ""
}

// fieldsOf renders a struct's JSON-addressable fields.
func fieldsOf(st *ast.StructType) []Field {
	// Always non-nil: a settings type with no JSON fields is meaningful (strategyEmptyConfig
	// is exactly that), and emitting null would make every consumer special-case it.
	out := []Field{}
	for _, f := range st.Fields.List {
		if f.Tag == nil {
			continue
		}
		tag := reflect.StructTag(strings.Trim(f.Tag.Value, "`")).Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		typeName, ref, list := renderType(f.Type)
		doc := text(f.Doc)
		if doc == "" {
			doc = text(f.Comment)
		}
		out = append(out, Field{Name: name, Type: typeName, Doc: doc, Ref: ref, List: list})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// renderType turns an AST type into a display string, plus the named struct it refers
// to (if any) so the UI can descend.
func renderType(e ast.Expr) (display, ref string, list bool) {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name, t.Name, false
	case *ast.StarExpr:
		d, r, l := renderType(t.X)
		return "*" + d, r, l
	case *ast.ArrayType:
		d, r, _ := renderType(t.Elt)
		return "[]" + d, r, true
	case *ast.MapType:
		k, _, _ := renderType(t.Key)
		v, _, _ := renderType(t.Value)
		return "map[" + k + "]" + v, "", false
	case *ast.SelectorExpr:
		x, _, _ := renderType(t.X)
		return x + "." + t.Sel.Name, "", false
	case *ast.InterfaceType:
		return "any", "", false
	default:
		return "?", "", false
	}
}

// markReachable records a type and everything it embeds, so the output is the closure
// of what a settings payload can contain.
func markReachable(name string, structs map[string]*ast.StructType, seen map[string]bool) {
	if name == "" || seen[name] {
		return
	}
	st, ok := structs[name]
	if !ok {
		return
	}
	seen[name] = true
	for _, f := range fieldsOf(st) {
		if f.Ref != "" {
			markReachable(f.Ref, structs, seen)
		}
	}
}

// collectConsts indexes `const name = "value"` declarations.
func collectConsts(file *ast.File, out map[string]string) {
	for _, decl := range file.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.CONST {
			continue
		}
		for _, spec := range gd.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, name := range vs.Names {
				if i < len(vs.Values) {
					if v := strLit(vs.Values[i]); v != "" {
						out[name.Name] = v
					}
				}
			}
		}
	}
}

// literalOrConst resolves a map key that may be a string literal or a named constant.
func literalOrConst(e ast.Expr, consts map[string]string) string {
	if v := strLit(e); v != "" {
		return v
	}
	if id, ok := e.(*ast.Ident); ok {
		return consts[id.Name]
	}
	return ""
}

func isIdent(e ast.Expr, name string) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == name
}

func strLit(e ast.Expr) string {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.STRING {
		return ""
	}
	return strings.Trim(bl.Value, `"`)
}

func text(g *ast.CommentGroup) string {
	if g == nil {
		return ""
	}
	return strings.TrimSpace(g.Text())
}
