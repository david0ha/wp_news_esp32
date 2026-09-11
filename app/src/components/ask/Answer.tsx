import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, type } from '../../theme'
import { parseMarkdown, type Span } from '../../lib/ask/markdown'

/**
 * The desk's answer, drawn.
 *
 * The type ramp is the APP's — Inter and `theme.ts` — and not the edition's. A Korean answer sets
 * in whatever face the platform falls back to for Hangul, exactly as the rest of this app's chrome
 * does in Korean; `EditionTypeProvider` belongs to the paper and stops at the Today tab.
 */
export function Answer({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown)
  return (
    <View style={styles.root}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text key={i} style={block.level === 1 ? type.headingSm : styles.subheading}>
                {block.spans.map(renderSpan)}
              </Text>
            )
          case 'bullet':
            return (
              <View key={i} style={styles.list}>
                {block.items.map((item, j) => (
                  <View key={j} style={styles.item}>
                    <Text style={[type.body, styles.dot]}>•</Text>
                    <Text style={[type.body, styles.itemText]}>{item.map(renderSpan)}</Text>
                  </View>
                ))}
              </View>
            )
          case 'code':
            return (
              <View key={i} style={styles.codeBlock}>
                <Text style={styles.codeText}>{block.text}</Text>
              </View>
            )
          case 'para':
            return (
              <Text key={i} style={type.body}>
                {block.spans.map(renderSpan)}
              </Text>
            )
        }
      })}
    </View>
  )
}

// A `Text` inside a `Text` inherits the outer style and overrides the face, which is how RN nests
// runs. The weight is never set beside a `fontFamily` — `theme.ts`'s rule: Inter's weight is baked
// into the face, and a `fontWeight` next to it drops Android to the system font.
function renderSpan(span: Span, i: number) {
  if (span.code) {
    return (
      <Text key={i} style={styles.codeInline}>
        {span.text}
      </Text>
    )
  }
  if (span.bold) {
    return (
      <Text key={i} style={styles.bold}>
        {span.text}
      </Text>
    )
  }
  if (span.italic) {
    return (
      <Text key={i} style={styles.italic}>
        {span.text}
      </Text>
    )
  }
  return <Text key={i}>{span.text}</Text>
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  subheading: { ...type.headingSm, fontSize: 15, lineHeight: 20 },
  bold: { fontFamily: fonts.semibold },
  italic: { fontStyle: 'italic' },
  list: { gap: space.xs },
  item: { flexDirection: 'row', gap: space.sm },
  dot: { color: colors.textDim },
  itemText: { flex: 1 },
  codeBlock: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    padding: space.md,
  },
  codeText: { fontFamily: fonts.mono, fontSize: 13, color: colors.text },
  codeInline: { fontFamily: fonts.mono, fontSize: 13 },
})
