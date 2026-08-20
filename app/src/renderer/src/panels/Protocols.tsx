import { useEffect, useMemo, useState } from 'react'
import type { ProtocolSchema, SchemaStruct } from '@shared/events'
import { Prose } from '../components/Prose'
import { lookup, useDocs } from '../lib/docs'
import { useT } from '../lib/i18n'

/**
 * The protocol `settings` surface, generated from the pinned Xray source.
 *
 * This is the part of a config the rest of the tool is blind to. The validator derives
 * its known keys by reflecting over conf.Config, which is exact and never drifts — but
 * `settings` is a json.RawMessage decoded later by a string-keyed registry, so
 * reflection stops there and every protocol-specific key is invisible.
 *
 * Descriptions come from the official docs where they exist and from the field's own
 * source comment otherwise, and each is labelled so the two are never confused: docs
 * are the authority, source comments are what the author happened to write.
 */
export function Protocols(): React.JSX.Element {
  const { t } = useT()
  const [schema, setSchema] = useState<ProtocolSchema | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [side, setSide] = useState<'outbound' | 'inbound'>('outbound')
  const [proto, setProto] = useState<string | null>(null)
  const docs = useDocs()

  useEffect(() => {
    void window.xraystudio.schema().then((s) => {
      setSchema(s)
      setLoaded(true)
    })
  }, [])

  const registry = useMemo(() => {
    if (!schema) return null
    return schema.registries[side === 'outbound' ? 'outboundConfigLoader' : 'inboundConfigLoader'] ?? null
  }, [schema, side])

  const protocols = useMemo(() => Object.keys(registry?.types ?? {}).sort(), [registry])
  const selected = proto && registry ? registry.types[proto] : undefined

  if (!loaded) return <div className="panel empty">{t('common.loading')}</div>
  if (!schema || !registry) {
    return (
      <div className="pad">
        <p className="dim">
          {t('protocols.schemaNotGenerated')}{' '}
          <code>go -C tools run ./schemagen -src ../.build/xray-core/infra/conf -out ../data/schema</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="whatif">
      <section className="card">
        <div className="card-head">
          <h3>{t('protocols.title')}</h3>
          <span className="tiny dim">
            {t('protocols.typesFromSource', { n: Object.keys(schema.types).length })}
          </span>
        </div>
        <p className="tiny dim">
          {t('protocols.whatGoesInside')} <code className="inline-code">settings</code> {t('protocols.perProtocol')} <code className="inline-code">infra/conf</code>,{' '}
          {t('protocols.registryNote', { proto: proto ?? 'vless' })}{' '}
          <code className="inline-code">{selected ?? 'VLessOutboundConfig'}</code>.
        </p>
        <div className="proto-bar">
          <div className="seg">
            {(['outbound', 'inbound'] as const).map((s) => (
              <button
                key={s}
                className={side === s ? 'on' : ''}
                onClick={() => {
                  setSide(s)
                  setProto(null)
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="proto-list">
            {protocols.map((p) => (
              <button
                key={p}
                className={`chip ${proto === p ? 'sel' : ''}`}
                onClick={() => setProto(proto === p ? null : p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </section>

      {!proto && (
        <section className="card">
          <p className="dim">{t('protocols.pick')}</p>
        </section>
      )}

      {proto && selected && (
        <TypeCard
          schema={schema}
          name={selected}
          path={`${side === 'outbound' ? 'outbounds' : 'inbounds'}[${proto}].settings`}
          docs={docs}
          depth={0}
          seen={new Set()}
        />
      )}
    </div>
  )
}

function TypeCard({
  schema,
  name,
  path,
  docs,
  depth,
  seen,
}: {
  schema: ProtocolSchema
  name: string
  path: string
  docs: ReturnType<typeof useDocs>
  depth: number
  seen: Set<string>
}): React.JSX.Element | null {
  const { t } = useT()
  const st: SchemaStruct | undefined = schema.types[name]
  if (!st) return null

  // Config types are recursive in places (a fallback can reference its own parent
  // shape); bail rather than expanding forever.
  if (seen.has(name) || depth > 2) {
    return (
      <section className="card">
        <div className="card-head">
          <code className="mono">{path}</code>
          <code className="tiny dim">{name}</code>
        </div>
        <p className="tiny dim">{t('protocols.alreadyShown')}</p>
      </section>
    )
  }
  const next = new Set(seen)
  next.add(name)

  // Only descend into refs that actually have JSON fields. Types like Address or
  // PortList are named scalars with their own UnmarshalJSON — rendering a card for them
  // would claim "takes no settings" about something that is not an object at all.
  const children = st.fields.filter((f) => f.ref && (schema.types[f.ref]?.fields.length ?? 0) > 0)

  return (
    <>
      <section className="card">
        <div className="card-head">
          {/* The protocol is part of the path because the same key name means different
              things per protocol — hysteria's `address` is not vless's. */}
          <code className="mono">{path}</code>
          <code className="tiny dim">{name}</code>
        </div>
        {st.doc && <p className="tiny dim">{st.doc}</p>}
        {st.fields.length === 0 && (
          <p className="tiny dim">
            {t('protocols.noSettings')}
          </p>
        )}
        {st.fields.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>key</th>
                <th>type</th>
                <th>description</th>
              </tr>
            </thead>
            <tbody>
              {st.fields.map((f) => {
                const doc = lookup(docs, `${path}.${f.name}`)
                return (
                  <tr key={f.name}>
                    <td className="mono">{f.name}</td>
                    <td className="mono dim">{f.type}</td>
                    <td>
                      {doc ? (
                        <>
                          <Prose text={doc.summary} />
                          <span className="tiny faint">
                          {' '}
                          · official docs{doc.translated ? '' : ' (EN)'}
                        </span>
                        </>
                      ) : f.doc ? (
                        <>
                          <span className="dim">{f.doc}</span>
                          <span className="tiny faint"> {t('protocols.sourceComment')}</span>
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {children.map((f) => (
        <TypeCard
          key={f.name}
          schema={schema}
          name={f.ref!}
          path={`${path}.${f.name}${f.list ? '[]' : ''}`}
          docs={docs}
          depth={depth + 1}
          seen={next}
        />
      ))}
    </>
  )
}
