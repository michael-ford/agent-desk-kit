import { InlineKeyboard } from "grammy";

export function buildConfirmKeyboard(pendingKey: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Subscribe", `sub:c:${pendingKey}`)
    .text("Cancel", `sub:x:${pendingKey}`);
}
