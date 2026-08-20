import { setLang, useT, type Lang } from '../lib/i18n'

const LANGS: { id: Lang; label: string; full: string }[] = [
  { id: 'en', label: 'EN', full: 'English' },
  { id: 'ru', label: 'RU', full: 'Русский' },
]

/**
 * Language switch, in the topbar.
 *
 * A two-state segmented control rather than a dropdown: with two languages a select
 * costs a click to discover what the options even are, and the current one is not
 * visible until it opens.
 *
 * Each label is written in its own language — someone who has landed in the wrong one
 * needs to recognise their way out, and "Русский" is recognisable to a reader who
 * cannot read the rest of the interface.
 */
export function LangSwitch(): React.JSX.Element {
  const { t, lang } = useT()
  return (
    <div className="seg lang-switch" title={t('topbar.language')}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          className={lang === l.id ? 'on' : ''}
          onClick={() => setLang(l.id)}
          title={l.full}
          aria-label={l.full}
          aria-pressed={lang === l.id}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}
