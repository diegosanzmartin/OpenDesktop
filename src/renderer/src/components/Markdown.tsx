import clsx from 'clsx'
import { Fragment, useMemo, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'

/**
 * Renders the assistant's markdown.
 *
 * marked does the lexing, but its tokens are turned into React elements here
 * rather than into an HTML string: nothing is ever handed to innerHTML, so
 * model output cannot inject markup, and every element keeps the app's styling.
 */

marked.use({ gfm: true, breaks: true })

/** Marks where the text has got to, so a pause reads as thinking, not as done. */
function Caret(): ReactNode {
  return <span className="caret" aria-hidden />
}

function Inline({ tokens }: { tokens: Token[] | undefined }): ReactNode {
  if (!tokens) return null
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.type) {
          case 'strong':
            return (
              <strong key={index} className="text-ink-100 font-semibold">
                <Inline tokens={(token as Tokens.Strong).tokens} />
              </strong>
            )
          case 'em':
            return (
              <em key={index}>
                <Inline tokens={(token as Tokens.Em).tokens} />
              </em>
            )
          case 'codespan':
            return (
              <code key={index} className="code-chip">
                {(token as Tokens.Codespan).text}
              </code>
            )
          case 'del':
            return (
              <del key={index} className="text-ink-500">
                <Inline tokens={(token as Tokens.Del).tokens} />
              </del>
            )
          case 'link': {
            const link = token as Tokens.Link
            const external = /^https?:\/\//i.test(link.href)
            return (
              <a
                key={index}
                href={link.href}
                title={link.title ?? undefined}
                onClick={(event) => {
                  event.preventDefault()
                  // Anything outside the app opens in the real browser; the
                  // transcript is not a place to navigate away from.
                  if (external) void window.opendesktop.host.openExternal(link.href)
                }}
                className={clsx('underline underline-offset-2', external ? 'text-brand' : 'text-ink-300')}
              >
                <Inline tokens={link.tokens} />
              </a>
            )
          }
          case 'br':
            return <br key={index} />
          case 'escape':
            return <span key={index}>{(token as Tokens.Escape).text}</span>
          case 'html':
            // Shown as written rather than interpreted.
            return <span key={index}>{(token as Tokens.HTML).raw}</span>
          default:
            return <span key={index}>{(token as Tokens.Text).text ?? ''}</span>
        }
      })}
    </>
  )
}

function ListBlock({ token }: { token: Tokens.List }): ReactNode {
  const Tag = token.ordered ? 'ol' : 'ul'
  const tasks = token.items.some((item) => item.task)
  return (
    <Tag
      start={token.ordered && token.start !== 1 ? Number(token.start) : undefined}
      className={clsx(
        'my-2 space-y-1',
        // A task list draws its own checkboxes, so it needs no marker column.
        tasks ? 'list-none pl-0.5' : token.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'
      )}
    >
      {token.items.map((item, index) => (
        <li key={index} className="marker:text-ink-600 pl-0.5">
          {item.task ? (
            <input
              type="checkbox"
              checked={Boolean(item.checked)}
              readOnly
              className="accent-brand mr-1.5 align-middle"
            />
          ) : null}
          {/* marked keeps a `checkbox` token whose raw text is "[x] "; the box
              above already says that, so it is dropped rather than printed. */}
          <Blocks tokens={item.tokens.filter((child) => child.type !== 'checkbox')} tight />
        </li>
      ))}
    </Tag>
  )
}

