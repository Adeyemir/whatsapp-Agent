/** Keep WhatsApp replies readable without changing amounts, addresses, or links. */
const bullet = /^(?:[-•]|\d+[.)])\s+/;
const field = /^[A-Za-z][A-Za-z /()-]{1,35}:\s+\S/;
const sectionLabel = /^[A-Za-z][A-Za-z0-9 /&()-]{2,50}:?$/;
const sourceLine = /^(?:Source|Sources|View transaction|Transaction):/i;

function spaceLongProse(line: string): string {
  if (line.length < 420 || bullet.test(line) || field.test(line) || /https?:\/\//.test(line)) return line;
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(line)]
    .map((part) => part.segment.trim()).filter(Boolean);
  if (sentences.length < 3) return line;
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > 330) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current += `${current ? " " : ""}${sentence}`;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.join("\n\n");
}

/** Remove Markdown decoration and add predictable spacing to longer replies. */
export function plainWhatsAppText(message: string): string {
  const cleaned = message.replace(/\r\n?/g, "\n")
    .replace(/^\s*\*\s+/gm, "- ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,:;!?])/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```(?:[^\n]*)\n?/g, "")
    .split("\n").map((line) => line.trim()).join("\n");

  const input = cleaned.split("\n");
  const output: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const line = input[i];
    if (!line) {
      if (output.length && output.at(-1) !== "") output.push("");
      continue;
    }
    const previous = output.at(-1) ?? "";
    const next = input[i + 1] ?? "";
    const isSection = sectionLabel.test(line) && (line.endsWith(":") || bullet.test(next));
    const followsProse = previous && /[.!?]["”']?$/.test(previous) &&
      !bullet.test(previous) && !bullet.test(line) && !field.test(line) && !field.test(previous);
    if (previous && (isSection || sourceLine.test(line) || followsProse)) output.push("");
    output.push(...spaceLongProse(line).split("\n"));
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Prefer section boundaries when a long report needs several WhatsApp messages. */
export function splitWhatsAppReply(message: string, maxLength = 1400): string[] {
  const chunks: string[] = [];
  let remaining = message.trim();
  while (remaining.length > maxLength) {
    const paragraphCut = remaining.lastIndexOf("\n\n", maxLength);
    let cut = paragraphCut;
    let separatorLength = 2;
    if (paragraphCut < maxLength / 3) {
      cut = remaining.lastIndexOf("\n", maxLength);
      separatorLength = 1;
      if (cut < maxLength / 2) {
        cut = remaining.lastIndexOf(" ", maxLength);
      }
      if (cut < maxLength / 2) {
        cut = maxLength;
        separatorLength = 0;
      }
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut + separatorLength).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
