import { Linking, Text, View } from "react-native";
import { colors } from "./ui";
type Props = { value: string; compact?: boolean };
function Inline({ value, compact }: Props) {
  const pieces = value.split(/(https?:\/\/[^\s)]+|`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <Text style={{ color: colors.text, lineHeight: compact ? 18 : 21, flexShrink: 1 }}>
      {pieces.map((piece, index) =>
        piece.startsWith("http") ? (
          <Text
            key={index}
            style={{ color: colors.blue }}
            onPress={() => void Linking.openURL(piece)}
          >
            {piece}
          </Text>
        ) : piece.startsWith("`") ? (
          <Text
            key={index}
            style={{ color: colors.accent, fontFamily: "monospace" }}
          >
            {piece.slice(1, -1)}
          </Text>
        ) : piece.startsWith("**") ? (
          <Text key={index} style={{ fontWeight: "700" }}>
            {piece.slice(2, -2)}
          </Text>
        ) : (
          <Text key={index}>{piece}</Text>
        ),
      )}
    </Text>
  );
}
export function Markdown({ value, compact = false }: Props) {
  const blocks: React.ReactNode[] = [];
  let code: string[] = [];
  let inCode = false;
  const flush = () => {
    if (!code.length) return;
    blocks.push(
      <View
        key={`code-${blocks.length}`}
        style={{
          backgroundColor: "#101212",
          borderColor: colors.line,
          borderWidth: 1,
          borderRadius: 8,
          padding: 10,
          marginVertical: 5,
        }}
      >
        <Text
          style={{
            color: colors.text,
            fontFamily: "monospace",
            fontSize: 12,
            lineHeight: 18,
            flexShrink: 1,
          }}
        >
          {code.join("\n")}
        </Text>
      </View>,
    );
    code = [];
  };
  value
    .replace(/\r/g, "")
    .split("\n")
    .forEach((line, index) => {
      if (line.trim().startsWith("```")) {
        if (inCode) flush();
        inCode = !inCode;
        return;
      }
      if (inCode) {
        code.push(line);
        return;
      }
      if (!line.trim()) {
        blocks.push(<View key={`space-${index}`} style={{ height: 5 }} />);
        return;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) {
        blocks.push(
          <Text
            key={index}
            style={{
              color: colors.text,
              fontWeight: "700",
              fontSize: heading[1].length === 1 ? 20 : 16,
              marginTop: 4,
            }}
          >
            <Inline value={heading[2]} compact={compact} />
          </Text>,
        );
        return;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.+)/);
      if (bullet) {
        blocks.push(
          <View key={index} style={{ flexDirection: "row", paddingLeft: 4 }}>
            <Text style={{ color: colors.accent, marginRight: 7 }}>•</Text>
            <View style={{ flex: 1 }}>
              <Inline value={bullet[1]} compact={compact} />
            </View>
          </View>,
        );
        return;
      }
      blocks.push(<Inline key={index} value={line} compact={compact} />);
    });
  if (inCode) flush();
  return <View style={{ gap: 2 }}>{blocks}</View>;
}