function TableBlock({ token }: { token: Tokens.Table }): ReactNode {
  const align = (index: number): string =>
    token.align[index] === 'center'
      ? 'text-center'
      : token.align[index] === 'right'
        ? 'text-right'
        : 'text-left'

  return (
    // Wide tables scroll on their own rather than stretching the transcript.
    <div className="border-ink-800 my-3 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-ink-800 bg-ink-850 border-b">
            {token.header.map((cell, index) => (
              <th
                key={index}
                className={clsx('text-ink-200 px-3 py-1.5 font-medium', align(index))}
              >
                <Inline tokens={cell.tokens} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-ink-800 border-b last:border-b-0">
              {row.map((cell, index) => (
                <td key={index} className={clsx('text-ink-300 px-3 py-1.5 align-top', align(index))}>
                  <Inline tokens={cell.tokens} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Blocks that read naturally with a caret sitting inside them. */
const CARET_INLINE = new Set(['paragraph', 'heading', 'text'])

function Blocks({
  tokens,
  tight,
  caretAt
}: {
  tokens: Token[]
  tight?: boolean
  /** Index of the token the caret belongs to, or -1. */
  caretAt?: number
}): ReactNode {
  return (
    <>
      {tokens.map((token, index) => {
        const caret = index === caretAt
        const trailing = caret && !CARET_INLINE.has(token.type)
        switch (token.type) {
          case 'space':
            return null

          case 'heading': {
            const heading = token as Tokens.Heading
            const size =
              heading.depth <= 2 ? 'text-[16px]' : heading.depth === 3 ? 'text-[15px]' : 'text-[14px]'
            return (
              <div
                key={index}
                className={clsx('text-ink-100 mb-1.5 mt-4 font-semibold first:mt-0', size)}
              >
                <Inline tokens={heading.tokens} />
                {caret ? <Caret /> : null}
              </div>
            )
          }

          case 'paragraph':
            return (
              <p key={index} className={tight ? 'my-0' : 'my-2 first:mt-0 last:mb-0'}>
                <Inline tokens={(token as Tokens.Paragraph).tokens} />
                {caret ? <Caret /> : null}
              </p>
            )

          case 'text': {
            const text = token as Tokens.Text
            return (
              <span key={index}>
                {text.tokens ? <Inline tokens={text.tokens} /> : text.text}
                {caret ? <Caret /> : null}
              </span>
            )
          }

          case 'code': {
            const code = token as Tokens.Code
            return (
              <Fragment key={index}>
                <pre className="bg-ink-850 border-ink-800 text-ink-200 my-2.5 overflow-x-auto rounded-lg border px-3 py-2.5 font-mono text-[12px] leading-[1.6]">
                  {code.text}
                </pre>
                {trailing ? <Caret /> : null}
              </Fragment>
            )
          }

          case 'list':
            return (
              <Fragment key={index}>
                <ListBlock token={token as Tokens.List} />
                {trailing ? <Caret /> : null}
              </Fragment>
            )

          case 'table':
            return (
              <Fragment key={index}>
                <TableBlock token={token as Tokens.Table} />
                {trailing ? <Caret /> : null}
              </Fragment>
            )

          case 'blockquote':
            return (
              <blockquote
                key={index}
                className="border-ink-700 text-ink-400 my-2 border-l-2 pl-3"
              >
                <Blocks tokens={(token as Tokens.Blockquote).tokens} />
              </blockquote>
            )

          case 'hr':
            return <hr key={index} className="border-ink-800 my-4" />

          case 'html':
            return (
              <span key={index} className="whitespace-pre-wrap">
                {(token as Tokens.HTML).raw}
              </span>
            )

          default: {
            const raw = (token as { raw?: string }).raw
            return raw ? (
              <span key={index} className="whitespace-pre-wrap">
                {raw}
              </span>
            ) : null
          }
        }
      })}
    </>
  )
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }): ReactNode {
  const tokens = useMemo(() => {
    try {
      return marked.lexer(text)
    } catch {
      return null
    }
  }, [text])

  // A half-written table or fence mid-stream can trip the lexer; showing the
  // raw text is better than showing nothing until the turn settles.
  if (!tokens) {
    return (
      <div className="prose-body whitespace-pre-wrap">
        {text}
        {streaming ? <Caret /> : null}
      </div>
    )
  }

  // Placed by index rather than by CSS: an ::after on the last child lands
  // inside a table cell or a code block, which reads as a stray mark.
  let caretAt = -1
  if (streaming) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].type !== 'space') {
        caretAt = i
        break
      }
    }
  }

  return (
    <div className="prose-body">
      <Blocks tokens={tokens} caretAt={caretAt} />
    </div>
  )
}
