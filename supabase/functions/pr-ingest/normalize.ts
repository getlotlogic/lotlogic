export function normalizePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
