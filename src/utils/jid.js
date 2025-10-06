export function toJid(input) {
  if (!input) throw new Error("empty recipient");
  if (/@/.test(input)) return input;
  const cleaned = String(input).replace(/\D/g, "");
  if (!cleaned) throw new Error("invalid number");
  return `${cleaned}@s.whatsapp.net`;
}
