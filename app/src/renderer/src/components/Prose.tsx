import { Fragment } from 'react'

/**
 * Renders documentation prose, converting markdown inline code to real <code>.
 *
 * The extracted text keeps its backticks because stripping them at generation time
 * would lose the distinction between a value and ordinary words — "`true`" and "true"
 * are not the same claim. Converting here keeps the data faithful to the source and
 * the rendering readable.
 */
export function Prose({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const parts = text.split('`')
  return (
    <span className={className}>
      {parts.map((part, i) =>
        // Odd indices sit between a pair of backticks. An unmatched trailing backtick
        // leaves the final part as prose, which is the right way to fail.
        i % 2 === 1 && i < parts.length - 1 ? (
          <code key={i} className="inline-code">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </span>
  )
}
