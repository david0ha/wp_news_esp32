// Renders `src/lib/md.ts`'s `Block[]` through the redesign's type ramp (Task 15's `src/theme/`) —
// the desk's own markdown (a thesis note, a dossier, a `notes.md`) drawn on whichever material it
// lands on. `tone="paper"` for a sheet, `"chrome"` for the desk's own screens; every colour and
// every face comes from a theme token, never a literal, so a thesis note reads as this app's type
// rather than as whatever the markdown happened to ask for.
import { Fragment, type ReactNode } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import type { Block, Span } from '../lib/md'
import { openMdLink } from '../lib/links'
import { colors } from '../theme/colors'
import { spacing } from '../theme/spacing'
import { typography, type TypographyRole } from '../theme/typography'

export type MarkdownTone = 'paper' | 'chrome'

const TEXT: Record<MarkdownTone, string> = { paper: colors.ink, chrome: colors.deskText }
const MUTED: Record<MarkdownTone, string> = { paper: colors.inkMuted, chrome: colors.deskDim }
// h3 has no third heading size of its own (plan Design's ramp stops at two) — `label` is the
// smallest standing-head role, which is what a markdown h3 is standing in for here.
const HEADING_ROLE: Record<1 | 2 | 3, TypographyRole> = { 1: 'headline', 2: 'headlineSm', 3: 'label' }

/** A markdown document, already parsed by `parse()`, drawn on `tone`'s material. */
export function Markdown({ blocks, tone = 'paper' }: { blocks: Block[]; tone?: MarkdownTone }) {
  return (
    <View>
      {blocks.map((block, i) => (
        <Fragment key={i}>{renderBlock(block, tone)}</Fragment>
      ))}
    </View>
  )
}

function renderBlock(block: Block, tone: MarkdownTone): ReactNode {
  const color = TEXT[tone]
  switch (block.type) {
    case 'heading':
      return (
        <Text style={[typography[HEADING_ROLE[block.level]], { color }, styles.block]}>
          {renderSpans(block.spans, tone)}
        </Text>
      )
    case 'paragraph':
      return <Text style={[typography.body, { color }, styles.block]}>{renderSpans(block.spans, tone)}</Text>
    case 'quote':
      return (
        <View style={[styles.quote, { borderColor: MUTED[tone] }]}>
          <Text style={[typography.deck, { color: MUTED[tone] }]}>{renderSpans(block.spans, tone)}</Text>
        </View>
      )
    case 'list':
      return (
        <View style={styles.block}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={[typography.body, { color }]}>{block.ordered ? `${i + 1}.` : '•'}</Text>
              <Text style={[typography.body, { color }, styles.listText]}>{renderSpans(item, tone)}</Text>
            </View>
          ))}
        </View>
      )
    case 'code':
      return (
        <View style={[styles.codeBlock, { borderColor: MUTED[tone] }]}>
          <Text style={[typography.figure, { color }]}>{block.text}</Text>
        </View>
      )
    case 'hr':
      return <View style={[styles.hr, { backgroundColor: MUTED[tone] }]} />
  }
}

function renderSpans(spans: Span[], tone: MarkdownTone): ReactNode {
  return spans.map((span, i) => <Fragment key={i}>{renderSpan(span, tone)}</Fragment>)
}

function renderSpan(span: Span, tone: MarkdownTone): ReactNode {
  switch (span.type) {
    case 'text':
      return span.text
    case 'bold':
      return <Text style={styles.bold}>{renderSpans(span.spans, tone)}</Text>
    case 'italic':
      return <Text style={styles.italic}>{renderSpans(span.spans, tone)}</Text>
    case 'code':
      return (
        <Text style={[typography.figure, styles.inlineCode, { color: TEXT[tone], borderColor: MUTED[tone] }]}>
          {span.text}
        </Text>
      )
    case 'link':
      // On both tones — a dossier's own source links are as much the point as a thesis note's.
      // `openMdLink` swallows whatever `Linking.openURL` rejects with (src/lib/links.ts), so a
      // malformed or unsupported href reads as a tap that quietly did nothing rather than a crash.
      return (
        <Text
          accessibilityRole="link"
          style={[styles.link, { color: TEXT[tone] }]}
          onPress={() => {
            void openMdLink(span.href, Linking.openURL)
          }}
        >
          {span.text}
        </Text>
      )
  }
}

const styles = StyleSheet.create({
  block: { marginBottom: spacing[12] },
  quote: { borderLeftWidth: 2, paddingLeft: spacing[12], marginBottom: spacing[12] },
  listRow: { flexDirection: 'row', marginBottom: spacing[4] },
  listText: { flex: 1, marginLeft: spacing[8] },
  codeBlock: { borderWidth: StyleSheet.hairlineWidth, padding: spacing[8], marginBottom: spacing[12] },
  inlineCode: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing[4] },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: spacing[12] },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { textDecorationLine: 'underline' },
})
