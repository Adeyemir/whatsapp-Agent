/** Remove Markdown decoration that WhatsApp would display inconsistently. */
export function plainWhatsAppText(message: string): string {
  return message
    .replace(/^\s*\*\s+/gm, "- ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,:;!?])/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```(?:[^\n]*)\n?/g, "")
    .trim();
}
