import { DOC_LANGS, setDocLang, useDocLang } from '../lib/docLang'

/**
 * Documentation language, in the topbar.
 *
 * Labelled "docs" rather than left as a bare EN/RU pair, because a language control in
 * a topbar reads as "translate the interface" and this one does not do that: the
 * interface is English only. It selects which upstream documentation bundle the (?)
 * tooltips and the Reference tab quote from.
 *
 * A two-state segmented control rather than a dropdown — with two options a select
 * costs a click to discover what the options even are, and hides the current one until
 * it opens. Each label is written in its own language, which is how someone who cannot
 * read the rest of it recognises their way out.
 */
export function DocLangSwitch(): React.JSX.Element {
  const lang = useDocLang()
  return (
    <div className="doclang" title="Language of the parameter documentation. The interface itself is English only.">
      <span className="dim tiny">docs</span>
      <div className="seg">
        {DOC_LANGS.map((l) => (
          <button
            key={l.id}
            className={lang === l.id ? 'on' : ''}
            onClick={() => setDocLang(l.id)}
            title={`Documentation in ${l.full}`}
            aria-label={`Documentation in ${l.full}`}
            aria-pressed={lang === l.id}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  )
}
